import { Client } from '@libsql/client';

/**
 * Bump when a schema change makes a database unreadable by older clients.
 *
 * Additive columns do not need a bump -- an older client ignores them. A bump is for
 * changes that would make an older client corrupt or misread the data: a primary key
 * change, a table rebuild, or a column an older writer would leave NULL where a newer
 * reader requires a value.
 */
export const KNOWL_SCHEMA_VERSION = 1;

export class SchemaTooNewError extends Error {
  constructor(dbPath: string, found: number, supported: number) {
    super(
      `The knowledge database at "${dbPath}" was written by a newer Knowl (schema ${found}); ` +
      `this build understands schema ${supported}. Upgrade Knowl to open it.`,
    );
    this.name = 'SchemaTooNewError';
  }
}

export async function readSchemaVersion(client: Client): Promise<number> {
  const result = await client.execute('PRAGMA user_version');
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return Number(row?.user_version ?? 0);
}

export async function stampSchemaVersion(client: Client): Promise<void> {
  // Every rw open runs this. Writing unconditionally means several processes racing to
  // bootstrap the same file each take a header-write lock even when nothing changed.
  if ((await readSchemaVersion(client)) === KNOWL_SCHEMA_VERSION) return;
  // PRAGMA does not accept bound parameters, and the value is a module constant.
  await client.execute(`PRAGMA user_version = ${KNOWL_SCHEMA_VERSION}`);
}

/**
 * Refuse rather than proceed.
 *
 * The schema is built from `CREATE TABLE IF NOT EXISTS` plus additive `ALTER`s, so an older
 * client opening a newer database sees every table it expects and finds nothing missing. It
 * then proceeds confidently and writes rows the newer schema's invariants do not hold for.
 * Nothing reports that, which is why this has to exist before any database is reachable by
 * two Knowl versions -- a guard added afterwards has nothing left to guard.
 */
export async function assertSchemaSupported(client: Client, dbPath: string): Promise<void> {
  const found = await readSchemaVersion(client);
  if (found > KNOWL_SCHEMA_VERSION) throw new SchemaTooNewError(dbPath, found, KNOWL_SCHEMA_VERSION);
}
