import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Client } from '@libsql/client';
import { drizzle, LibSQLDatabase } from 'drizzle-orm/libsql';
import * as schema from './schema.js';
import { DatabaseError } from '../core/errors.js';
import { resolveStorage } from './storage-roles.js';
import { acquireClient, releaseAll, releaseClient } from './connection-pool.js';
import { knowlHome, globalStorePath } from '../core/paths.js';

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
/** Whether this root IS the machine home, whose store is `global.db` rather than a project db. */
export function isKnowlHome(root: string): boolean {
  return path.resolve(root) === path.resolve(knowlHome());
}

/**
 * The knowledge database a project root is addressed by.
 *
 * The machine home is not a project, and its knowledge lives in `global.db` BESIDE the config
 * rather than in `.knowl/knowl.db` beneath it. `loadConfig` already makes exactly this
 * substitution for exactly this root (`src/core/config.ts`), so without the matching one here
 * a caller handing the home to both gets a config from one place and a database from another
 * -- in practice `~/.knowl/.knowl/knowl.db`, which is nobody's store and fails to open.
 *
 * This is what lets the machine store be addressed the way a project is: `cloud push --global`
 * resolves a root, and everything downstream opens the right file with no further argument.
 * Shared by `initDb` and `openProjectScope` so the ambient and the scoped route to a project
 * cannot disagree about which file it is.
 */
function projectDatabasePath(projectRoot: string): string {
  return isKnowlHome(projectRoot) ? globalStorePath() : resolveStorage(projectRoot).knowledge;
}

export async function initDb(projectRoot: string): Promise<LibSQLDatabase<typeof schema>> {
  return initDbPath(projectDatabasePath(projectRoot), { configRoot: projectRoot });
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
    throw new DatabaseError(`Failed to initialize database at "${dbPath}": ${error.message}`, { cause: error });
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
 * A project held open by ONE consumer, with no claim on the process-wide context.
 *
 * `initDb` writes to a single module-global handle, and `getDb`/`getClient` read it. That is
 * correct for every consumer shipped today, because every one of them opens exactly one project
 * per process: the CLI is one-shot, and the MCP server binds a project at startup and hops
 * namespaces with `withDbPath`. It is silently wrong the moment two projects are open at once.
 * Reproduced 2026-09-05: `initDb(A)` then `initDb(B)` in one process, and a write issued by the
 * caller that thought it held A landed in B's file -- A's store empty, B's holding A's row, no
 * error and no log line anywhere. `closeDb` compounds it, because it calls `releaseAll`: the
 * first consumer to finish tore down every other consumer's connection, and the survivors got
 * `Database has not been initialized` from a call they had made correctly.
 *
 * A scope is the pair that fixes both. `run` executes its body inside the same
 * `AsyncLocalStorage` the namespace hop already uses, so the ambient reads every repository
 * function does resolve to THIS project rather than to whoever opened last -- the same mechanism
 * `withDbPath` and `withRepoRoot` were given for the same class of bug one level down. `release`
 * maps to `releaseClient`, which finishes with one database and leaves the pool alone.
 *
 * Additive on purpose. The global handle is untouched: nothing here assigns `globalContext`, so
 * a scope opened beside a live CLI or server is invisible to it, and `initDb`/`closeDb` keep
 * behaving exactly as they did. What this unblocks is the in-process library export, where a
 * long-running gateway holds several workspaces open in one address space and the subprocess
 * boundary that has been hiding the defect is gone.
 */
export type ProjectScope = {
  /** The project root this scope resolves config and ownership from. */
  readonly projectRoot: string;
  /** The database file this scope's writes reach. */
  readonly databasePath: string;
  /** Run `body` with this project ambient, whatever else the process has open. */
  run<T>(body: () => Promise<T>): Promise<T>;
  /** Done with this project. Idempotent, and never touches another scope's connection. */
  release(): Promise<void>;
};

/**
 * How many scopes are holding each database open.
 *
 * Two sessions in one folder is the ordinary case for a gateway, not an edge one, and the pool
 * is keyed by path -- so both scopes are handed the same client and the first to release would
 * close the connection the second is still using. Counted rather than deduplicated because the
 * scopes are genuinely independent: neither knows the other exists, and either may outlive it.
 *
 * A path the ambient context is also using is never released here at all. `initDb` put that
 * client in the pool for the whole process, and closing it because a scope finished would break
 * the CLI or server that opened it -- the same tearing-down this type exists to stop, in the
 * other direction.
 */
const scopeHolders = new Map<string, number>();

export async function openProjectScope(projectRoot: string): Promise<ProjectScope> {
  const root = path.resolve(projectRoot);
  const dbPath = path.resolve(projectDatabasePath(root));

  const client = await acquireClient(dbPath, {
    profileFingerprint: await currentProfileFingerprint(root),
  });
  scopeHolders.set(dbPath, (scopeHolders.get(dbPath) ?? 0) + 1);

  const context: DbContext = {
    db: drizzle(client, { schema }),
    client,
    projectRoot: root,
    configRoot: root,
    databasePath: dbPath,
  };

  let released = false;
  return {
    projectRoot: root,
    databasePath: dbPath,
    run: <T>(body: () => Promise<T>): Promise<T> => {
      if (released) {
        throw new DatabaseError(`Project scope for "${root}" has been released. Open a new one.`);
      }
      return scopedContext.run(context, body);
    },
    release: async (): Promise<void> => {
      // Idempotent because a consumer's own teardown path is rarely the only one: a gateway
      // releases on shutdown and on error, and a second release must not decrement a count
      // some other scope is relying on.
      if (released) return;
      released = true;
      const holders = (scopeHolders.get(dbPath) ?? 1) - 1;
      if (holders > 0) {
        scopeHolders.set(dbPath, holders);
        return;
      }
      scopeHolders.delete(dbPath);
      if (globalContext && globalContext.databasePath === dbPath) return;
      await releaseClient(dbPath);
    },
  };
}

/**
 * Open a project, run one body against it, and release it.
 *
 * The shape most callers want: `openProjectScope` exists for a consumer that keeps a project
 * warm across many calls, and a caller doing one piece of work in another project should not
 * have to get the `finally` right to avoid leaking a connection.
 */
export async function withProjectScope<T>(projectRoot: string, run: () => Promise<T>): Promise<T> {
  const scope = await openProjectScope(projectRoot);
  try {
    return await scope.run(run);
  } finally {
    await scope.release();
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
 *
 * Process-wide, deliberately: this is the shutdown of the store, and its counterpart is
 * `initDb` rather than `openProjectScope`. A consumer holding scopes therefore must not call
 * it -- `release()` is that consumer's teardown, and it closes one database rather than the
 * pool. Same rule the MCP server already follows, stated here because a scope makes it
 * reachable from a second kind of caller.
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
