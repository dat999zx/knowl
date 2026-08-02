import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join, basename, delimiter, resolve } from 'node:path';
import { getClient } from './database.js';

// Incremental index over raw Claude Code session transcripts.
//
// The naive approach - stream every file on every query - costs seconds per
// lookup and gets worse as history grows, which is exactly the wrong shape for
// something an agent should reach for whenever it is unsure. Transcripts are
// append-only, so a byte offset is a valid resume point: each pass reads only
// what was written since the last one, and steady-state indexing is nearly free.
//
// Everything here is derived data. The .jsonl files are the source of truth, so
// these tables can be dropped and rebuilt without losing anything.

const ROLE_WEIGHT: Record<string, number> = { user: 2, assistant: 1 };
const TOOL_WEIGHT = 0.3;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'was', 'were', 'are', 'you', 'your',
  'not', 'but', 'have', 'has', 'had', 'its', 'it', 'is', 'be', 'to', 'of', 'in', 'on', 'a',
  'i', 'we', 'they', 'as', 'at', 'by', 'or', 'an', 'if', 'so', 'do', 'does', 'did', 'can',
]);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length < 2 || raw.length > 40 || STOPWORDS.has(raw)) continue;
    out.push(raw);
  }
  return out;
}

/** Claude Code encodes the project path by replacing every non-alphanumeric character with '-'. */
export function encodeProjectDir(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * One directory, one key.
 *
 * project_dir is an opaque string in every one of these queries, so each
 * spelling of the same path becomes a separate archive. On Windows that is not
 * hypothetical: `D:\Code\x`, `d:\Code\x` and `d:/Code/x` all reach the same
 * folder and all arrived here, depending on whether the caller was the CLI
 * (path.resolve), the MCP server (its configured root) or a script.
 *
 * Measured on a real database before this existed: 59,358 messages indexed
 * three times over under three spellings, and every embedding attached to just
 * one of them - so semantic search from the MCP server scored against a set
 * that had no vectors at all and silently returned lexical results. The
 * duplicates also tripled the storage.
 *
 * Resolve, then upper-case the drive letter, which is the one part path.resolve
 * leaves as the caller typed it.
 */
export function normalizeProjectDir(dir: string): string {
  const resolved = resolve(dir);
  return /^[a-z]:/.test(resolved) ? resolved[0].toUpperCase() + resolved.slice(1) : resolved;
}

/**
 * Every config root that may hold transcripts. CLAUDE_CONFIG_DIR wins when set;
 * the default install location is always included. A machine with additional
 * stores - a second account, a synced archive - names them in
 * KNOWL_TRANSCRIPT_ROOTS (path-delimiter separated), because which extra roots
 * exist is a property of one machine, not of this package.
 */
export function transcriptStores(): string[] {
  const roots = new Set<string>();
  if (process.env.CLAUDE_CONFIG_DIR) roots.add(process.env.CLAUDE_CONFIG_DIR);
  roots.add(join(homedir(), '.claude'));
  for (const extra of (process.env.KNOWL_TRANSCRIPT_ROOTS ?? '').split(delimiter)) {
    if (extra.trim()) roots.add(extra.trim());
  }
  return [...roots].map(root => join(root, 'projects'));
}

export interface SessionFile { sessionId: string; path: string; mtimeMs: number; size: number }

export async function sessionFiles(projectDir: string, stores?: string[]): Promise<SessionFile[]> {
  const encoded = encodeProjectDir(projectDir);
  // Two stores can hold the same session id; keep the most recently written copy.
  const newest = new Map<string, SessionFile>();
  for (const store of stores ?? transcriptStores()) {
    let names: string[];
    try { names = await readdir(join(store, encoded)); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(store, encoded, name);
      let info;
      try { info = await stat(path); } catch { continue; }
      const sessionId = basename(name, '.jsonl');
      const prev = newest.get(sessionId);
      // Truncated to whole milliseconds: stat reports a float, the watermark
      // column stores an integer, and comparing the two must not invent a
      // rewrite out of the fractional part.
      const mtimeMs = Math.trunc(info.mtimeMs);
      if (!prev || prev.mtimeMs < mtimeMs) {
        newest.set(sessionId, { sessionId, path, mtimeMs, size: info.size });
      }
    }
  }
  return [...newest.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Entries that are structurally present but carry no recallable content: the
 * local-command caveat wrapper, bare slash commands, and the startup handshake.
 * Indexing them pollutes document frequency and wastes result slots.
 */
function isNoise(text: string): boolean {
  const t = text.trimStart();
  if (!t) return true;
  if (t.startsWith('<local-command-caveat>')) return true;
  // Slash-command invocations arrive wrapped either way round.
  if (t.startsWith('<command-name>') || t.startsWith('<command-message>')) return true;
  return /^Caveat: The messages below were generated/.test(t);
}

function extractText(entry: any): { text: string; toolChars: number } {
  const content = entry?.message?.content;
  if (typeof content === 'string') return { text: content, toolChars: 0 };
  if (!Array.isArray(content)) return { text: '', toolChars: 0 };
  const parts: string[] = [];
  let toolChars = 0;
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') { parts.push(block.text); continue; }
    // Tool traffic is most of the bytes and little of the signal, but a command,
    // path or error string is sometimes the only place an answer survives. It is
    // indexed and then weighted down, rather than discarded.
    if (block?.type === 'tool_use') {
      const s = JSON.stringify(block.input ?? {});
      toolChars += s.length; parts.push(s);
    } else if (block?.type === 'tool_result') {
      const s = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
      toolChars += s.length; parts.push(s);
    }
  }
  return { text: parts.join('\n'), toolChars };
}

/** Bounded so one pasted 5MB file cannot dominate the index or a snippet. */
const MAX_TEXT_CHARS = 20_000;

/**
 * How long one call may spend indexing. Indexing runs inside a tool call, so
 * this is really a promise about latency: a first search on a large archive
 * returns whatever is indexed so far and says the index is still warming,
 * rather than blocking the caller for minutes.
 */
const DEFAULT_INDEX_BUDGET_MS = 8_000;

/** Statements per write transaction. Small on purpose - see flush(). */
const BATCH_STATEMENTS = 500;

interface PendingMessage {
  sessionId: string; line: number; role: string; ts: string | null;
  weight: number; len: number; text: string;
}

/**
 * Message ids are assigned here rather than read back from the database. The
 * obvious shape - INSERT ... RETURNING per message - costs a round trip each,
 * which on a real archive is tens of thousands of round trips and minutes of
 * wall clock. Allocating ids from a counter lets a whole batch go out at once.
 */
async function flush(projectDir: string, pending: PendingMessage[], nextId: { value: number }): Promise<void> {
  if (pending.length === 0) return;
  const client = getClient();
  const statements: Array<{ sql: string; args: any[] }> = [];
  for (const message of pending) {
    const messageId = nextId.value++;
    statements.push({
      sql: `INSERT INTO transcript_messages (id, project_dir, session_id, line, role, ts, weight, len, text)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [messageId, projectDir, message.sessionId, message.line, message.role, message.ts, message.weight, message.len, message.text],
    });
    // FTS5 tokenizes and ranks; nothing here has to build a term index by hand.
    statements.push({
      sql: 'INSERT INTO transcript_fts (rowid, text) VALUES (?, ?)',
      args: [messageId, message.text],
    });
  }
  // libsql runs a batch as one transaction, so the per-statement fsync that
  // dominates unbatched SQLite writes happens once instead of per row. The
  // chunk stays small deliberately: this database is also being served to a
  // live session, and a long write transaction starves it into SQLITE_BUSY.
  for (let i = 0; i < statements.length; i += BATCH_STATEMENTS) {
    try {
      // Observed repeatedly beside a live serve process writing to the same
      // database: transient BUSY on commit. Retried with backoff because one
      // retry proved too thin under sustained neighbour writes; a final
      // failure is treated like any other batch error below.
      for (let attempt = 0; ; attempt++) {
        try {
          await client.batch(statements.slice(i, i + BATCH_STATEMENTS), 'write');
          break;
        } catch (error) {
          const busy = /SQLITE_BUSY|statements in progress/i.test(String((error as Error).message));
          if (!busy || attempt >= 3) throw error;
          await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        }
      }
    } catch (error) {
      // A primary-key collision means another process allocated the same ids -
      // the file lease serializes work per FILE, but ids come from one MAX(id)
      // read per pass, so two passes on different files can still clash. The
      // colliding transaction rolled back, so nothing partial landed from this
      // chunk; surrender the file and let the next pass resume from a fresh
      // MAX. Committed earlier chunks sit beyond the watermark and are purged
      // by whoever claims the file next.
      if (/SQLITE_CONSTRAINT|UNIQUE/i.test(String((error as Error).message))) throw new IdCollisionError();
      throw error;
    }
  }
}

class IdCollisionError extends Error {
  constructor() { super('transcript id collision: concurrent indexer detected'); }
}

async function nextMessageId(): Promise<number> {
  const row = (await getClient().execute('SELECT COALESCE(MAX(id), 0) AS max_id FROM transcript_messages')).rows[0];
  return Number(row.max_id) + 1;
}

/**
 * How long one process's claim on a file is honoured. Knowl runs one serve
 * process per connected session, so two sessions on the same project index
 * concurrently unless something serializes them - both would read the same
 * MAX(id) and the same watermark, then collide on primary keys or write the
 * same messages twice. Longer than an index pass's budget, short enough that a
 * crashed claimant only stalls a file briefly.
 */
const LEASE_MS = 20_000;

/** Claims written by THIS process, so it can resume its own budget-paused files without waiting out the lease. */
const ownClaims = new Set<string>();

/** Remove indexed rows for a session beyond a line watermark, embeddings included - a purged id can be reallocated, and a stale cached vector would silently attach to the wrong message. */
async function purgeBeyond(projectDir: string, sessionId: string, afterLine: number): Promise<void> {
  const client = getClient();
  const where = 'session_id = ? AND project_dir = ? AND line > ?';
  const args = [sessionId, projectDir, afterLine];
  await client.execute({
    sql: `INSERT INTO transcript_fts(transcript_fts, rowid, text)
          SELECT 'delete', id, text FROM transcript_messages WHERE ${where}`,
    args,
  });
  await client.execute({ sql: `DELETE FROM transcript_embeddings WHERE message_id IN (SELECT id FROM transcript_messages WHERE ${where})`, args });
  await client.execute({ sql: `DELETE FROM transcript_messages WHERE ${where}`, args });
}

type FileOutcome = { added: number; complete: boolean; reason?: 'budget' | 'leased' };

async function indexFile(projectDir: string, file: SessionFile, nextId: { value: number }, deadline: number): Promise<FileOutcome> {
  const client = getClient();
  const row = (await client.execute({
    sql: 'SELECT bytes_indexed, lines_indexed, indexed_at, mtime_ms, display_name, name_kind, opening FROM transcript_files WHERE path = ?',
    args: [file.path],
  })).rows[0];

  let startByte = row ? Number(row.bytes_indexed) : 0;
  let lineNo = row ? Number(row.lines_indexed) : 0;
  const prevStamp = row ? String(row.indexed_at) : null;
  // A file rewritten to the SAME size slips past the shrink check below, but
  // not past its own mtime. Only meaningful on a completed row: partial rows
  // store mtime 0 until their pass finishes. Bounded by filesystem timestamp
  // granularity - a rewrite within the same tick as the indexed write is
  // invisible, which real editing does not do.
  const rewrittenInPlace = row !== undefined
    && startByte === file.size && Number(row.mtime_ms) !== 0 && Number(row.mtime_ms) !== file.mtimeMs;
  // Carried across incremental passes: a rename entry seen weeks ago must not
  // be forgotten because later passes only read the appended tail.
  let name = row?.display_name ? String(row.display_name) : null;
  let nameKind = row ? Number(row.name_kind) : 0;
  let opening = row?.opening ? String(row.opening) : null;

  // A file that shrank was rewritten rather than appended to, so the offset is
  // meaningless and its rows have to go. Same-size rewrites are caught above.
  if (startByte > file.size || rewrittenInPlace) {
    await purgeBeyond(projectDir, file.sessionId, 0);
    // The file was rewritten, so metadata read from the old content is void.
    startByte = 0; lineNo = 0; name = null; nameKind = 0; opening = null;
  }
  if (startByte === file.size) return { added: 0, complete: true };

  // Another process's fresh claim: leave the file to it. Our own claim from a
  // budget-paused pass is exempt, or a paused pass could never resume itself.
  if (prevStamp && !ownClaims.has(prevStamp)) {
    const stampedAt = Date.parse(prevStamp);
    if (Number.isFinite(stampedAt) && Date.now() - stampedAt < LEASE_MS) {
      return { added: 0, complete: false, reason: 'leased' };
    }
  }

  // Take the claim with a compare-and-set on the stamp we read, so two
  // processes arriving together cannot both win. The loser skips the file.
  const claim = new Date().toISOString();
  const claimed = row
    ? await client.execute({ sql: 'UPDATE transcript_files SET indexed_at = ? WHERE path = ? AND indexed_at = ?', args: [claim, file.path, prevStamp] })
    : await client.execute({
        sql: 'INSERT OR IGNORE INTO transcript_files (path, project_dir, session_id, bytes_indexed, lines_indexed, mtime_ms, indexed_at) VALUES (?, ?, ?, 0, 0, 0, ?)',
        args: [file.path, projectDir, file.sessionId, claim],
      });
  if (Number(claimed.rowsAffected) === 0) return { added: 0, complete: false, reason: 'leased' };
  ownClaims.add(claim);

  // A previous claimant may have died mid-file: batches it committed past the
  // watermark would be indexed AGAIN from the watermark, as duplicates with
  // fresh ids. Purge beyond the watermark before resuming so the resume is
  // idempotent. A no-op on a clean handoff.
  await purgeBeyond(projectDir, file.sessionId, lineNo);

  const pending: PendingMessage[] = [];
  let added = 0;
  // Bytes consumed since startByte, so a run that stops early can record where
  // it got to. Transcripts are newline-delimited UTF-8, so line length plus one
  // is exact; the offset is snapped to the real file size on completion anyway.
  let consumed = 0;
  let complete = true;
  try {
    const rl = createInterface({ input: createReadStream(file.path, { start: startByte }), crlfDelay: Infinity });
    for await (const line of rl) {
      lineNo++;
      consumed += Buffer.byteLength(line, 'utf8') + 1;
      // Checked per line rather than per file: one 170MB transcript can blow any
      // budget on its own, and a caller left waiting minutes for a tool call will
      // give up long before the index is warm.
      if (Date.now() > deadline) { complete = false; rl.close(); break; }
      if (!line.trim()) continue;
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }
      // The transcript names itself: a user rename (custom-title, mirrored by
      // agent-name) outranks the generated ai-title, and within a rank the
      // later entry wins. External tools fall back to filenames or first
      // prompts; the better source was here all along.
      if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') { name = entry.customTitle; nameKind = 3; continue; }
      if (entry.type === 'agent-name' && typeof entry.agentName === 'string' && nameKind <= 2) { name = entry.agentName; nameKind = 2; continue; }
      if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string' && nameKind <= 1) { name = entry.aiTitle; nameKind = 1; continue; }
      if (entry.type !== 'user' && entry.type !== 'assistant') continue;
      const { text, toolChars } = extractText(entry);
      if (!text || isNoise(text)) continue;
      // The first real ask, as the session's one-line descriptor.
      if (opening === null && entry.type === 'user') opening = text.replace(/\s+/g, ' ').slice(0, 240);
      const clipped = text.slice(0, MAX_TEXT_CHARS);
      pending.push({
        sessionId: file.sessionId, line: lineNo, role: entry.type,
        ts: typeof entry.timestamp === 'string' ? entry.timestamp : null,
        weight: (ROLE_WEIGHT[entry.type] ?? 1) * (toolChars > clipped.length / 2 ? TOOL_WEIGHT : 1),
        len: clipped.length, text: clipped,
      });
      added++;
      if (pending.length >= 500) { await flush(projectDir, pending, nextId); pending.length = 0; }
    }
    await flush(projectDir, pending, nextId);
  } catch (error) {
    if (error instanceof IdCollisionError) {
      // Deliberately no watermark write: it still points at the last state this
      // process knows was fully committed, which is what the next claimant
      // needs to purge-and-resume correctly.
      return { added: 0, complete: false, reason: 'leased' };
    }
    throw error;
  }

  // On a complete pass the real file size is authoritative; on a partial one the
  // running byte count is the resume point, so the next call picks up mid-file
  // instead of starting the whole transcript again.
  const bytesIndexed = complete ? file.size : startByte + consumed;
  const doneStamp = new Date().toISOString();
  ownClaims.add(doneStamp);
  await client.execute({
    sql: `INSERT INTO transcript_files (path, project_dir, session_id, bytes_indexed, lines_indexed, mtime_ms, indexed_at, display_name, name_kind, opening)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(path) DO UPDATE SET bytes_indexed = excluded.bytes_indexed,
            lines_indexed = excluded.lines_indexed, mtime_ms = excluded.mtime_ms, indexed_at = excluded.indexed_at,
            display_name = excluded.display_name, name_kind = excluded.name_kind, opening = excluded.opening`,
    args: [file.path, projectDir, file.sessionId, bytesIndexed, lineNo, complete ? file.mtimeMs : 0, doneStamp, name, nameKind, opening],
  });
  return complete ? { added, complete } : { added, complete, reason: 'budget' };
}

export interface IndexResult {
  filesScanned: number;
  filesUpdated: number;
  messagesAdded: number;
  ms: number;
  /** False when the budget ran out with work left. The next call resumes. */
  complete: boolean;
  /**
   * Session files not brought fully up to date this pass; 0 when complete. Coverage has to
   * travel as a NUMBER, not as an adjective in a footer: a caller deciding whether "no
   * matches" means absence needs to know how much of the archive was actually searched.
   */
  filesPending: number;
}

/**
 * Bring the index up to date. Cheap when nothing changed: a file whose size
 * matches the stored offset is skipped without being opened.
 */
export async function ensureTranscriptIndex(rawProjectDir: string, stores?: string[], budgetMs = DEFAULT_INDEX_BUDGET_MS): Promise<IndexResult> {
  const projectDir = normalizeProjectDir(rawProjectDir);
  const started = Date.now();
  const deadline = started + budgetMs;
  const files = await sessionFiles(projectDir, stores);
  const nextId = { value: await nextMessageId() };
  let filesUpdated = 0;
  let messagesAdded = 0;
  let complete = true;
  // Newest first, so a cold index makes the most recent history searchable
  // first - that is what a question is most likely to be about.
  let filesSettled = 0;
  for (const file of files) {
    if (Date.now() > deadline) { complete = false; break; }
    const result = await indexFile(projectDir, file, nextId, deadline);
    if (result.added > 0) { filesUpdated++; messagesAdded += result.added; }
    if (!result.complete) {
      complete = false;
      // Budget exhaustion ends the pass; a lease held by another process only
      // ends THAT file - the rest of the archive is still ours to index.
      if (result.reason === 'budget') break;
      continue;
    }
    filesSettled++;
  }
  return {
    filesScanned: files.length,
    filesUpdated,
    messagesAdded,
    ms: Date.now() - started,
    complete,
    filesPending: files.length - filesSettled,
  };
}

export async function transcriptIndexStats(rawProjectDir: string): Promise<{ messages: number; avgLen: number; sessions: number }> {
  const projectDir = normalizeProjectDir(rawProjectDir);
  const client = getClient();
  const row = (await client.execute({
    sql: 'SELECT COUNT(*) AS n, COALESCE(AVG(len), 1) AS avg_len, COUNT(DISTINCT session_id) AS sessions FROM transcript_messages WHERE project_dir = ?',
    args: [projectDir],
  })).rows[0];
  return { messages: Number(row.n), avgLen: Number(row.avg_len) || 1, sessions: Number(row.sessions) };
}
