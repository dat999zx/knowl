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
 *
 */
/*
 * Level 5 adds `knowledge_items.last_drift_at` -- when the automatic drift check last saw an
 * item's cited files move, and NULL once somebody revisited it. One nullable column, no
 * backfill (an existing row has no recorded observation, and inventing one would refuse
 * promotion for items nothing has actually contradicted), so `KNOWL_SCHEMA_VERSION` stays at
 * 1. The bump is what makes `ensureFreshnessColumns` run on databases that already exist:
 * without it, every installed store would skip the column and standing promotion there would
 * fall back to the ungated behaviour this column was added to prevent.
 *
 * Level 6 adds `knowledge_forget_log` -- what was true about an item at the instant it was
 * destroyed, kept apart from `knowledge_tombstones` because tombstones ride in portable exports
 * and merge by upsert, so usage numbers there would both leave the machine and be overwritable
 * by a peer. Additive on the same reasoning as levels 3 and 4: one new table, no altered column,
 * no backfill. A backfill is not merely skipped but impossible -- the deciding numbers for every
 * past deletion were discarded at the moment of deletion, which is the defect the table fixes.
 *
 * The bump is load-bearing rather than bookkeeping. Every delete now writes a forget-log row in
 * the same transaction as its tombstone, so a store already stamped at level 5 by an installed
 * build would skip `SCHEMA_STATEMENTS`, never create the table, and fail every delete -- and,
 * inside `applyKnowledgeGc`'s single transaction, roll back the whole collection run.
 *
 * Level 7 adds `cloud_published` -- what this machine has staged for, and pushed to, a cloud
 * workspace. Additive on the same reasoning as levels 3 and 4: one new table, no altered column
 * and no backfill. What the bump buys is that a database created before the cloud client existed
 * still gets the table, since the gate is the only thing that decides whether `SCHEMA_STATEMENTS`
 * runs at all.
 *
 * It is 7 rather than 5 because two other additive levels reached `main` while this branch was
 * open. The number is a changelog position, not a claim about this table, so it moves freely --
 * what must not move is an already-published level's meaning.
 */
/*
 * Level 8 widens `knowledge_forget_log` with `reason_code`, `merged_into_id` and
 * `content_preview` -- the rule that fired as a groupable code, the item that absorbed a
 * duplicate, and a bounded snapshot of what was destroyed. Three nullable-or-defaulted columns,
 * no backfill: rows written at level 6 keep `reason_code` at its `'unspecified'` default and
 * carry no survivor or snapshot, because neither was recorded at the time.
 *
 * A level of its own rather than an amendment of 6, for exactly the reason 6 could not amend 5:
 * 6 has shipped on main, so a store already stamped at it skips `SCHEMA_STATEMENTS` entirely,
 * never gets these columns, and then fails every insert into the table -- inside the single
 * transaction `applyKnowledgeGc` runs, taking the whole collection run down with it.
 *
 * It is 8 rather than 7 because `cloud_published` took 7 while this branch was open, and two
 * branches claiming one level is worse than a merge conflict: both compile, both stamp the same
 * `application_id`, and whichever migrates first tells the other's gate there is nothing to do --
 * so the second table is silently never created on any store the first one touched.
 */
/*
 * Level 9 adds `capture_outcomes` -- one row per conversation, counting the turns it produced and
 * the durable writes it made, so a repo can see how often a session talks and stores nothing.
 * Additive on the same reasoning as levels 3, 4 and 7: one new table, no altered column, no
 * backfill.
 *
 * A backfill is impossible rather than merely skipped, and for the same shape of reason level 6
 * gives. The counters are incremented on the events that cause them, and `memory_session_events`
 * expires roughly two days out -- so history far enough back to be worth backfilling is already
 * gone, and inventing zeros for it would report every past conversation as having stored nothing.
 *
 * The bump is what makes an existing store get the table at all. Without it a database stamped at
 * level 8 skips `SCHEMA_STATEMENTS`, never creates `capture_outcomes`, and every counter write
 * silently no-ops -- which this subsystem is built to survive (it swallows its own errors, by
 * design, because it runs inside a hook), so the failure would present as a repository that
 * simply always reports zero sessions rather than as anything breaking.
 */
/*
 * Level 10 adds `cloud_excluded` and `cloud_published.stage_state`.
 *
 * The table is additive on the same reasoning as levels 3, 4, 7 and 9: one new table, no
 * backfill possible or needed, because a store that has never excluded anything has nothing
 * to record.
 *
 * The COLUMN is why this level exists rather than riding on the table. `CREATE TABLE IF NOT
 * EXISTS` is a no-op on a store that already has `cloud_published` from level 7, so without
 * the bump every existing store would keep a ledger with no `stage_state` -- and `listStaged`
 * reads that column, so every push would either fail or, worse, read NULL as pending and
 * re-send atoms already published. `ensureLedgerStageState` backfills it, and the backfill
 * direction is deliberately fail-safe: see its docblock.
 */
/*
 * Level 11 adds `knowledge_items.written_by`: the repo whose session authored an atom, when
 * that is not the repo that owns it.
 *
 * One nullable column and no backfill, on the same reasoning as level 5 -- and here the absence
 * of a backfill is not a compromise but the correct value. NULL means "the owner wrote it", and
 * every row predating this column was written before any repo could act as another, so the
 * owner IS who wrote it.
 *
 * The bump is still load-bearing rather than ceremonial. `ALTER TABLE ... ADD COLUMN` only runs
 * for a store that reaches the migration body, so without it an existing database stamped at
 * level 10 would skip the column forever while this build's mapper reads it -- the failure this
 * gate exists to prevent, and one that would surface as a write error rather than a missing
 * feature.
 *
 * `KNOWL_SCHEMA_VERSION` deliberately does not move: an older build ignores the column, and a
 * newer one reading NULL gets the truth rather than a hole.
 */
/*
 * Level 12 adds `cloud_published.remote_content_hash` and `.remote_lifecycle_hash`: the atom's
 * hashes as of the last confirmed push, so a re-staged atom that nobody actually edited is
 * settled instead of sent.
 *
 * Two nullable columns and NO backfill, and the absence is load-bearing rather than lazy. The
 * skip predicate requires `remote_content_hash IS NOT NULL`, so every existing row simply never
 * skips and behaves exactly as it does today. Backfilling from `knowledge_items` would assert
 * that the server holds whatever this machine holds right now -- which is precisely what no
 * local row knows, and getting it wrong strands a correction locally with nothing to reveal it.
 *
 * The bump is load-bearing for the same reason as level 10: `CREATE TABLE IF NOT EXISTS` is a
 * no-op on a store that already has `cloud_published`, so without it an existing database would
 * never gain the columns while `listStaged` joins on them.
 *
 * `KNOWL_SCHEMA_VERSION` does not move: an older build ignores both columns and pushes exactly
 * as it did before.
 */
export const KNOWL_MIGRATION_LEVEL = 12;

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
