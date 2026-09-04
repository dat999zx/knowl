import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Client } from '@libsql/client';
import { drizzle, LibSQLDatabase } from 'drizzle-orm/libsql';
import * as schema from './schema.js';
import { DatabaseError } from '../core/errors.js';
import { resolveStorage } from './storage-roles.js';
import { acquireClient, releaseAll, releaseClient } from './connection-pool.js';
import { knowlHome } from '../core/paths.js';

/** Shared type for database connection or transaction context. */
export type DbConnection = LibSQLDatabase<typeof schema> | Parameters<Parameters<LibSQLDatabase<typeof schema>['transaction']>[0]>[0];

type DbContext = {
  db: LibSQLDatabase<typeof schema>;
  client: Client;
  projectRoot: string;
  configRoot: string;
  databasePath: string;
};

/**
 * Which database the *current* async operation is using.
 *
 * `withDbPath` used to swap five process-global variables for the duration of a callback. Two
 * MCP requests overlapping a namespace switch is not hypothetical -- the stdio server does not
 * serialize requests, and a project write issued during an open switch landed in the session
 * database, silently, with no error anywhere. A scoped store gives each async chain its own
 * handle, so no call site has to thread one through.
 */
const scopedContext = new AsyncLocalStorage<DbContext>();
let globalContext: DbContext | null = null;

function activeContext(): DbContext | null {
  return scopedContext.getStore() ?? globalContext;
}

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
  const configRoot = options.configRoot ?? path.dirname(path.dirname(dbPath));

  try {
    // Pooled: the same path is not reopened, and bootstrap runs once per file rather than
    // on every namespace swap.
    const client = await acquireClient(dbPath, {
      profileFingerprint: await currentProfileFingerprint(configRoot),
    });
    globalContext = {
      db: drizzle(client, { schema }),
      client,
      projectRoot: path.resolve(configRoot),
      configRoot: path.resolve(configRoot),
      databasePath: path.resolve(dbPath),
    };
    return globalContext.db;
  } catch (error: any) {
    throw new DatabaseError(`Failed to initialize database at "${dbPath}": ${error.message}`);
  }
}

/**
 * Run `run` against a different database, without disturbing anyone else's.
 *
 * This is a swap of the *active handle*, not a shutdown, and it used to be written as one:
 * `closeDb` on the way in and again on the way out, each of which releases the entire pool and
 * WAL-checkpoints every writable client in it. `queryLayeredKnowledge` walks every namespace on
 * every agent query, inside a long-lived MCP server, so that was the pool being defeated on each
 * hop rather than in some edge case.
 *
 * The swap is now scoped rather than global. Reassigning the module handle made the switch
 * visible to every concurrent operation in the process, so a write issued against the project
 * during a session-namespace hop was executed against the session database. Both databases stay
 * pooled afterwards: the next hop is then free.
 */
export async function withDbPath<T>(
  dbPath: string,
  run: () => Promise<T>,
  options?: { configRoot?: string },
): Promise<T> {
  const previous = activeContext();
  // The swapped-in database keeps the caller's config root. A namespace store lives outside
  // the `<root>/.knowl/` layout, so deriving one from its path would point at nothing.
  const isHomeDb = path.resolve(path.dirname(dbPath)) === path.resolve(knowlHome());
  const configRoot = options?.configRoot ?? (isHomeDb ? knowlHome() : (previous ? previous.configRoot : path.dirname(path.dirname(dbPath))));
  const client = await acquireClient(dbPath, {
    profileFingerprint: await currentProfileFingerprint(configRoot),
  });
  const context: DbContext = {
    db: drizzle(client, { schema }),
    client,
    projectRoot: path.resolve(configRoot),
    configRoot: path.resolve(configRoot),
    databasePath: path.resolve(dbPath),
  };
  try {
    return await scopedContext.run(context, run);
  } finally {
    // Nothing was open before, so leaving this one pooled would be a handle the caller never
    // asked for. Only this database is released; whatever else the pool holds is not ours.
    if (!previous) await releaseClient(dbPath);
  }
}

/**
 * Run `run` as though the process had started in `projectRoot`.
 *
 * `withDbPath` deliberately keeps the CALLER's config root, because the stores it was built for
 * -- namespace databases -- live outside any `<root>/.knowl/` layout and deriving one from their
 * path would point at nothing. For another REPO that behaviour is exactly wrong: the config root
 * is what `resolveWriteDefaults` reads to stamp `origin_repo`, what auto-staging reads to find a
 * cloud pointer, and what secret patterns are loaded from. A swap that moved only the database
 * would write into the target repo and stamp it with the caller's name.
 *
 * So this swaps both, together. Nothing downstream is told about it and nothing needs to be:
 * ownership stamping, auto-staging, the cloud pointer and `assertOwnedItem` all read the ambient
 * context, so each of them follows the target repo by construction rather than by remembering.
 * That is the same reason `cd` has always worked for the CLI, expressed for a server that cannot
 * change directory.
 *
 * Scoped through `AsyncLocalStorage` like `withDbPath`, and for the same reason: reassigning the
 * module handle made a swap visible to every concurrent operation in the process, so a write
 * issued against one database during another's hop executed against the wrong file.
 */
export async function withRepoRoot<T>(projectRoot: string, run: () => Promise<T>): Promise<T> {
  const previous = activeContext();
  const dbPath = resolveStorage(projectRoot).knowledge;
  const client = await acquireClient(dbPath, {
    profileFingerprint: await currentProfileFingerprint(projectRoot),
  });
  const context: DbContext = {
    db: drizzle(client, { schema }),
    client,
    projectRoot: path.resolve(projectRoot),
    configRoot: path.resolve(projectRoot),
    databasePath: path.resolve(dbPath),
  };
  try {
    return await scopedContext.run(context, run);
  } finally {
    // Same rule as `withDbPath`: a database nothing had open before this call is not one the
    // caller asked to keep pooled.
    if (!previous) await releaseClient(dbPath);
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
 *
 * The queue is process-wide even though handles are now scoped per async context. Two
 * transactions on genuinely different connections therefore wait on each other unnecessarily.
 * That is deliberate: the cost is serialization the local CLI and a single MCP server never
 * notice, and the alternative -- a queue per connection -- has to be right about which
 * connection a queued caller will resolve *after* its wait, which is exactly the reasoning
 * that produced the misrouting bug this scoping fixes.
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
      // IMMEDIATE, never a bare (DEFERRED) BEGIN. Every caller of this helper writes, and a
      // deferred transaction takes its write lock lazily -- on the first write, after reads have
      // already run. SQLite answers that upgrade with SQLITE_BUSY_SNAPSHOT rather than waiting,
      // because the reader's snapshot is already stale; no busy handler may wait it out, so
      // `PRAGMA busy_timeout` does not apply and the retry in connection-pool.ts does not match
      // it. The write simply failed. Measured across processes on one store: 20 concurrent
      // writes lost 0 through one server, 10 through two, 14 through three.
      //
      // IMMEDIATE takes the write lock up front, which IS waitable, so contention becomes a
      // wait bounded by busy_timeout instead of an error. `bootstrapSchema` already did this
      // for the same reason (bootstrap.ts) -- the rule was stated there and not applied here.
      await client.execute('BEGIN IMMEDIATE');
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
  const context = activeContext();
  if (!context) throw new DatabaseError('Database has not been initialized. Run initDb() first.');
  return context.db;
}

export function getClient(): Client {
  const context = activeContext();
  if (!context) throw new DatabaseError('Database has not been initialized. Run initDb() first.');
  return context.client;
}

export function getProjectRoot(): string {
  const context = activeContext();
  if (!context) throw new DatabaseError('Project root has not been initialized. Run initDb() first.');
  return context.projectRoot;
}

/**
 * The directory whose `.knowl/config.json` and `.knowl/models` govern the open database.
 *
 * Distinct from the database's own location: a namespace or shared store sits outside any
 * `<root>/.knowl/` layout, and config still has to come from the project the caller is
 * working in.
 */
export function getConfigRoot(): string {
  const context = activeContext();
  if (!context) throw new DatabaseError('Config root has not been initialized. Run initDb() first.');
  return context.configRoot;
}

/**
 * Closes the database connection.
 */
export async function closeDb(): Promise<void> {
  if (globalContext) {
    // Release the whole pool, not just the active handle. Tests and CLI commands delete
    // their project directory after closing, and a client still holding the file would
    // keep the WAL sidecars open.
    await releaseAll();
    globalContext = null;
  }
}
