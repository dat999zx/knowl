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
    updated_at TEXT NOT NULL
  );`,

  // No `body` column anywhere: a row is a pointer. The text stays in the .jsonl.
  `CREATE TABLE IF NOT EXISTS transcript_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    session_id TEXT NOT NULL,
    parent_session_id TEXT,
    line INTEGER NOT NULL,
    role TEXT NOT NULL,
    chars INTEGER NOT NULL,
    ts TEXT
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

const BASE_STATEMENTS = [
  // First, for the same reason as the knowledge database: journal_mode takes a lock, and a
  // connection's default busy_timeout is 0, so a concurrent writer would fail the open outright.
  'PRAGMA busy_timeout = 10000;',
  'PRAGMA journal_mode = WAL;',
];

const clients = new Map<string, Client>();

const keyFor = (dbPath: string, readOnly: boolean) => `${readOnly ? 'ro' : 'rw'}:${path.resolve(dbPath)}`;

/**
 * Open (and on a writable open, create) a transcripts database.
 *
 * A read-only open never bootstraps: it is used to search a linked workspace repo's index, and
 * reading a peer must not create or migrate anything it owns. `query_only` makes SQLite itself
 * enforce that rather than leaving it to convention.
 */
export async function openTranscriptDb(
  dbPath: string,
  options: { readOnly?: boolean } = {},
): Promise<Client> {
  const readOnly = options.readOnly === true;
  const key = keyFor(dbPath, readOnly);
  const existing = clients.get(key);
  if (existing) return existing;

  const client = createClient({ url: `file:${path.resolve(dbPath)}` });
  try {
    if (readOnly) {
      await client.execute('PRAGMA busy_timeout = 10000;');
      await client.execute('PRAGMA query_only = ON;');
    } else {
      for (const statement of BASE_STATEMENTS) await client.execute(statement);
      for (const statement of TRANSCRIPT_SCHEMA_STATEMENTS) await client.execute(statement);
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
