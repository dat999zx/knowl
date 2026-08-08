import { Client } from '@libsql/client';

/**
 * Bump ONLY when a schema change makes a database unreadable by older clients.
 *
 * Additive columns and new tables do not need a bump -- an older client ignores them. A bump
 * is for changes that would make an older client corrupt or misread the data: a primary key
 * change, a table rebuild, or a column an older writer would leave NULL where a newer reader
 * requires a value.
 *
 * **This is a compatibility floor, not a changelog.** `assertSchemaSupported` refuses any
 * database stamped higher than the running build, so every bump locks out every Knowl
 * already installed. That is the correct answer to a breaking change and the wrong answer
 * to an added column -- see `KNOWL_MIGRATION_LEVEL`, which is what the migration gate reads.
 *
 * The audit branch reached the opposite rule -- bump on every change -- and it was right
 * about the problem and wrong about which number solves it. Its reasoning was that a version
 * cannot mean "up to date" for the reader and "nothing to do" for the writer at the same
 * time, and that an additive column which does not bump is a migration the fast path skips
 * forever. Both halves are true. The resolution is two numbers rather than one: this stays a
 * floor and `KNOWL_MIGRATION_LEVEL` carries the changelog, so `knowledge_commit_items` gets
 * its migration without locking every 2.16 and 2.17 install out of its own database.
 */
export const KNOWL_SCHEMA_VERSION = 1;

/**
 * Bump on EVERY schema change, additive ones and data backfills included.
 *
 * This is the number `bootstrapSchema` gates on, and the two jobs genuinely differ: one
 * number answers "can an older build read this file", the other answers "has this build's
 * migration run here yet". Collapsing them forces a false choice -- either additive changes
 * stop bumping, and every existing database skips them forever, or they do bump, and every
 * release locks out every prior install over a column it would have ignored anyway.
 *
 * Stored in `PRAGMA application_id`, a second 4-byte header field. Same O(1) lock-free read
 * as `user_version` in WAL, and older builds never read it, so raising it is invisible to
 * them -- which is exactly the property `user_version` cannot have.
 *
 * Level 0 means "written before the gate existed", so every database predating it migrates
 * once. `tests/store/schema-pin.test.ts` hashes the schema a fresh bootstrap produces and
 * fails if that hash moves without this number moving. Nobody has to remember.
 *
 * Level 2 adds `knowledge_commit_items` and its covering index, and backfills it from every
 * commit already on disk (`backfillCommitItems`). Purely additive, so `KNOWL_SCHEMA_VERSION`
 * stays where it is and no older build is locked out.
 *
 * Level 3 adds `work_read_sets` and `impact_findings` with their four indexes -- the read-set
 * and impact-record substrate for change-impact detection. Two new tables, no altered column
 * and no backfill, which is why it is a level bump and not a version one: an older build opens
 * this database, finds every table it knows about intact, and never looks at these two. What
 * the bump buys is that a database created before them still gets them, since the gate is the
 * only thing that decides whether `SCHEMA_STATEMENTS` runs at all.
 */
/*
 * Level 4 adds `impact_gate_shadow` and its unique index on `finding_id` -- what an enforcing
 * write gate would have refused, recorded while it refuses nothing, so the certain tier's
 * precision can be measured before anything is allowed to block. Additive on exactly the same
 * reasoning as level 3: one new table, no altered column, no backfill, so `KNOWL_SCHEMA_VERSION`
 * stays at 1 and no installed build is locked out of a database it can still read completely.
 */
export const KNOWL_MIGRATION_LEVEL = 4;

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

/** 0 on any database written before the gate existed, which is what makes it migrate once. */
export async function readMigrationLevel(client: Client): Promise<number> {
  const result = await client.execute('PRAGMA application_id');
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return Number(row?.application_id ?? 0);
}

/**
 * Never downward.
 *
 * A database at a higher level was migrated by a newer Knowl. Stamping this build's lower
 * number over it would tell that build its own migration had not run, and it would redo the
 * whole suite on its next open -- forever, once two versions share a file.
 */
export async function stampMigrationLevel(client: Client): Promise<void> {
  if ((await readMigrationLevel(client)) >= KNOWL_MIGRATION_LEVEL) return;
  await client.execute(`PRAGMA application_id = ${KNOWL_MIGRATION_LEVEL}`);
}

/**
 * Has this build's migration already run here?
 *
 * `>=`, so a database a newer Knowl migrated counts as current. Every migration is additive,
 * so a higher level is a superset of what this build would create; running the suite anyway
 * would find nothing to do, and the stamp at the end would only undo the newer build's
 * record of its own work. Whether that newer database is safe to *use* is a separate
 * question, and `assertSchemaSupported` has already answered it before this is reached.
 */
export async function isMigrationCurrent(client: Client): Promise<boolean> {
  return (await readMigrationLevel(client)) >= KNOWL_MIGRATION_LEVEL;
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
