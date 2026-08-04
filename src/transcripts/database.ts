import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient, type Client } from '@libsql/client';

/**
 * Schema for `.knowl/transcripts.db`.
 *
 * Deliberately not part of `src/store/bootstrap.ts`. This file is optional, is deleted when the
 * feature is turned off, and must never be migrated by a knowledge-database open.
 */
export const TRANSCRIPT_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS transcript_files (
    path TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    parent_session_id TEXT,
    bytes_indexed INTEGER NOT NULL DEFAULT 0,
    lines_indexed INTEGER NOT NULL DEFAULT 0,
    size_at_index INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    display_name TEXT,
    name_kind INTEGER NOT NULL DEFAULT 0,
    opening TEXT,
    anchor TEXT
  );`,

  // No `body` column anywhere: a row is a pointer. The text stays in the .jsonl.
  // `byte_offset` is part of the pointer: the offset of the line's first byte, so reading one
  // message back seeks to it instead of streaming the file from the start.
  `CREATE TABLE IF NOT EXISTS transcript_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    session_id TEXT NOT NULL,
    parent_session_id TEXT,
    line INTEGER NOT NULL,
    role TEXT NOT NULL,
    chars INTEGER NOT NULL,
    ts TEXT,
    byte_offset INTEGER
  );`,

  // What the last pass could say about itself. Completeness cannot be derived from the rows
  // that exist: a file the pass never reached has no row, so "every row is caught up" is true
  // of an index missing half the archive. One row, id 1.
  `CREATE TABLE IF NOT EXISTS transcript_index_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    complete INTEGER NOT NULL,
    files_seen INTEGER NOT NULL,
    files_indexed INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );`,

  `CREATE INDEX IF NOT EXISTS idx_transcript_messages_path ON transcript_messages(path);`,
  `CREATE INDEX IF NOT EXISTS idx_transcript_messages_session ON transcript_messages(session_id);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_transcript_messages_line ON transcript_messages(path, line);`,

  // contentless_delete=1 needs SQLite >= 3.43; @libsql/client ships 3.45.1. Without it a
  // rebuilt file would leave its old terms matchable forever.
  `CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
    body,
    content='',
    contentless_delete=1
  );`,

  `CREATE TABLE IF NOT EXISTS transcript_vectors (
    message_id INTEGER PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    dims INTEGER NOT NULL,
    scale REAL NOT NULL,
    vec BLOB NOT NULL
  );`,

  `CREATE INDEX IF NOT EXISTS idx_transcript_vectors_fingerprint ON transcript_vectors(fingerprint);`,
];

/**
 * Add the naming columns to an index built before they existed.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, so an index from the first
 * transcript release has the old shape. Each column is added only if absent -- `ALTER TABLE ADD
 * COLUMN` throws on a duplicate, and that would fail every subsequent open of the database.
 */
async function addNamingColumns(client: Client): Promise<void> {
  const columns = (await client.execute('PRAGMA table_info(transcript_files)')).rows
    .map(row => String(row.name));

  if (!columns.includes('display_name')) {
    await client.execute('ALTER TABLE transcript_files ADD COLUMN display_name TEXT;');
  }
  if (!columns.includes('name_kind')) {
    await client.execute('ALTER TABLE transcript_files ADD COLUMN name_kind INTEGER NOT NULL DEFAULT 0;');
  }
  // Added, like `anchor` below, without resetting a single watermark. It used to reset all of
  // them -- `bytes_indexed`, `lines_indexed` and `size_at_index` to 0 -- so the next pass would
  // re-read every file and refill names and openings, on the stated grounds that `commitBatchOn`
  // skips lines already covered so nothing could be duplicated. It does not skip them: it
  // re-reads `lines_indexed`, which this had just set to 0, so every surviving message row was
  // re-inserted and the pass died on UNIQUE(path, line) -- permanently, since the column now
  // exists and the migration never runs again to undo it. Rows and watermark are one fact; a
  // migration that moves one without the other strands the index.
  //
  // What is given up: a session indexed before this column and never appended to again keeps a
  // null name and opening. One that is still being written to picks its name up from the lines
  // it grows by, the same lazy adoption the anchor uses. The opening ask is *not* filled in that
  // way -- see `indexOneFile`, which refuses to call a message mid-file the session's first ask.
  if (!columns.includes('opening')) {
    await client.execute('ALTER TABLE transcript_files ADD COLUMN opening TEXT;');
  }
  // Deliberately *not* accompanied by a watermark reset. A null anchor means "unknown", which
  // the index pass adopts the next time it looks at the file -- so an existing index gains
  // rewrite detection without re-reading anything.
  if (!columns.includes('anchor')) {
    await client.execute('ALTER TABLE transcript_files ADD COLUMN anchor TEXT;');
  }

  const messageColumns = (await client.execute('PRAGMA table_info(transcript_messages)')).rows
    .map(row => String(row.name));
  // Null for rows written before this column existed; the reader falls back to a streaming
  // scan for those, so an old index keeps working and gets faster as files are touched.
  if (!messageColumns.includes('byte_offset')) {
    await client.execute('ALTER TABLE transcript_messages ADD COLUMN byte_offset INTEGER;');
  }

  // Partial on purpose: it holds only the rows still waiting for an offset, so it empties itself
  // as the backfill finishes and costs nothing to maintain afterwards -- a new row is written
  // with its offset and never enters it. Without it, the "is there anything left to fill" probe
  // scans the whole messages table on every pass, which is every agent turn, for ever.
  //
  // Created here rather than with the other schema statements because it is built *on* the
  // column above, which an index from the first release does not have yet.
  await client.execute(`CREATE INDEX IF NOT EXISTS idx_transcript_messages_pending_offset
    ON transcript_messages(path, line) WHERE byte_offset IS NULL;`);
}

export type TranscriptIndexState = {
  /** Whether the last pass reached the end of the archive. */
  complete: boolean;
  /** Transcripts discovered on disk by that pass. */
  filesSeen: number;
  /** Transcripts with a row when it finished. */
  filesIndexed: number;
};

/**
 * What the last index pass reported about itself, or null when nothing has.
 *
 * Null is not "complete". An index built by a version that did not record this, or a peer's
 * older schema, has not proven anything -- and the whole point of the signal is that a caller
 * told "no matches" must be able to tell absence from ignorance.
 */
export async function readTranscriptIndexState(client: Client): Promise<TranscriptIndexState | null> {
  try {
    const rows = (await client.execute(
      'SELECT complete, files_seen, files_indexed FROM transcript_index_state WHERE id = 1',
    )).rows;
    if (rows.length === 0) return null;
    return {
      complete: Number(rows[0].complete) === 1,
      filesSeen: Number(rows[0].files_seen),
      filesIndexed: Number(rows[0].files_indexed),
    };
  } catch {
    return null; // No such table: an index from before this existed.
  }
}

const BASE_STATEMENTS = [
  // First, for the same reason as the knowledge database: journal_mode takes a lock, and a
  // connection's default busy_timeout is 0, so a concurrent writer would fail the open outright.
  'PRAGMA busy_timeout = 10000;',
  'PRAGMA journal_mode = WAL;',
  // Same choice and the same reasoning as the knowledge database -- see the long note on
  // `BASE_STATEMENTS` in `../store/bootstrap.ts` for the measurements and the durability trade.
  // It matters at least as much here: an index pass writes a great many small rows, and this
  // database is the one a backfill hammers while a live session writes beside it.
  'PRAGMA synchronous = NORMAL;',
];

const clients = new Map<string, Client>();

const keyFor = (dbPath: string, readOnly: boolean) => `${readOnly ? 'ro' : 'rw'}:${path.resolve(dbPath)}`;

/** Thrown instead of silently creating a database that a read-only caller expected to exist. */
export class TranscriptIndexMissingError extends Error {
  constructor(readonly dbPath: string) {
    super(`No transcript index at ${dbPath}.`);
    this.name = 'TranscriptIndexMissingError';
  }
}

/**
 * Open (and on a writable open, create) a transcripts database.
 *
 * A read-only open never bootstraps: it is used to search a linked workspace repo's index, and
 * reading a peer must not create or migrate anything it owns. `query_only` makes SQLite itself
 * enforce that rather than leaving it to convention.
 *
 * The existence check is load-bearing, not defensive. `file:<path>` **creates** the file, and
 * `query_only` is only applied after the connection is open -- so a read-only open of a peer
 * that has no index used to write an empty `transcripts.db` into that repo's `.knowl/`, which
 * is exactly the thing "we only ever read a peer" is supposed to rule out. `?mode=ro` is not
 * an option: `@libsql/client` rejects it with `URL_PARAM_NOT_SUPPORTED`.
 */
export async function openTranscriptDb(
  dbPath: string,
  options: { readOnly?: boolean } = {},
): Promise<Client> {
  const readOnly = options.readOnly === true;
  const key = keyFor(dbPath, readOnly);
  const existing = clients.get(key);
  if (existing) return existing;

  const resolved = path.resolve(dbPath);
  if (readOnly && !(await fs.access(resolved).then(() => true, () => false))) {
    throw new TranscriptIndexMissingError(resolved);
  }

  const client = createClient({ url: `file:${resolved}` });
  try {
    if (readOnly) {
      await client.execute('PRAGMA busy_timeout = 10000;');
      await client.execute('PRAGMA query_only = ON;');
    } else {
      for (const statement of BASE_STATEMENTS) await client.execute(statement);
      for (const statement of TRANSCRIPT_SCHEMA_STATEMENTS) await client.execute(statement);
      await addNamingColumns(client);
    }
  } catch (error) {
    // An un-closed client on a failed open keeps whatever lock its partial bootstrap took, and
    // nothing else here ever closes it -- every later acquire would contend with this process.
    await client.close();
    throw error;
  }

  clients.set(key, client);
  return client;
}

/** Drop one cached client so the next acquire reconnects. */
export async function closeTranscriptDb(dbPath: string): Promise<void> {
  for (const readOnly of [false, true]) {
    const key = keyFor(dbPath, readOnly);
    const client = clients.get(key);
    if (!client) continue;
    clients.delete(key);
    if (!readOnly) await client.execute('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => {});
    client.close();
  }
}

function errorCode(error: unknown): string {
  const raw = error as { code?: unknown; message?: unknown };
  const code = typeof raw?.code === 'string' ? raw.code : '';
  const message = typeof raw?.message === 'string' ? raw.message : '';
  return `${code} ${message}`.toUpperCase();
}

const isSnapshotStall = (error: unknown) => errorCode(error).includes('BUSY_SNAPSHOT');
const isBusy = (error: unknown) => {
  const text = errorCode(error);
  return text.includes('SQLITE_BUSY') || text.includes('DATABASE IS LOCKED');
};

/**
 * Run a write against the transcripts database, surviving a concurrent writer.
 *
 * Retry granularity is one transaction, which is what makes this safe: SQLite guarantees a
 * failed `COMMIT` rolled back, so re-running the callback cannot double-write.
 *
 * `SQLITE_BUSY_SNAPSHOT` is handled differently from `SQLITE_BUSY` on purpose. It is permanent
 * for a connection pinned to a stale read snapshot -- no amount of waiting clears it, only a
 * reconnect does. PR #11 measured a fresh process writing in 71 ms while a long-lived job had
 * been failing on the same database for fourteen minutes.
 *
 * The client is passed to the callback rather than captured by it, and a caller must never
 * hold one across this boundary: a snapshot stall closes and replaces it, which would leave
 * any handle taken beforehand pointing at a closed connection.
 */
export async function withWriteRetry<T>(
  dbPath: string,
  run: (client: Client) => Promise<T>,
  options: { attempts?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 5;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const client = await openTranscriptDb(dbPath);
    try {
      return await run(client);
    } catch (error) {
      lastError = error;
      if (isSnapshotStall(error)) {
        await closeTranscriptDb(dbPath);
      } else if (isBusy(error)) {
        // busy_timeout already waited; a short extra pause lets the other writer's
        // transaction land rather than spinning against it.
        await new Promise(resolve => setTimeout(resolve, 25 * attempt));
      } else {
        throw error; // Not a lock. A constraint violation is a bug, not something to retry.
      }
    }
  }

  throw lastError;
}

export async function closeTranscriptDbs(): Promise<void> {
  const entries = [...clients.entries()];
  clients.clear();
  for (const [key, client] of entries) {
    if (key.startsWith('rw:')) {
      // Fold the WAL back in so the file is stable when this resolves -- Windows otherwise
      // holds the sidecars and a test's directory removal fails.
      await client.execute('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => {});
    }
    client.close();
  }
}
