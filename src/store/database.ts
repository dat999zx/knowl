import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Client } from '@libsql/client';
import { drizzle, LibSQLDatabase } from 'drizzle-orm/libsql';
import * as schema from './schema.js';
import { DatabaseError } from '../core/errors.js';
import { resolveStorage } from './storage-roles.js';
import { acquireClient, releaseAll, releaseClient } from './connection-pool.js';

/** Shared type for database connection or transaction context. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DbConnection = LibSQLDatabase<typeof schema> | Parameters<Parameters<LibSQLDatabase<typeof schema>['transaction']>[0]>[0];

let dbInstance: LibSQLDatabase<typeof schema> | null = null;
let clientInstance: Client | null = null;
let projectRootInstance: string | null = null;
let configRootInstance: string | null = null;
let databasePathInstance: string | null = null;

export type InitDbOptions = {
  /**
   * Directory whose `.knowl/config.json` and `.knowl/models` govern this connection.
   *
   * Deriving it from the database path only holds for the `<root>/.knowl/x.db` layout. A
   * namespace database anywhere else yielded a nonsense root, `loadConfig` threw, and the
   * embedding writer's best-effort catch turned that into a silent no-op -- storing items
   * with no vector that vector-first ranking can then never surface.
   */
  configRoot?: string;
};

/**
 * The embedding profile this project is configured for, or null when config is unreadable.
 *
 * Only the one-time `profile_fingerprint` backfill uses it, so an unreadable config must
 * not fail the open: a database that will not bootstrap because config.json has a typo is
 * a far worse outcome than embedding rows left NULL until the next reindex.
 */
async function currentProfileFingerprint(configRoot: string): Promise<string | null> {
  try {
    const [{ loadConfig }, { fingerprintProfile, resolveVectorProfile }] = await Promise.all([
      import('../core/config.js'),
      import('../core/vector-profile.js'),
    ]);
    return fingerprintProfile(resolveVectorProfile(await loadConfig(configRoot)));
  } catch {
    return null;
  }
}

/**
 * Initializes the database connection and runs schema bootstrap.
 */
export async function initDb(projectRoot: string): Promise<LibSQLDatabase<typeof schema>> {
  return initDbPath(resolveStorage(projectRoot).knowledge, { configRoot: projectRoot });
}

export async function initDbPath(dbPath: string, options: InitDbOptions = {}): Promise<LibSQLDatabase<typeof schema>> {
  const fileUrl = `file:${dbPath}`;
  const configRoot = options.configRoot ?? path.dirname(path.dirname(dbPath));

  try {
    // Pooled: the same path is not reopened, and bootstrap runs once per file rather than
    // on every namespace swap.
    const client = await acquireClient(dbPath, {
      profileFingerprint: await currentProfileFingerprint(configRoot),
    });
    clientInstance = client;

    dbInstance = drizzle(client, { schema });
    projectRootInstance = path.resolve(configRoot);
    configRootInstance = path.resolve(configRoot);
    databasePathInstance = path.resolve(dbPath);
    return dbInstance;
  } catch (error: any) {
    throw new DatabaseError(`Failed to initialize database at "${dbPath}": ${error.message}`);
  }
}

/**
 * Run `run` against a different database, then put the previous one back.
 *
 * This is a swap of the *active handle*, not a shutdown, and it used to be written as one:
 * `closeDb` on the way in and again on the way out, each of which releases the entire pool and
 * WAL-checkpoints every writable client in it. A hop to the session namespace therefore closed
 * the project connection, and coming back reopened and re-bootstrapped it -- so a layered query
 * over two namespaces paid four opens, and the pool was empty again at the end of every one.
 * `queryLayeredKnowledge` walks every namespace on every agent query, inside a long-lived MCP
 * server, so this was the pool being defeated on each hop rather than in some edge case.
 *
 * Both databases stay pooled afterwards: the next hop is then free. Nothing is left holding a
 * file that `closeDb` would not have released anyway -- it is still the teardown primitive, and
 * still releases everything.
 */
export async function withDbPath<T>(dbPath: string, run: () => Promise<T>): Promise<T> {
  const previousPath = databasePathInstance;
  const previousConfigRoot = configRootInstance;
  // The swapped-in database keeps the caller's config root. A namespace store lives outside
  // the `<root>/.knowl/` layout, so deriving one from its path would point at nothing.
  await initDbPath(dbPath, previousConfigRoot ? { configRoot: previousConfigRoot } : {});
  try {
    return await run();
  } finally {
    if (previousPath) {
      // Pooled, so this is a handle swap rather than an open.
      await initDbPath(previousPath, previousConfigRoot ? { configRoot: previousConfigRoot } : {});
    } else {
      // Nothing was open before, so leaving this one open would be a handle the caller never
      // asked for. Only this database is released; whatever else the pool holds is not ours.
      await releaseClient(dbPath);
      clientInstance = null;
      dbInstance = null;
      projectRootInstance = null;
      configRootInstance = null;
      databasePathInstance = null;
    }
  }
}

/**
 * The one transaction in flight on the shared connection, and the queue of the rest.
 *
 * `BEGIN` belongs to the *connection*, and this process holds exactly one. Two transactions
 * started while the other was open therefore interleaved into `BEGIN; BEGIN;` and SQLite
 * refused the second with `cannot start a transaction within a transaction`. That is
 * `SQLITE_ERROR`, not `SQLITE_BUSY`, so no retry anywhere recognises it, and the caller sees
 * an intermittently failed write whose timing it cannot reproduce. Reproduced with two
 * `withClientTransaction` calls in flight, and with an ordinary write racing `knowl gc`.
 *
 * The queue is a promise chain rather than a lock library: a caller waits on whoever was ahead
 * of it, and hands the baton on in `finally` so a thrown transaction cannot strand the rest.
 * `getClient`/`getDb` resolve *after* the wait, so a queued caller transacts against whatever
 * connection is open when its turn comes rather than one captured before a namespace swap.
 */
const transactionScope = new AsyncLocalStorage<true>();
let transactionQueue: Promise<unknown> = Promise.resolve();

/**
 * A transaction on the raw client rather than through Drizzle's wrapper.
 *
 * `drizzle-orm@0.45.2`'s libSQL `transaction()` leaks native state per transaction and the
 * process dies at exit once enough have accumulated. Re-measured on 2026-08-04 (node 24.13,
 * @libsql/client 0.14, same rows, same table, same connection):
 *
 * | shape                                        | transactions | result   |
 * | -------------------------------------------- | ------------ | -------- |
 * | 1 statement x 800 drizzle transactions       | 800          | clean    |
 * | 2 statements x 800 drizzle transactions      | 800          | clean    |
 * | 2 statements x 1000 drizzle transactions     | 1000         | segfault |
 * | 1 statement x 1200 drizzle transactions      | 1200         | segfault |
 * | 1 statement x 2400 drizzle transactions      | 2400         | segfault |
 * | 10,000 statements in ONE drizzle transaction | 1            | clean    |
 * | 2 statements x 1200, BEGIN/COMMIT            | 1200         | clean    |
 *
 * An earlier table here read this as "statements *within* a transaction" and recorded
 * `1 statement x 2400 transactions` as clean. It is not: single-statement transactions die
 * too, and one transaction holding ten thousand statements does not. The variable is the
 * **count of `db.transaction()` calls**, and the threshold sits between 800 and 1000. That
 * matters because the old reading implied a big single transaction was the dangerous shape and
 * many small ones were safe, which is exactly backwards. Going through the client instead of
 * the wrapper avoids it entirely. 0.45.2 is the latest release, so there is no upgrade to take.
 *
 * A SQLite transaction belongs to the connection, so statements issued on the base connection
 * between BEGIN and COMMIT are inside it. Callers therefore get the ordinary connection back
 * rather than a transaction object, and the code inside them is unchanged.
 *
 * **Not nestable, deliberately.** Callers skip this entirely when an outer transaction hands
 * them a connection, so it only ever opens the outermost. Under a queue a nested call would
 * wait on the outer transaction that is waiting on it, so nesting is detected and raised
 * immediately: a deadlock is strictly worse than the error it replaces.
 */
export async function withClientTransaction<T>(run: (conn: DbConnection) => Promise<T>): Promise<T> {
  if (transactionScope.getStore()) {
    throw new DatabaseError(
      'withClientTransaction cannot be nested: pass the connection it hands you down to the inner write instead.',
    );
  }

  const previous = transactionQueue;
  let release!: () => void;
  transactionQueue = new Promise<void>(resolve => { release = resolve; });
  // A predecessor that threw has already finished with the connection; its error is its
  // caller's problem, not a reason to refuse the next transaction.
  await previous.catch(() => {});

  try {
    return await transactionScope.run(true, async () => {
      const client = getClient();
      const db = getDb();
      await client.execute('BEGIN');
      try {
        const result = await run(db);
        await client.execute('COMMIT');
        return result;
      } catch (error) {
        // A failed rollback must not mask the error that caused it.
        await client.execute('ROLLBACK').catch(() => {});
        throw error;
      }
    });
  } finally {
    release();
  }
}

/**
 * Gets the current database instance. Throws if not initialized.
 */
export function getDb(): LibSQLDatabase<typeof schema> {
  if (!dbInstance) {
    throw new DatabaseError('Database has not been initialized. Run initDb() first.');
  }
  return dbInstance;
}

export function getClient(): Client {
  if (!clientInstance) {
    throw new DatabaseError('Database has not been initialized. Run initDb() first.');
  }
  return clientInstance;
}

export function getProjectRoot(): string {
  if (!projectRootInstance) {
    throw new DatabaseError('Project root has not been initialized. Run initDb() first.');
  }
  return projectRootInstance;
}

/**
 * The directory whose `.knowl/config.json` and `.knowl/models` govern the open database.
 *
 * Distinct from the database's own location: a namespace or shared store sits outside any
 * `<root>/.knowl/` layout, and config still has to come from the project the caller is
 * working in.
 */
export function getConfigRoot(): string {
  if (!configRootInstance) {
    throw new DatabaseError('Config root has not been initialized. Run initDb() first.');
  }
  return configRootInstance;
}

/**
 * Closes the database connection.
 */
export async function closeDb(): Promise<void> {
  if (clientInstance) {
    // Release the whole pool, not just the active handle. Tests and CLI commands delete
    // their project directory after closing, and a client still holding the file would
    // keep the WAL sidecars open.
    await releaseAll();
    clientInstance = null;
    dbInstance = null;
    projectRootInstance = null;
    configRootInstance = null;
    databasePathInstance = null;
  }
}
