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

export async function acquireClient(dbPath: string, options: { readOnly?: boolean } = {}): Promise<Client> {
  const readOnly = options.readOnly === true;
  const key = keyFor(dbPath, readOnly);
  const existing = clients.get(key);
  if (existing) return existing;

  const client = createClient({ url: `file:${path.resolve(dbPath)}` });
  try {
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
      await bootstrapSchema(client);
    }
  } catch (error) {
    // An un-closed client on a failed open keeps whatever lock its partial bootstrap
    // took, and nothing else in this process ever calls close() on it -- every later
    // acquire for this path would then contend against a lock this process itself is
    // still holding, for as long as the process lives.
    await client.close();
    throw error;
  }
  clients.set(key, client);
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
