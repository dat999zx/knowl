import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type CopilotExtractedProse = {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string | null;
};

export type CopilotTranscriptFile = {
  path: string;
  sessionId: string;
  parentSessionId: null;
  harness: 'copilot';
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CASE_INSENSITIVE_PATHS = process.platform === 'win32' || process.platform === 'darwin';
const foldPath = (target: string) =>
  CASE_INSENSITIVE_PATHS ? path.resolve(target).toLowerCase() : path.resolve(target);

/** `cwd: <path>` in `~/.copilot/session-state/<uuid>/workspace.yaml`. */
const COPILOT_YAML_CWD = /^cwd:[ \t]*(.+)$/m;
const META_PREFIX_BYTES = 8192;
const MAX_META_BYTES = 2 * 1024 * 1024;
/** Concurrency cap when probing per-session directories in `~/.copilot/session-state/`. */
const COPILOT_SCAN_BATCH = 64;

/**
 * GitHub Copilot CLI's session archive: `~/.copilot/session-state/<session-uuid>/events.jsonl`.
 *
 * Each UUID directory holds `workspace.yaml` (carrying `cwd` even for `agency`-spawned sessions
 * where `session.start` omits `data.context.cwd`) and `events.jsonl` (whose first line is
 * `session.start` with `data.context.cwd`, including when the session ran in a worktree while
 * `workspace.yaml` named the main checkout).
 */
export function defaultCopilotSessionsDir(): string {
  return path.join(os.homedir(), '.copilot', 'session-state');
}

async function readDir(dir: string): Promise<import('node:fs').Dirent[] | null> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? [] : null;
  }
}

async function isDirectoryLike(full: string, entry: import('node:fs').Dirent): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  return fs.stat(full).then(stat => stat.isDirectory(), () => false);
}

async function copilotWorkspaceCwd(yamlPath: string): Promise<{ cwd: string | null; degraded: boolean }> {
  try {
    const raw = await fs.readFile(yamlPath, 'utf8');
    const matched = COPILOT_YAML_CWD.exec(raw);
    if (!matched) return { cwd: null, degraded: false };
    let cwd = matched[1].trim();
    if (cwd.startsWith("'") && cwd.endsWith("'")) {
      cwd = cwd.slice(1, -1).replace(/''/g, "'").trim();
    } else if (cwd.startsWith('"') && cwd.endsWith('"')) {
      try {
        const parsed = JSON.parse(cwd) as unknown;
        if (typeof parsed === 'string') cwd = parsed.trim();
      } catch {
        cwd = cwd.slice(1, -1).trim();
      }
    } else {
      const comment = /[ \t]+#/.exec(cwd);
      if (comment) cwd = cwd.slice(0, comment.index).trim();
    }
    return { cwd: cwd || null, degraded: false };
  } catch (error) {
    return {
      cwd: null,
      degraded: (error as NodeJS.ErrnoException)?.code !== 'ENOENT',
    };
  }
}

async function copilotStartCwd(filePath: string): Promise<{ cwd: string | null; degraded: boolean }> {
  let handle: import('node:fs/promises').FileHandle | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(META_PREFIX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, META_PREFIX_BYTES, 0);
    // Copied rather than aliased: `buffer` is reused by the fallback reads below.
    const head = Buffer.from(buffer.subarray(0, bytesRead));
    const chunks: Buffer[] = [head];
    let tail = head;
    let offset = bytesRead;
    while (tail.indexOf(0x0a) === -1 && offset < MAX_META_BYTES) {
      const next = await handle.read(buffer, 0, META_PREFIX_BYTES, offset);
      if (next.bytesRead === 0) break;
      tail = Buffer.from(buffer.subarray(0, next.bytesRead));
      chunks.push(tail);
      offset += next.bytesRead;
    }

    const whole = chunks.length === 1 ? head : Buffer.concat(chunks);
    const newline = whole.indexOf(0x0a);
    try {
      const record = JSON.parse(
        (newline === -1 ? whole : whole.subarray(0, newline)).toString('utf8'),
      ) as Record<string, unknown>;
      const data = record.data as Record<string, unknown> | undefined;
      const context = data?.context as Record<string, unknown> | undefined;
      const cwd = context?.cwd;
      return { cwd: typeof cwd === 'string' && cwd ? cwd : null, degraded: false };
    } catch {
      return { cwd: null, degraded: false };
    }
  } catch (error) {
    return {
      cwd: null,
      degraded: (error as NodeJS.ErrnoException)?.code !== 'ENOENT',
    };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * This repo's GitHub Copilot CLI sessions (`~/.copilot/session-state/<uuid>/events.jsonl`).
 *
 * Both `workspace.yaml` and the `session.start` line of `events.jsonl` are consulted when needed:
 * `agency`-spawned sessions omit `data.context.cwd` in `session.start` and record `cwd` only in
 * `workspace.yaml` (111 of 2,146 sessions in a real archive), while worktree sessions can record
 * the main checkout in `workspace.yaml` and the worktree path in `session.start`.
 */
export async function scanCopilotArchive(
  sessionsDir: string,
  roots: string[],
  uncanonicalise: (target: string) => string | null,
): Promise<{ files: CopilotTranscriptFile[]; degraded: boolean }> {
  const entries = await readDir(sessionsDir);
  if (entries === null) return { files: [], degraded: true };

  const wanted = new Set<string>();
  for (const root of roots) {
    const resolved = path.resolve(root);
    const forms = [resolved, await fs.realpath(resolved).catch(() => null), uncanonicalise(resolved)];
    for (const form of forms) {
      if (form) wanted.add(foldPath(form));
    }
  }

  const candidates = entries.filter(entry => UUID.test(entry.name));
  const files: CopilotTranscriptFile[] = [];
  let degraded = false;

  for (let start = 0; start < candidates.length; start += COPILOT_SCAN_BATCH) {
    const batch = candidates.slice(start, start + COPILOT_SCAN_BATCH);
    const matchedBatch = await Promise.all(batch.map(async (entry): Promise<CopilotTranscriptFile | null> => {
      const sessionDir = path.join(sessionsDir, entry.name);
      if (!(await isDirectoryLike(sessionDir, entry))) return null;

      const eventsPath = path.join(sessionDir, 'events.jsonl');
      let stat: import('node:fs').Stats;
      try {
        stat = await fs.stat(eventsPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') degraded = true;
        return null;
      }
      if (!stat.isFile()) return null;

      const yaml = await copilotWorkspaceCwd(path.join(sessionDir, 'workspace.yaml'));
      if (yaml.degraded) degraded = true;
      let matched = Boolean(yaml.cwd && wanted.has(foldPath(yaml.cwd)));
      if (!matched) {
        const startRec = await copilotStartCwd(eventsPath);
        if (startRec.degraded) degraded = true;
        matched = Boolean(startRec.cwd && wanted.has(foldPath(startRec.cwd)));
      }
      if (!matched) return null;

      return {
        path: eventsPath,
        sessionId: entry.name,
        parentSessionId: null,
        harness: 'copilot',
      };
    }));

    for (const file of matchedBatch) {
      if (file) files.push(file);
    }
  }

  return { files, degraded };
}

/**
 * The prose in one GitHub Copilot CLI `user.message` or `assistant.message` event, or null.
 *
 * `data.content` is read rather than `data.transformedContent` (which wraps user messages in
 * injected `<current_datetime>` context) and `data.reasoningText`/`data.reasoningOpaque` are
 * ignored for the same reason Claude's `thinking` blocks and Codex's `reasoning` items are.
 *
 * Subagent turns inside the parent `events.jsonl` carry `agentId` on the record or
 * `parentAgentTaskId` inside `data`; they are skipped so the parent session's prose stays the
 * top-level conversation and does not credit delegated task prompts as the user's opening ask.
 */
export function extractCopilotProse(record: Record<string, unknown>): CopilotExtractedProse | null {
  if (typeof record.agentId === 'string' && record.agentId) return null;

  const data = record.data;
  if (!data || typeof data !== 'object') return null;
  const typed = data as Record<string, unknown>;
  if (typeof typed.parentAgentTaskId === 'string' && typed.parentAgentTaskId) return null;

  const content = typed.content;
  if (typeof content !== 'string') return null;
  const text = content.trim();
  if (!text) return null;

  const role = record.type === 'user.message' ? 'user' : 'assistant';
  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : null;
  return { role, text, timestamp };
}
