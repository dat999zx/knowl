import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * One live host session on this machine, as Claude Code itself records it.
 *
 * Claude Code writes one JSON file per running session under `<config dir>/sessions/<pid>.json`
 * -- the same files its own `ListAgents` reads -- and removes it when the session exits. That
 * file is the whole reason this module can exist without a daemon: the host already maintains
 * the roster, validates it against the process table, and exports the directory to every hook
 * through `CLAUDE_CONFIG_DIR`. Reading it costs a directory listing, not a tool call.
 *
 * What the file does NOT carry is as important as what it does: there is no status and no
 * "current task". Those come from Knowl's own `session_focus` rows, joined on `sessionId`.
 */
export interface HostSessionRecord {
  pid: number;
  sessionId: string;
  cwd: string;
  name: string;
  startedAt: number;
  kind: string;
  /** Which config directory the record was read from -- sessions in different ones cannot message each other. */
  configDir: string;
  messagingSocketPath?: string;
  version?: string;
}

/**
 * Whether a process id names a running process.
 *
 * Signal 0 is the portable existence check: Node maps it to `OpenProcess` on Windows and to
 * `kill(pid, 0)` elsewhere. `EPERM` means the process exists but belongs to someone else, which
 * for a session registry under our own home directory is still "alive". Anything else --
 * `ESRCH` above all -- means the record outlived its process, which happens on every crash and
 * every force-closed terminal, and is exactly the case a roster must not report as a peer.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Every Claude Code config directory this user might be running sessions from.
 *
 * `CLAUDE_CONFIG_DIR` is the one the current session runs under and is always first. The
 * others exist because one person can run two accounts side by side (`~/.claude` and
 * `~/.claude-account-b` is a real layout), and sessions under different directories register
 * in different `sessions/` folders. Claude Code's own listing therefore cannot see across them
 * -- "two sessions can reach each other only when they can see the same files" -- but Knowl's
 * store is shared by both, so a roster built here can. Only directories that actually hold a
 * `sessions` folder count; a `.claude-launchers` or `.claude.json` sibling is not a config dir.
 */
export function claudeConfigDirs(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string[] {
  const dirs: string[] = [];
  const push = (dir: string | undefined) => {
    if (!dir) return;
    const resolved = path.resolve(dir);
    if (dirs.some(existing => sameDir(existing, resolved))) return;
    if (!isDirectory(path.join(resolved, 'sessions'))) return;
    dirs.push(resolved);
  };
  // An explicit list wins outright: a machine whose config dirs live somewhere the discovery
  // below would never look, or a test that must not see the developer's real fleet.
  if (env.KNOWL_CLAUDE_CONFIG_DIRS) {
    for (const dir of env.KNOWL_CLAUDE_CONFIG_DIRS.split(path.delimiter)) push(dir.trim());
    return dirs;
  }
  push(env.CLAUDE_CONFIG_DIR);
  push(path.join(home, '.claude'));
  for (const name of listDir(home).filter(name => name.startsWith('.claude') && name !== '.claude').sort()) {
    push(path.join(home, name));
  }
  return dirs;
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * The live sessions registered under the given config directories, dead records dropped.
 *
 * Parsing is deliberately forgiving of shape and strict about liveness. A record missing a
 * field is skipped rather than thrown on -- Claude Code owns that file format and may add or
 * rename keys -- but a record whose pid is gone is never returned, because a dead session
 * reported as a peer would be told about, waited on and messaged, and none of that can succeed.
 * The caller's own session is included; filtering it out is the caller's decision, since the
 * MCP tool and the SessionStart card want opposite things.
 */
export function readHostSessionRegistry(
  configDirs: string[] = claudeConfigDirs(),
  alive: (pid: number) => boolean = isPidAlive,
): HostSessionRecord[] {
  const records: HostSessionRecord[] = [];
  for (const configDir of configDirs) {
    const dir = path.join(configDir, 'sessions');
    for (const name of listDir(dir).filter(name => name.endsWith('.json'))) {
      const record = parseRecord(readJson(path.join(dir, name)), configDir);
      if (!record) continue;
      if (!alive(record.pid)) continue;
      records.push(record);
    }
  }
  records.sort((a, b) => a.startedAt - b.startedAt);
  return records;
}

function parseRecord(raw: unknown, configDir: string): HostSessionRecord | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const pid = typeof value.pid === 'number' ? value.pid : Number(value.pid);
  const sessionId = typeof value.sessionId === 'string' ? value.sessionId : undefined;
  const cwd = typeof value.cwd === 'string' ? value.cwd : undefined;
  if (!Number.isInteger(pid) || pid <= 0 || !sessionId || !cwd) return undefined;
  const startedAt = typeof value.startedAt === 'number' ? value.startedAt : Number(value.startedAt);
  return {
    pid,
    sessionId,
    cwd,
    // A record without a name is still a session; the derived form is what the host would show.
    name: typeof value.name === 'string' && value.name.length > 0 ? value.name : `${path.basename(cwd).toLowerCase()}-${sessionId.slice(0, 2)}`,
    startedAt: Number.isFinite(startedAt) ? startedAt : 0,
    kind: typeof value.kind === 'string' ? value.kind : 'interactive',
    configDir,
    messagingSocketPath: typeof value.messagingSocketPath === 'string' ? value.messagingSocketPath : undefined,
    version: typeof value.version === 'string' ? value.version : undefined,
  };
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Case-insensitive on Windows, where `C:\Code` and `c:\Code` are one directory and the two
 * spellings both occur in real hook payloads (`cwd` arrives lowercase-drive from VS Code).
 */
export function sameDir(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Whether `child` is `parent` or lies inside it. `path.relative` already compares
 * case-insensitively on win32, so the casing rule of `sameDir` holds here without a second
 * check.
 */
export function withinDir(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (relative === '') return true;
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}
