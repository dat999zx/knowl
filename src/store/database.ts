import path from 'node:path';
import { Client } from '@libsql/client';
import { drizzle, LibSQLDatabase } from 'drizzle-orm/libsql';
import * as schema from './schema.js';
import { DatabaseError } from '../core/errors.js';
import { resolveStorage } from './storage-roles.js';
import { acquireClient, releaseAll } from './connection-pool.js';

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
    const client = await acquireClient(dbPath);
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

export async function withDbPath<T>(dbPath: string, run: () => Promise<T>): Promise<T> {
  const previousPath = databasePathInstance;
  const previousConfigRoot = configRootInstance;
  await closeDb();
  // The swapped-in database keeps the caller's config root. A namespace store lives outside
  // the `<root>/.knowl/` layout, so deriving one from its path would point at nothing.
  await initDbPath(dbPath, previousConfigRoot ? { configRoot: previousConfigRoot } : {});
  try {
    return await run();
  } finally {
    await closeDb();
    if (previousPath) await initDbPath(previousPath, previousConfigRoot ? { configRoot: previousConfigRoot } : {});
  }
}

/**
 * A transaction on the raw client rather than through Drizzle's wrapper.
 *
 * `drizzle-orm@0.45.2`'s libSQL `transaction()` leaks native state for every statement past the
 * first inside one transaction, and the process dies at exit once enough have accumulated.
 * Measured, all writing the same rows to the same table on the same connection:
 *
 * | shape                              | total inserts | result   |
 * | ---------------------------------- | ------------- | -------- |
 * | 1 statement x 2400 transactions    | 2400          | clean    |
 * | 2 statements x 1200 transactions   | 2400          | segfault |
 * | 2 statements x 1200, BEGIN/COMMIT  | 2400          | clean    |
 *
 * So it is neither statement count nor transaction count -- it is statements *within* a
 * transaction, and going through the client instead of the wrapper avoids it entirely. Knowl
 * writes an item and its assertion together, so every knowledge write is a two-statement
 * transaction and a long-running writer died at roughly 1200 of them. 0.45.2 is the latest
 * release, so there is no upgrade to take.
 *
 * A SQLite transaction belongs to the connection, so statements issued on the base connection
 * between BEGIN and COMMIT are inside it. Callers therefore get the ordinary connection back
 * rather than a transaction object, and the code inside them is unchanged.
 *
 * **Not nestable, deliberately.** Both callers skip this entirely when an outer transaction
 * hands them a connection, so it only ever opens the outermost. Adding a savepoint layer would
 * mean reimplementing the driver code this exists to avoid.
 */
export async function withClientTransaction<T>(run: (conn: DbConnection) => Promise<T>): Promise<T> {
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
