import { Client } from '@libsql/client';

/**
 * Bump on EVERY schema change, additive ones included.
 *
 * The old rule was the opposite -- additive columns did not need a bump, because an older
 * client simply ignores a column it does not know about. That reasoning was about READING a
 * newer database, and it was sound for that. It stopped being sound when this number became
 * the gate that decides whether to run the migration at all: a version cannot mean "up to
 * date" for the reader and "nothing to do" for the writer at the same time. An additive
 * column that does not bump the version is a migration the fast path will skip forever.
 *
 * The same applies to data backfills, which no schema comparison can represent at all.
 *
 * `tests/store/schema-pin.test.ts` enforces this: it hashes the schema a fresh bootstrap
 * produces and fails if that hash moves without this number moving. Nobody has to remember.
 */
export const KNOWL_SCHEMA_VERSION = 3;

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
