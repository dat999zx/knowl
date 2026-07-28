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

export async function releaseAll(): Promise<void> {
  for (const client of clients.values()) client.close();
  clients.clear();
}
