import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient, type Client } from '@libsql/client';

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

export type CopilotSessionMap = {
  /** Keyed by folded normalized project root path (`foldPath(root)`). */
  byRoot: Map<string, CopilotTranscriptFile[]>;
  /** Sessions whose normalized `cwd` did not match any known repository root. */
  unmapped: (CopilotTranscriptFile & { cwd: string | null })[];
  degraded: boolean;
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
 * Normalize a historical or active GitHub Copilot worktree `cwd` back to its parent repository
 * checkout so sessions from pruned worktrees still map to their repository.
 */
export function normalizeCopilotRepoCwd(rawCwd: string): string {
  const resolved = path.resolve(rawCwd);
  const posix = resolved.replaceAll('\\', '/');

  const dotWorktrees = /^(.+?)\.worktrees(?:\/|$)/i.exec(posix);
  if (dotWorktrees) return path.resolve(dotWorktrees[1]);

  const nestedWorktrees = /^(.+?)\/worktrees\/([^/]+)(?:\/|$)/i.exec(posix);
  if (nestedWorktrees) {
    const parent = nestedWorktrees[1];
    const leaf = nestedWorktrees[2];
    if (/(?:^|\/)worktrees$/i.test(parent)) return path.resolve(parent);
    const siblingMatch = /^([A-Za-z0-9._-]+?)-(?:Task\d+|wi-?\d+|\d{5,})(?:[-_].*)?$/i.exec(leaf);
    if (siblingMatch && /^(?:.*\/)?(?:repos|learn|git|code|projects|src)$/i.test(parent)) {
      return path.resolve(`${parent}/${siblingMatch[1]}`);
    }
    return path.resolve(parent);
  }

  const inlineTaskSuffix = /^(.+?)-(?:Task\d{4,}|wi-\d{4,})(?:[-_][^/]*)?(?:\/.*)?$/i.exec(posix);
  if (inlineTaskSuffix) return path.resolve(inlineTaskSuffix[1]);

  return resolved;
}

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

export function defaultCopilotSessionStoreDb(): string {
  return path.join(os.homedir(), '.copilot', 'session-store.db');
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

function matchesWantedRoot(rawCwd: string | null, wanted: Set<string>): boolean {
  if (!rawCwd) return false;
  const resolved = path.resolve(rawCwd);
  if (wanted.has(foldPath(resolved))) return true;
  const normalized = normalizeCopilotRepoCwd(resolved);
  // A heuristic worktree normalization only applies when the session's raw CWD is not itself one of
  // the caller's target roots, and the normalized parent root is in `wanted`.
  return normalized !== resolved && wanted.has(foldPath(normalized));
}

type ScannedCopilotSession = {
  file: CopilotTranscriptFile;
  yamlCwd: string | null;
  startCwd: string | null;
  degraded: boolean;
};

async function scanCopilotSessionEntries(
  sessionsDir: string,
  options: { onlySessionIds?: Set<string>; sinceMs?: number } = {},
): Promise<{ sessions: ScannedCopilotSession[]; degraded: boolean }> {
  const entries = await readDir(sessionsDir);
  if (entries === null) return { sessions: [], degraded: true };

  const candidates = entries.filter(
    entry => UUID.test(entry.name) && (!options.onlySessionIds || options.onlySessionIds.has(entry.name)),
  );
  const sessions: ScannedCopilotSession[] = [];
  let degraded = false;

  for (let start = 0; start < candidates.length; start += COPILOT_SCAN_BATCH) {
    const batch = candidates.slice(start, start + COPILOT_SCAN_BATCH);
    const scannedBatch = await Promise.all(batch.map(async (entry): Promise<ScannedCopilotSession | null> => {
      const sessionDir = path.join(sessionsDir, entry.name);
      if (!(await isDirectoryLike(sessionDir, entry))) return null;

      const eventsPath = path.join(sessionDir, 'events.jsonl');
      let stat: import('node:fs').Stats;
      try {
        stat = await fs.stat(eventsPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          return {
            file: { path: eventsPath, sessionId: entry.name, parentSessionId: null, harness: 'copilot' },
            yamlCwd: null,
            startCwd: null,
            degraded: true,
          };
        }
        return null;
      }
      if (!stat.isFile()) return null;
      if (options.sinceMs !== undefined && stat.mtimeMs < options.sinceMs) return null;

      const yaml = await copilotWorkspaceCwd(path.join(sessionDir, 'workspace.yaml'));
      const startRec = await copilotStartCwd(eventsPath);
      return {
        file: {
          path: eventsPath,
          sessionId: entry.name,
          parentSessionId: null,
          harness: 'copilot',
        },
        yamlCwd: yaml.cwd,
        startCwd: startRec.cwd,
        degraded: yaml.degraded || startRec.degraded,
      };
    }));

    for (const item of scannedBatch) {
      if (!item) continue;
      if (item.degraded) degraded = true;
      if (item.yamlCwd !== null || item.startCwd !== null || !item.degraded) {
        sessions.push(item);
      }
    }
  }

  return { sessions, degraded };
}

/**
 * Pre-build a repo-to-sessions lookup map in a single pass over `~/.copilot/session-state` so
 * multi-repo backfills and scoped reindexing only touch the sessions belonging to each repo.
 */
export async function buildCopilotRepoSessionMap(
  sessionsDir: string,
  repoRoots: string[],
  options: { sinceMs?: number } = {},
): Promise<CopilotSessionMap> {
  const byRoot = new Map<string, CopilotTranscriptFile[]>();
  const canonicalByFolded = new Map<string, string>();

  for (const root of repoRoots) {
    const folded = foldPath(root);
    byRoot.set(folded, []);
    canonicalByFolded.set(folded, folded);
    const real = await fs.realpath(path.resolve(root)).catch(() => null);
    if (real) canonicalByFolded.set(foldPath(real), folded);
  }

  const { sessions, degraded } = await scanCopilotSessionEntries(sessionsDir, { sinceMs: options.sinceMs });
  const unmapped: (CopilotTranscriptFile & { cwd: string | null })[] = [];

  for (const item of sessions) {
    let matchedOwner: string | null = null;
    for (const candidateCwd of [item.yamlCwd, item.startCwd]) {
      if (!candidateCwd) continue;
      const exactOwner = canonicalByFolded.get(foldPath(candidateCwd));
      if (exactOwner) {
        matchedOwner = exactOwner;
        break;
      }
      const normOwner = canonicalByFolded.get(foldPath(normalizeCopilotRepoCwd(candidateCwd)));
      if (normOwner) {
        matchedOwner = normOwner;
        break;
      }
    }

    if (matchedOwner) {
      byRoot.get(matchedOwner)?.push(item.file);
    } else {
      unmapped.push({ ...item.file, cwd: item.yamlCwd ?? item.startCwd ?? null });
    }
  }

  return { byRoot, unmapped, degraded };
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
  options: { onlySessionIds?: Set<string> } = {},
): Promise<{ files: CopilotTranscriptFile[]; degraded: boolean }> {
  const wanted = new Set<string>();
  for (const root of roots) {
    const resolved = path.resolve(root);
    const forms = [resolved, await fs.realpath(resolved).catch(() => null), uncanonicalise(resolved)];
    for (const form of forms) {
      if (form) wanted.add(foldPath(form));
    }
  }

  const { sessions, degraded } = await scanCopilotSessionEntries(sessionsDir, {
    onlySessionIds: options.onlySessionIds,
  });
  const files: CopilotTranscriptFile[] = [];

  for (const item of sessions) {
    if (matchesWantedRoot(item.yamlCwd, wanted) || matchesWantedRoot(item.startCwd, wanted)) {
      files.push(item.file);
    }
  }

  return { files, degraded };
}

/**
 * Read pre-distilled checkpoint summaries (`checkpoints/*.json` in the session directory or the
 * `checkpoints` table in `~/.copilot/session-store.db`) for a Copilot session.
 */
export async function readCopilotCheckpointsText(
  sessionId: string,
  eventsFilePath?: string,
  sessionStoreDbPath: string = defaultCopilotSessionStoreDb(),
): Promise<string> {
  const sections: string[] = [];

  if (eventsFilePath) {
    const sessionDir = path.dirname(eventsFilePath);
    const ckptDir = path.join(sessionDir, 'checkpoints');
    const files = await readDir(ckptDir);
    if (files && files.length > 0) {
      const jsonFiles = files
        .filter(f => f.isFile() && f.name.endsWith('.json'))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      for (const file of jsonFiles) {
        try {
          const parsed = JSON.parse(await fs.readFile(path.join(ckptDir, file.name), 'utf8')) as Record<string, unknown>;
          const block = formatCheckpointRecord(parsed);
          if (block) sections.push(block);
        } catch {
          // Ignore malformed checkpoint file
        }
      }
    }
    const indexMd = path.join(sessionDir, 'index.md');
    try {
      const summaryMd = (await fs.readFile(indexMd, 'utf8')).trim();
      if (summaryMd) sections.push(`## Session Summary\n${summaryMd}`);
    } catch {
      // Optional index.md
    }
  }

  if (sections.length === 0 && await fs.access(sessionStoreDbPath).then(() => true, () => false)) {
    let client: Client | null = null;
    try {
      client = createClient({ url: pathToFileURL(path.resolve(sessionStoreDbPath)).href });
      await client.execute('PRAGMA query_only = ON;'); // Copilot's own database: read it, never write it.
      const rows = (await client.execute({
        sql: `SELECT checkpoint_number, title, overview, work_done, technical_details
              FROM checkpoints
              WHERE session_id = ?
              ORDER BY checkpoint_number ASC`,
        args: [sessionId],
      })).rows;
      for (const row of rows) {
        const block = formatCheckpointRecord(row as Record<string, unknown>);
        if (block) sections.push(block);
      }
    } catch {
      // Optional session-store.db fallback
    } finally {
      try { client?.close(); } catch { /* ignore */ }
    }
  }

  return sections.join('\n\n');
}

function formatCheckpointRecord(record: Record<string, unknown>): string | null {
  const num = record.checkpoint_number ?? record.checkpointNumber;
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const overview = typeof record.overview === 'string' ? record.overview.trim() : '';
  const workDone = typeof record.work_done === 'string'
    ? record.work_done.trim()
    : (typeof record.workDone === 'string' ? record.workDone.trim() : '');
  const tech = typeof record.technical_details === 'string'
    ? record.technical_details.trim()
    : (typeof record.technicalDetails === 'string' ? record.technicalDetails.trim() : '');
  const body = [
    overview ? `Overview: ${overview}` : '',
    workDone ? `Work Done: ${workDone}` : '',
    tech ? `Technical Details: ${tech}` : '',
  ].filter(Boolean).join('\n');
  if (!body) return null;
  const heading = num !== undefined && num !== null ? `## Checkpoint ${num}: ${title}` : `## Checkpoint: ${title}`;
  return `${heading}\n${body}`;
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
