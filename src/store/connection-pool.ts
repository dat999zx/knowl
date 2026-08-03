import path from 'node:path';
import { createClient, Client } from '@libsql/client';
import { bootstrapSchema } from './bootstrap.js';
import { assertSchemaSupported } from './schema-version.js';

/**
 * Clients keyed by resolved path and open mode.
 *
 * Two problems. First, `withDbPath` closed and reopened the database twice per namespace
 * query, which is pure overhead that grows with the number of namespaces.
 *
 * Second, and the reason this exists: `bootstrapSchema` runs on every open and includes
 * `migrateLegacyProjectSchema`, which toggles foreign keys off and renames, copies and
 * drops tables outside a transaction. Reading a database therefore migrated it -- harmless
 * when you only ever open your own, disqualifying for reading anyone else's. A read-only
 * acquire suppresses bootstrap entirely.
 *
 * The mode is part of the key. Handing a bootstrapped client to a read-only caller would
 * defeat the guarantee, and handing an un-bootstrapped one to a writer would fail.
 */
const clients = new Map<string, Client>();

const keyFor = (dbPath: string, readOnly: boolean) =>
  `${readOnly ? 'ro' : 'rw'}:${path.resolve(dbPath)}`;

export async function acquireClient(
  dbPath: string,
  options: { readOnly?: boolean; profileFingerprint?: string | null } = {},
): Promise<Client> {
  const readOnly = options.readOnly === true;
  const key = keyFor(dbPath, readOnly);
  const existing = clients.get(key);
  if (existing) return existing;

  for (let attempt = 0; ; attempt++) {
    try {
      const client = await openClient(dbPath, readOnly, options.profileFingerprint ?? null);
      clients.set(key, client);
      return client;
    } catch (error) {
      // Opening runs bootstrap, which migrates and creates tables -- real writes, against a
      // database other live sessions are also writing to. A lock lost here is transient and
      // the whole command dies on it, so it is retried rather than surfaced. Not folded into
      // busy_timeout: some statements (schema changes among them) return BUSY without ever
      // consulting the busy handler, so waiting longer inside SQLite would not have helped.
      //
      // This waiting is only safe because the MCP handshake no longer sits behind it. On the
      // connect path it would be a bound of ~50s against the host's 30s deadline; behind the
      // handshake it is a slow first tool call under an hours-long timeout instead.
      const busy = /SQLITE_BUSY|database is locked|statements in progress/i.test(String((error as Error).message));
      if (!busy || attempt >= 4) throw error;
      await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
}

async function openClient(dbPath: string, readOnly: boolean, profileFingerprint: string | null): Promise<Client> {
  const client = createClient({ url: `file:${path.resolve(dbPath)}` });
  try {
    // Wait for a lock instead of failing on it. Knowl runs one process per connected session
    // plus whatever the user starts from a terminal, so concurrent writers to one database
    // are the normal case, not an edge one -- and SQLite's default busy handler gives up
    // instantly. Without this, a long job beside a live session dies on "database is locked"
    // the first time the two overlap, which is how a transcript backfill lost a whole pass.
    await client.execute('PRAGMA busy_timeout = 10000;');
    // A read-only open skips bootstrap, and the version guard lives inside bootstrap --
    // so without this it would skip the guard too, which is exactly backwards for the
    // case the guard matters most: reading a database someone else's Knowl wrote.
    if (readOnly) {
      // "Read-only" here is otherwise just a naming convention: this code path happens
      // not to call a write function. query_only makes SQLite itself refuse any write
      // this connection ever attempts, so a future bug can't silently mutate a peer
      // repo's database -- it fails loudly instead.
      await client.execute('PRAGMA query_only = ON;');
      await assertSchemaSupported(client, dbPath);
    } else {
      // The fingerprint comes from the caller, not from here: this layer knows a
      // database path, and the config that names the embedding profile belongs to a
      // project root a namespace database need not sit under.
      await bootstrapSchema(client, { profileFingerprint });
    }
  } catch (error) {
    // An un-closed client on a failed open keeps whatever lock its partial bootstrap
    // took, and nothing else in this process ever calls close() on it -- every later
    // acquire for this path would then contend against a lock this process itself is
    // still holding, for as long as the process lives.
    await client.close();
    throw error;
  }
  return client;
}

export function poolSize(): number {
  return clients.size;
}

/**
 * Close every pooled client, folding the write-ahead log back into the main file first.
 *
 * The schema sets `journal_mode = WAL` (`bootstrap.ts`), so a writable connection's changes
 * live in a `-wal` sidecar until a checkpoint moves them. `close()` alone does not guarantee
 * that has finished, which leaves the main database file still changing after this function
 * returns. Two symptoms came from it: several suites had to tolerate a failed directory
 * removal because Windows still held the sidecars, and a byte-comparison test on a
 * read-only peer open failed under load when the checkpoint landed between its two reads.
 *
 * Checkpointing explicitly makes the file stable at the moment this resolves. `TRUNCATE`
 * rather than `PASSIVE` because the point is to leave nothing behind. Read-only clients are
 * skipped: `query_only` refuses the pragma, and they wrote nothing to fold in.
 *
 * Failures are swallowed deliberately -- the client is being discarded either way, and an
 * un-checkpointable database must not turn closing into an error.
 */
export async function releaseAll(): Promise<void> {
  const entries = [...clients.entries()];
  clients.clear();
  for (const [key, client] of entries) {
    if (key.startsWith('rw:')) {
      try {
        await client.execute('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        // Already closed, locked by another process, or not in WAL. Closing regardless.
      }
    }
    client.close();
  }
}
