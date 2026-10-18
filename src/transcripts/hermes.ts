import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient, type Client } from '@libsql/client';
import { normalizeCopilotRepoCwd } from './copilot.js';
import { NAME_KIND, type ProseChunk, type ProseMessage, type ProseWatermark, type SessionNaming } from './parse.js';
import type { MessagePointer, TranscriptExcerpt } from './read.js';

export type HermesTranscriptFile = {
  path: string;
  sessionId: string;
  parentSessionId: string | null;
  harness: 'hermes';
};

export type HermesSessionMap = {
  /** Keyed by folded normalized project root path (`foldPath(root)`). */
  byRoot: Map<string, (HermesTranscriptFile & { profile: string; dbPath: string })[]>;
  /** Sessions whose normalized `cwd` did not match any known repository root. */
  unmapped: (HermesTranscriptFile & { cwd: string | null; profile: string; dbPath: string })[];
  degraded: boolean;
};

export type HermesVirtualFileMeta = {
  size: number;
  anchor: string;
};

const CASE_INSENSITIVE_PATHS = process.platform === 'win32' || process.platform === 'darwin';
const foldPath = (target: string) =>
  CASE_INSENSITIVE_PATHS ? path.resolve(target).toLowerCase() : path.resolve(target);

const HERMES_PROMPT_CWD = /Current working directory:[ \t]*([^\r\n]+)/i;
const HERMES_PROMPT_ROOT = /^[ \t]*-[ \t]*Root:[ \t]*([^\r\n]+)/im;
const HERMES_SKILL_INVOCATION_PREFIX = 'The user has provided the following instruction alongside the skill invocation:';

const VIRTUAL_SESSION_SEPARATOR = '#session=';
const SQLITE_IN_BATCH = 400;

export function canonicalHermesBaseHome(rawHome: string): string {
  const resolved = path.resolve(rawHome);
  const parentDir = path.dirname(resolved);
  if (path.basename(parentDir).toLowerCase() === 'profiles') {
    return path.dirname(parentDir);
  }
  return resolved;
}

/**
 * Where Hermes keeps its home directory (`HERMES_HOME`, `%LOCALAPPDATA%\\hermes` on Windows, or
 * `~/.hermes` on POSIX/macOS). If `HERMES_HOME` points inside `<base>/profiles/<name>`, resolves
 * to `<base>` so all profiles and the default root are discovered together.
 */
export function defaultHermesHomeDir(): string {
  const envHome = process.env.HERMES_HOME?.trim();
  if (envHome) return canonicalHermesBaseHome(envHome);
  const home = os.homedir();
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA?.trim() || path.join(home, 'AppData', 'Local');
    return path.join(localAppData, 'hermes');
  }
  return path.join(home, '.hermes');
}

/**
 * Format a virtual path representing one session inside a Hermes `state.db` SQLite store:
 * `<resolved-state.db-path>#session=<sessionId>`.
 */
export function formatHermesSessionPath(dbPath: string, sessionId: string): string {
  return `${path.resolve(dbPath)}${VIRTUAL_SESSION_SEPARATOR}${sessionId}`;
}

export function parseHermesSessionPath(filePath: string): { dbPath: string; sessionId: string } | null {
  if (typeof filePath !== 'string') return null;
  const idx = filePath.lastIndexOf(VIRTUAL_SESSION_SEPARATOR);
  if (idx <= 0) return null;
  const dbPath = filePath.slice(0, idx);
  const sessionId = filePath.slice(idx + VIRTUAL_SESSION_SEPARATOR.length).trim();
  if (!dbPath || !sessionId || !dbPath.toLowerCase().endsWith('.db')) return null;
  return { dbPath, sessionId };
}

export function isHermesSessionPath(filePath: string): boolean {
  return parseHermesSessionPath(filePath) !== null;
}

async function fileExists(target: string): Promise<boolean> {
  return fs.stat(target).then(stat => stat.isFile(), () => false);
}

async function withHermesDb<T>(dbPath: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = createClient({ url: pathToFileURL(path.resolve(dbPath)).href });
  try {
    await client.execute('PRAGMA busy_timeout = 5000;');
    await client.execute('PRAGMA query_only = ON;');
    return await fn(client);
  } finally {
    try { client.close(); } catch { /* ignore */ }
  }
}

/**
 * Discover all active Hermes `state.db` files under `hermesHomeDir`:
 * `<hermesHomeDir>/state.db` (default profile) plus `<hermesHomeDir>/profiles/<name>/state.db`
 * (skipping hidden directories and `.backup` snapshots).
 */
export async function defaultHermesStateDbs(hermesHomeDir: string = defaultHermesHomeDir()): Promise<string[]> {
  const roots = [canonicalHermesBaseHome(hermesHomeDir)];
  if (foldPath(path.resolve(hermesHomeDir)) !== foldPath(roots[0])) {
    roots.push(path.resolve(hermesHomeDir));
  }
  if (process.platform === 'win32' && !process.env.HERMES_HOME) {
    const dotHermes = path.join(os.homedir(), '.hermes');
    if (foldPath(dotHermes) !== foldPath(roots[0])) {
      roots.push(path.resolve(dotHermes));
    }
  }

  const found: string[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    const rootDb = path.join(root, 'state.db');
    if (await fileExists(rootDb)) {
      const folded = foldPath(rootDb);
      if (!seen.has(folded)) {
        seen.add(folded);
        found.push(path.resolve(rootDb));
      }
    }

    const profilesDir = path.join(root, 'profiles');
    try {
      const entries = await fs.readdir(profilesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name.includes('.backup')) continue;
        const profileDir = path.join(profilesDir, entry.name);
        const isDir = entry.isDirectory()
          || (entry.isSymbolicLink() && await fs.stat(profileDir).then(s => s.isDirectory(), () => false));
        if (!isDir) continue;
        const dbPath = path.join(profileDir, 'state.db');
        if (await fileExists(dbPath)) {
          const folded = foldPath(dbPath);
          if (!seen.has(folded)) {
            seen.add(folded);
            found.push(path.resolve(dbPath));
          }
        }
      }
    } catch {
      // No profiles directory or unreadable
    }
  }

  return found;
}

function profileNameFromDbPath(dbPath: string): string {
  const parent = path.basename(path.dirname(dbPath));
  const grandParent = path.basename(path.dirname(path.dirname(dbPath)));
  return grandParent.toLowerCase() === 'profiles' ? parent : 'default';
}

function extractPromptCwdAndRoot(promptText: string | null | undefined): {
  promptCwd: string | null;
  promptRoot: string | null;
} {
  if (!promptText) return { promptCwd: null, promptRoot: null };
  const cwdMatch = HERMES_PROMPT_CWD.exec(promptText);
  const rootMatch = HERMES_PROMPT_ROOT.exec(promptText);
  return {
    promptCwd: cwdMatch?.[1]?.trim() || null,
    promptRoot: rootMatch?.[1]?.trim() || null,
  };
}

function toEpochMs(raw: unknown): number {
  const num = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return num > 1e11 ? num : num * 1000;
}

function toIsoTimestamp(raw: unknown): string | null {
  const ms = toEpochMs(raw);
  if (ms > 0) return new Date(ms).toISOString();
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return null;
}

/**
 * Clean Hermes system/hook/skill-invocation wrappers from a user or assistant message so only
 * real conversational prose is indexed and distilled.
 */
export function cleanHermesMessageContent(
  role: 'user' | 'assistant',
  rawContent: string,
): string | null {
  let text = rawContent.trim();
  if (!text) return null;

  if (role === 'user') {
    // Strip leading runtime model-switch banner `[System: The active model for this chat...]`
    text = text.replace(/^\[System:[^\]]*\]\s*/i, '').trim();

    // Unwrap `[IMPORTANT: The user has invoked the "<skill>" skill...]` preamble
    const skillIdx = text.indexOf(HERMES_SKILL_INVOCATION_PREFIX);
    if (skillIdx !== -1) {
      text = text.slice(skillIdx + HERMES_SKILL_INVOCATION_PREFIX.length).trim();
    } else if (/^\[IMPORTANT:\s*The user has invoked the\s+"[^"]+"\s+skill/i.test(text)) {
      return null;
    }

    // Skip synthetic background-process notifications and compaction handoff prompts
    if (
      text.startsWith('[IMPORTANT: Background process ')
      || text.startsWith('[CONTEXT COMPACTION — REFERENCE ONLY]')
      || text.startsWith('[PRIOR CONTEXT — for reference only')
      || text.startsWith('[ASYNC DELEGATION BATCH COMPLETE')
    ) {
      return null;
    }

    // Strip trailing auto-recalled `# Agent Context:` blocks and `PONYTAIL MODE ACTIVE` blocks
    const agentContextIdx = text.indexOf('\n# Agent Context:');
    if (agentContextIdx !== -1) {
      text = text.slice(0, agentContextIdx).trim();
    } else if (text.startsWith('# Agent Context:')) {
      return null;
    }

    const ponytailIdx = text.indexOf('\nPONYTAIL MODE ACTIVE');
    if (ponytailIdx !== -1) {
      text = text.slice(0, ponytailIdx).trim();
    } else if (text.startsWith('PONYTAIL MODE ACTIVE')) {
      return null;
    }
  } else {
    if (
      text.startsWith('[CONTEXT COMPACTION — REFERENCE ONLY]')
      || text.startsWith('[PRIOR CONTEXT — for reference only')
    ) {
      return null;
    }
  }

  return text.trim() || null;
}

/**
 * Extract prose from a JSONL-exported Hermes turn (`{"role":"user"|"assistant","content":"..."}`).
 */
export function extractHermesProse(
  record: Record<string, unknown>,
): { role: 'user' | 'assistant'; text: string; timestamp: string | null } | null {
  const role = record.role;
  if (role !== 'user' && role !== 'assistant') return null;
  if (Number(record._compressed_summary ?? 0) === 1) return null;

  const rawContent = record.content;
  if (typeof rawContent !== 'string') return null;
  const text = cleanHermesMessageContent(role, rawContent);
  if (!text) return null;

  return {
    role,
    text,
    timestamp: toIsoTimestamp(record.timestamp),
  };
}

function matchesWantedRoot(rawCwd: string | null, wanted: Set<string>): boolean {
  if (!rawCwd) return false;
  const resolved = path.resolve(rawCwd);
  if (wanted.has(foldPath(resolved))) return true;
  const normalized = normalizeCopilotRepoCwd(resolved);
  return normalized !== resolved && wanted.has(foldPath(normalized));
}

function matchCanonicalOwner(
  rawCwd: string | null,
  canonicalByFolded: Map<string, string>,
): string | null {
  if (!rawCwd) return null;
  const resolved = path.resolve(rawCwd);
  const exact = canonicalByFolded.get(foldPath(resolved));
  if (exact) return exact;

  const normalized = normalizeCopilotRepoCwd(resolved);
  const normMatch = canonicalByFolded.get(foldPath(normalized));
  if (normMatch) return normMatch;

  // Choose the longest matching repository root when `normalized` is a subdirectory inside a known root
  const targetFolded = foldPath(normalized);
  const sep = path.sep;
  let bestCanonical: string | null = null;
  let bestLength = 0;
  for (const [rootFolded, canonical] of canonicalByFolded.entries()) {
    const prefix = rootFolded.endsWith(sep) ? rootFolded : `${rootFolded}${sep}`;
    if (targetFolded.startsWith(prefix) && rootFolded.length > bestLength) {
      bestCanonical = canonical;
      bestLength = rootFolded.length;
    }
  }
  return bestCanonical;
}

type ScannedHermesSession = {
  file: HermesTranscriptFile;
  profile: string;
  dbPath: string;
  candidatesCwd: (string | null)[];
  startedAtMs: number;
  lastActivityMs: number;
  messageCount: number;
};

async function scanHermesStateDbSessions(
  dbPath: string,
  options: { onlySessionIds?: Set<string>; sinceMs?: number } = {},
): Promise<{ sessions: ScannedHermesSession[]; degraded: boolean }> {
  if (!(await fileExists(dbPath))) return { sessions: [], degraded: false };

  let client: Client | null = null;
  try {
    client = createClient({ url: pathToFileURL(path.resolve(dbPath)).href });
    await client.execute('PRAGMA busy_timeout = 5000;');
    await client.execute('PRAGMA query_only = ON;');

    const promptMap = new Map<string, string>();
    try {
      const promptRows = (await client.execute('SELECT hash, prompt FROM system_prompts')).rows;
      for (const row of promptRows) {
        if (row.hash && typeof row.prompt === 'string') {
          promptMap.set(String(row.hash), row.prompt);
        }
      }
    } catch {
      // Optional system_prompts table
    }

    const sessionRows = (await client.execute(
      `SELECT id, parent_session_id, cwd, git_repo_root, system_prompt, system_prompt_hash,
              started_at, last_activity_at, message_count
       FROM sessions`,
    )).rows;

    const profile = profileNameFromDbPath(dbPath);
    const sessions: ScannedHermesSession[] = [];

    for (const row of sessionRows) {
      const sessionId = String(row.id ?? '').trim();
      if (!sessionId) continue;
      if (options.onlySessionIds && !options.onlySessionIds.has(sessionId)) continue;

      const startedAtMs = toEpochMs(row.started_at);
      const lastActivityMs = toEpochMs(row.last_activity_at) || startedAtMs;
      const maxMs = Math.max(startedAtMs, lastActivityMs);
      if (options.sinceMs !== undefined && maxMs > 0 && maxMs < options.sinceMs) {
        continue;
      }

      const inlinePrompt = typeof row.system_prompt === 'string' ? row.system_prompt : null;
      const hashPrompt = row.system_prompt_hash ? promptMap.get(String(row.system_prompt_hash)) ?? null : null;
      const { promptCwd, promptRoot } = extractPromptCwdAndRoot(inlinePrompt ?? hashPrompt);

      const parentSessionId = typeof row.parent_session_id === 'string' && row.parent_session_id.trim()
        ? row.parent_session_id.trim()
        : null;

      sessions.push({
        file: {
          path: formatHermesSessionPath(dbPath, sessionId),
          sessionId,
          parentSessionId,
          harness: 'hermes',
        },
        profile,
        dbPath: path.resolve(dbPath),
        candidatesCwd: [
          typeof row.git_repo_root === 'string' && row.git_repo_root.trim() ? row.git_repo_root.trim() : null,
          typeof row.cwd === 'string' && row.cwd.trim() ? row.cwd.trim() : null,
          promptRoot,
          promptCwd,
        ],
        startedAtMs,
        lastActivityMs,
        messageCount: Number(row.message_count ?? 0),
      });
    }

    return { sessions, degraded: false };
  } catch {
    return { sessions: [], degraded: true };
  } finally {
    try { client?.close(); } catch { /* ignore */ }
  }
}

/**
 * Scan all Hermes `state.db` stores under `hermesHomeDir` for sessions belonging to `roots`.
 */
export async function scanHermesArchive(
  hermesHomeDir: string,
  roots: string[],
  uncanonicalise: (target: string) => string | null,
  options: { onlySessionIds?: Set<string> } = {},
): Promise<{ files: HermesTranscriptFile[]; degraded: boolean }> {
  const wanted = new Set<string>();
  for (const root of roots) {
    const resolved = path.resolve(root);
    const forms = [resolved, await fs.realpath(resolved).catch(() => null), uncanonicalise(resolved)];
    for (const form of forms) {
      if (form) wanted.add(foldPath(form));
    }
  }

  const dbPaths = await defaultHermesStateDbs(hermesHomeDir);
  const files: HermesTranscriptFile[] = [];
  let degraded = false;

  for (const dbPath of dbPaths) {
    const scanned = await scanHermesStateDbSessions(dbPath, {
      onlySessionIds: options.onlySessionIds,
    });
    if (scanned.degraded) degraded = true;
    for (const item of scanned.sessions) {
      if (item.candidatesCwd.some(cwd => matchesWantedRoot(cwd, wanted))) {
        files.push(item.file);
      }
    }
  }

  return { files, degraded };
}

function findUniquePromptRepoOwner(
  promptText: string,
  canonicalByFolded: Map<string, string>,
): string | null {
  if (!promptText) return null;
  const matchedOwners = new Set<string>();
  const pathPattern = /(?:[A-Za-z]:[/\\]|\/[A-Za-z0-9._-]+\/)[^\s"'`<>|*?]+/g;
  for (const match of promptText.matchAll(pathPattern)) {
    const raw = match[0].replace(/[.,;:!?)\]]+$/, '');
    const owner = matchCanonicalOwner(raw, canonicalByFolded);
    if (owner) matchedOwners.add(owner);
  }
  return matchedOwners.size === 1 ? [...matchedOwners][0] : null;
}

/**
 * Pre-build a repo-to-sessions lookup map across all Hermes profiles in a single pass.
 *
 * When a session ran inside a Kanban scratch workspace or generic home directory (`~/`, `C:/learn`),
 * inspects the first user message for a unique repository path match so single-repo delegated tasks
 * route to their target repository while multi-repo/general sessions stay in `unmapped` (for
 * `global.db`).
 */
export async function buildHermesRepoSessionMap(
  hermesHomeDir: string,
  repoRoots: string[],
  options: { sinceMs?: number } = {},
): Promise<HermesSessionMap> {
  const byRoot = new Map<string, (HermesTranscriptFile & { profile: string; dbPath: string })[]>();
  const canonicalByFolded = new Map<string, string>();

  for (const root of repoRoots) {
    const folded = foldPath(root);
    byRoot.set(folded, []);
    canonicalByFolded.set(folded, folded);
    const real = await fs.realpath(path.resolve(root)).catch(() => null);
    if (real) canonicalByFolded.set(foldPath(real), folded);
  }

  const dbPaths = await defaultHermesStateDbs(hermesHomeDir);
  const unmapped: (HermesTranscriptFile & { cwd: string | null; profile: string; dbPath: string })[] = [];
  let degraded = false;

  for (const dbPath of dbPaths) {
    const scanned = await scanHermesStateDbSessions(dbPath, { sinceMs: options.sinceMs });
    if (scanned.degraded) {
      degraded = true;
      continue;
    }

    const unresolvedForDb: ScannedHermesSession[] = [];
    for (const item of scanned.sessions) {
      let matchedOwner: string | null = null;
      for (const candidateCwd of item.candidatesCwd) {
        matchedOwner = matchCanonicalOwner(candidateCwd, canonicalByFolded);
        if (matchedOwner) break;
      }
      if (matchedOwner) {
        byRoot.get(matchedOwner)?.push({ ...item.file, profile: item.profile, dbPath: item.dbPath });
      } else {
        unresolvedForDb.push(item);
      }
    }

    if (unresolvedForDb.length === 0) continue;

    // Inspect first user message for unresolved sessions in one query per state.db
    const firstUserBySession = new Map<string, string>();
    let client: Client | null = null;
    try {
      client = createClient({ url: pathToFileURL(path.resolve(dbPath)).href });
      await client.execute('PRAGMA busy_timeout = 5000;');
      await client.execute('PRAGMA query_only = ON;');
      const rows = (await client.execute(
        `SELECT session_id, content
         FROM messages
         WHERE role = 'user'
           AND content IS NOT NULL
           AND COALESCE(_compressed_summary, 0) = 0
           AND id IN (
             SELECT MIN(id)
             FROM messages
             WHERE role = 'user'
               AND content IS NOT NULL
               AND COALESCE(_compressed_summary, 0) = 0
             GROUP BY session_id
           )`,
      )).rows;
      for (const row of rows) {
        if (row.session_id && typeof row.content === 'string') {
          const cleaned = cleanHermesMessageContent('user', row.content) ?? row.content;
          firstUserBySession.set(String(row.session_id), cleaned);
        }
      }
    } catch {
      // Optional prompt-hint enrichment
    } finally {
      try { client?.close(); } catch { /* ignore */ }
    }

    for (const item of unresolvedForDb) {
      const promptText = firstUserBySession.get(item.file.sessionId) ?? '';
      const hintedOwner = findUniquePromptRepoOwner(promptText, canonicalByFolded);
      if (hintedOwner) {
        byRoot.get(hintedOwner)?.push({ ...item.file, profile: item.profile, dbPath: item.dbPath });
      } else {
        const primaryCwd = item.candidatesCwd.find(Boolean) ?? null;
        unmapped.push({
          ...item.file,
          cwd: primaryCwd,
          profile: item.profile,
          dbPath: item.dbPath,
        });
      }
    }
  }

  return { byRoot, unmapped, degraded };
}

/**
 * Compute synthetic size and anchor metadata for a Hermes virtual session path so `runIndexPass`
 * can detect appended messages without re-indexing unchanged sessions.
 */
export async function statHermesVirtualSession(
  filePath: string,
): Promise<HermesVirtualFileMeta | null> {
  const parsed = parseHermesSessionPath(filePath);
  if (!parsed || !(await fileExists(parsed.dbPath))) return null;

  return withHermesDb(parsed.dbPath, async client => {
    const sessRows = (await client.execute({
      sql: 'SELECT id FROM sessions WHERE id = ?',
      args: [parsed.sessionId],
    })).rows;
    if (sessRows.length === 0) return null;

    const statRow = (await client.execute({
      sql: `SELECT COALESCE(MAX(id), 0) AS max_id,
                   COUNT(DISTINCT COALESCE(message_uid, CAST(id AS TEXT))) AS cnt
            FROM messages
            WHERE session_id = ?
              AND role IN ('user', 'assistant')
              AND content IS NOT NULL
              AND TRIM(content) <> ''
              AND COALESCE(_compressed_summary, 0) = 0`,
      args: [parsed.sessionId],
    })).rows[0];
    const maxId = Number(statRow?.max_id ?? 0);
    const count = Number(statRow?.cnt ?? 0);
    const digest = crypto.createHash('sha256').update(`hermes:${parsed.sessionId}:${maxId}:${count}`).digest('hex').slice(0, 32);
    return {
      size: maxId,
      anchor: `${maxId}:${digest}`,
    };
  });
}

export async function anchorHermesAt(filePath: string, bytes: number): Promise<string | null> {
  if (bytes <= 0) return null;
  const parsed = parseHermesSessionPath(filePath);
  if (!parsed || !(await fileExists(parsed.dbPath))) return null;

  try {
    return await withHermesDb(parsed.dbPath, async client => {
      const statRow = (await client.execute({
        sql: `SELECT COUNT(DISTINCT COALESCE(message_uid, CAST(id AS TEXT))) AS cnt
              FROM messages
              WHERE session_id = ?
                AND id <= ?
                AND role IN ('user', 'assistant')
                AND content IS NOT NULL
                AND TRIM(content) <> ''
                AND COALESCE(_compressed_summary, 0) = 0`,
        args: [parsed.sessionId, bytes],
      })).rows[0];
      const count = Number(statRow?.cnt ?? 0);
      const digest = crypto.createHash('sha256').update(`hermes:${parsed.sessionId}:${bytes}:${count}`).digest('hex').slice(0, 32);
      return `${bytes}:${digest}`;
    });
  } catch {
    return null;
  }
}

function sessionNamingFromHermesRow(row: Record<string, unknown>): SessionNaming | null {
  const displayName = typeof row.display_name === 'string' ? row.display_name.trim() : '';
  if (displayName) return { name: displayName, kind: NAME_KIND.custom };

  const title = typeof row.title === 'string' ? row.title.trim() : '';
  if (!title) return null;
  const source = typeof row.title_source === 'string' ? row.title_source.trim().toLowerCase() : '';
  return { name: title, kind: source === 'user' ? NAME_KIND.custom : NAME_KIND.ai };
}

/**
 * Stream deduplicated, cleaned user/assistant messages from a Hermes `state.db#session=<id>`
 * virtual path.
 *
 * Uses the SQLite `messages.id` row PK as `line`, `byteOffset`, `bytesConsumed`, and
 * `linesConsumed` so watermarks and O(1) message lookups work identically to `.jsonl` files.
 */
export async function* streamHermesProseFrom(
  filePath: string,
  startByte: number,
  startLine: number,
  onNaming?: (naming: SessionNaming) => void,
): AsyncGenerator<ProseChunk, ProseWatermark> {
  const parsed = parseHermesSessionPath(filePath);
  if (!parsed || !(await fileExists(parsed.dbPath))) {
    return { bytesConsumed: startByte, linesConsumed: startLine };
  }

  const afterId = Math.max(startByte, startLine);
  let client: Client | null = null;
  let rows: Record<string, unknown>[];
  let maxSeenId: number;

  try {
    client = createClient({ url: pathToFileURL(path.resolve(parsed.dbPath)).href });
    await client.execute('PRAGMA busy_timeout = 5000;');
    await client.execute('PRAGMA query_only = ON;');

    if (onNaming) {
      const sessRows = (await client.execute({
        sql: 'SELECT title, title_source, display_name FROM sessions WHERE id = ?',
        args: [parsed.sessionId],
      })).rows;
      if (sessRows.length > 0) {
        const naming = sessionNamingFromHermesRow(sessRows[0] as Record<string, unknown>);
        if (naming) onNaming(naming);
      }
    }

    // Deduplicate across context compaction clones by grouping on `COALESCE(message_uid, CAST(id AS TEXT))`
    // and keeping the earliest `MIN(id)` row.
    const rawRows = (await client.execute({
      sql: `SELECT id, role, content, timestamp, message_uid
            FROM messages
            WHERE session_id = ?
              AND role IN ('user', 'assistant')
              AND content IS NOT NULL
              AND TRIM(content) <> ''
              AND COALESCE(_compressed_summary, 0) = 0
              AND id IN (
                SELECT MIN(id)
                FROM messages
                WHERE session_id = ?
                  AND role IN ('user', 'assistant')
                  AND content IS NOT NULL
                  AND TRIM(content) <> ''
                  AND COALESCE(_compressed_summary, 0) = 0
                GROUP BY COALESCE(message_uid, CAST(id AS TEXT))
              )
              AND id > ?
            ORDER BY id ASC`,
      args: [parsed.sessionId, parsed.sessionId, afterId],
    })).rows;
    rows = rawRows as Record<string, unknown>[];

    const maxRow = (await client.execute({
      sql: `SELECT COALESCE(MAX(id), 0) AS max_id
            FROM messages
            WHERE session_id = ?
              AND role IN ('user', 'assistant')
              AND content IS NOT NULL
              AND TRIM(content) <> ''
              AND COALESCE(_compressed_summary, 0) = 0`,
      args: [parsed.sessionId],
    })).rows[0];
    maxSeenId = Math.max(afterId, Number(maxRow?.max_id ?? afterId));
  } catch {
    return { bytesConsumed: startByte, linesConsumed: startLine };
  } finally {
    try { client?.close(); } catch { /* ignore */ }
  }

  for (const row of rows) {
    const id = Number(row.id);
    const role = String(row.role) === 'user' ? 'user' : 'assistant';
    const cleaned = cleanHermesMessageContent(role, String(row.content ?? ''));
    if (!cleaned) continue;

    const message: ProseMessage = {
      line: id,
      role,
      text: cleaned,
      timestamp: toIsoTimestamp(row.timestamp),
    };
    yield {
      message,
      byteOffset: id,
      bytesConsumed: id,
      linesConsumed: id,
    };
  }

  return { bytesConsumed: maxSeenId, linesConsumed: maxSeenId };
}

export async function readHermesProseFrom(
  filePath: string,
  startByte: number,
  startLine: number,
): Promise<{ messages: ProseMessage[]; bytesRead: number; linesRead: number }> {
  const messages: ProseMessage[] = [];
  const iterator = streamHermesProseFrom(filePath, startByte, startLine);
  for (;;) {
    const next = await iterator.next();
    if (next.done) {
      return { messages, bytesRead: next.value.bytesConsumed, linesRead: next.value.linesConsumed };
    }
    messages.push(next.value.message);
  }
}

export async function readHermesMessagesAt(
  filePath: string,
  lines: number[],
): Promise<Map<number, TranscriptExcerpt>> {
  const found = new Map<number, TranscriptExcerpt>();
  if (lines.length === 0) return found;
  const parsed = parseHermesSessionPath(filePath);
  if (!parsed || !(await fileExists(parsed.dbPath))) return found;

  try {
    await withHermesDb(parsed.dbPath, async client => {
      for (let start = 0; start < lines.length; start += SQLITE_IN_BATCH) {
        const batch = lines.slice(start, start + SQLITE_IN_BATCH);
        const placeholders = batch.map(() => '?').join(', ');
        const rows = (await client.execute({
          sql: `SELECT id, role, content, timestamp
                FROM messages
                WHERE session_id = ?
                  AND id IN (${placeholders})
                  AND role IN ('user', 'assistant')
                  AND content IS NOT NULL
                  AND COALESCE(_compressed_summary, 0) = 0`,
          args: [parsed.sessionId, ...batch],
        })).rows;
        for (const row of rows) {
          const id = Number(row.id);
          const role = String(row.role) === 'user' ? 'user' : 'assistant';
          const cleaned = cleanHermesMessageContent(role, String(row.content ?? ''));
          if (!cleaned) continue;
          found.set(id, {
            line: id,
            role,
            text: cleaned,
            timestamp: toIsoTimestamp(row.timestamp),
          });
        }
      }
    });
  } catch {
    return found;
  }
  return found;
}

export async function readHermesMessageAt(
  filePath: string,
  line: number,
): Promise<TranscriptExcerpt | null> {
  return (await readHermesMessagesAt(filePath, [line])).get(line) ?? null;
}

export async function readHermesMessagesFor(
  filePath: string,
  pointers: MessagePointer[],
): Promise<Map<number, TranscriptExcerpt>> {
  return readHermesMessagesAt(filePath, pointers.map(p => p.line));
}

export async function readHermesWithContext(
  filePath: string,
  line: number,
  context: number,
): Promise<TranscriptExcerpt[]> {
  const before: TranscriptExcerpt[] = [];
  const after: TranscriptExcerpt[] = [];
  let target: TranscriptExcerpt | null = null;

  try {
    for await (const chunk of streamHermesProseFrom(filePath, 0, 0)) {
      const { line: at, role, text, timestamp } = chunk.message;
      const excerpt: TranscriptExcerpt = { line: at, role, text, timestamp };

      if (at < line) {
        if (context > 0) {
          before.push(excerpt);
          if (before.length > context) before.shift();
        }
        continue;
      }
      if (at === line) {
        target = excerpt;
        continue;
      }
      if (!target) break;
      if (after.length >= context) break;
      after.push(excerpt);
      if (after.length >= context) break;
    }
  } catch {
    return [];
  }

  return target ? [...before, target, ...after] : [];
}

const USEFUL_COMPACTION_SECTIONS = new Set([
  'goal',
  'constraints & preferences',
  'completed actions',
  'key decisions',
  'errors & fixes',
  'resolved questions',
  'critical context',
]);

/**
 * Extract high-signal sections (`## Goal`, `## Constraints & Preferences`, `## Completed Actions`,
 * `## Key Decisions`, `## Errors & Fixes`, `## Resolved Questions`, `## Critical Context`) from
 * the latest `_compressed_summary = 1` row of a Hermes session, analogous to `readCopilotCheckpointsText`.
 */
export async function readHermesCompactedSummaryText(
  sessionId: string,
  virtualFilePath?: string,
): Promise<string> {
  const parsed = virtualFilePath ? parseHermesSessionPath(virtualFilePath) : null;
  const dbPath = parsed?.dbPath;
  if (!dbPath || !(await fileExists(dbPath))) return '';

  let client: Client | null = null;
  try {
    client = createClient({ url: pathToFileURL(path.resolve(dbPath)).href });
    await client.execute('PRAGMA busy_timeout = 5000;');
    await client.execute('PRAGMA query_only = ON;');
    const rows = (await client.execute({
      sql: `SELECT content
            FROM messages
            WHERE session_id = ?
              AND COALESCE(_compressed_summary, 0) = 1
              AND content IS NOT NULL
            ORDER BY id DESC
            LIMIT 1`,
      args: [sessionId],
    })).rows;
    if (rows.length === 0) return '';

    const raw = String(rows[0].content ?? '');
    const blocks = raw.split(/(?=^##\s+)/m);
    const kept: string[] = [];
    for (const block of blocks) {
      const match = /^##\s+([^\r\n]+)/.exec(block);
      if (!match) continue;
      const heading = match[1].trim().toLowerCase();
      if (USEFUL_COMPACTION_SECTIONS.has(heading)) {
        kept.push(block.trim());
      }
    }
    return kept.join('\n\n');
  } catch {
    return '';
  } finally {
    try { client?.close(); } catch { /* ignore */ }
  }
}
