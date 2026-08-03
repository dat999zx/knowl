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
