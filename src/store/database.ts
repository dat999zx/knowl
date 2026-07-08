import path from 'node:path';
import { createClient, Client } from '@libsql/client';
import { drizzle, LibSQLDatabase } from 'drizzle-orm/libsql';
import * as schema from './schema.js';
import { bootstrapSchema } from './bootstrap.js';
import { DatabaseError } from '../core/errors.js';

/** Shared type for database connection or transaction context. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DbConnection = LibSQLDatabase<typeof schema> | Parameters<Parameters<LibSQLDatabase<typeof schema>['transaction']>[0]>[0];

let dbInstance: LibSQLDatabase<typeof schema> | null = null;
let clientInstance: Client | null = null;
let projectRootInstance: string | null = null;

/**
 * Initializes the database connection and runs schema bootstrap.
 */
export async function initDb(projectRoot: string): Promise<LibSQLDatabase<typeof schema>> {
  const dbPath = path.join(projectRoot, '.knowl', 'knowl.db');
  const fileUrl = `file:${dbPath}`;

  try {
    const client = createClient({ url: fileUrl });
    clientInstance = client;

    // Run schema bootstrap SQL directly on the raw client
    await bootstrapSchema(client);

    dbInstance = drizzle(client, { schema });
    projectRootInstance = path.resolve(projectRoot);
    return dbInstance;
  } catch (error: any) {
    throw new DatabaseError(`Failed to initialize database at "${dbPath}": ${error.message}`);
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

export function getProjectRoot(): string {
  if (!projectRootInstance) {
    throw new DatabaseError('Project root has not been initialized. Run initDb() first.');
  }
  return projectRootInstance;
}

/**
 * Closes the database connection.
 */
export async function closeDb(): Promise<void> {
  if (clientInstance) {
    clientInstance.close();
    clientInstance = null;
    dbInstance = null;
    projectRootInstance = null;
  }
}
