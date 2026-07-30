import { Client } from '@libsql/client';
import { drizzle, LibSQLDatabase } from 'drizzle-orm/libsql';
import * as schema from './schema.js';
import { getClient, getDb } from './database.js';
import { acquireClient } from './connection-pool.js';

/**
 * One database, in both the shapes the read path needs.
 *
 * `search.ts` and `queries.ts` use the Drizzle instance; `vector.ts` uses the raw client. A
 * single parameter has to carry both, or half the retrieval path stays pinned to the global.
 *
 * This exists so retrieval can run against a linked repo without swapping the caller's
 * connection. `src/workspace/federated-query.ts` re-implemented candidate selection and scoring
 * for exactly that reason, and the two drifted: peers were selected by a raw LIKE scan and
 * scored without any of the recency, confidence, freshness or category boosts local items get.
 */
export type StoreHandle = {
  db: LibSQLDatabase<typeof schema>;
  client: Client;
};

/**
 * The ambient database.
 *
 * Resolved on call, never captured at module load: `getDb`/`getClient` throw when nothing is
 * open, and every caller relies on that throw happening at call time.
 */
export function localStore(): StoreHandle {
  return { db: getDb(), client: getClient() };
}

/**
 * A linked repo's database, read-only.
 *
 * `query_only = ON` makes SQLite itself refuse every write this connection attempts, and the
 * read-only acquire skips bootstrap -- which would otherwise migrate a database this process
 * does not own. Both are properties of the connection rather than of the query, which is why
 * the ranking code needs no notion of "peer" at all: it is the same code, pointed at a
 * different file.
 */
export async function openPeerStore(databasePath: string): Promise<StoreHandle> {
  const client = await acquireClient(databasePath, { readOnly: true });
  return { db: drizzle(client, { schema }), client };
}
