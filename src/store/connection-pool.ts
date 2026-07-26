import path from 'node:path';
import { createClient, Client } from '@libsql/client';
import { bootstrapSchema } from './bootstrap.js';

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
  if (!readOnly) await bootstrapSchema(client);
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
