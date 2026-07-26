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
