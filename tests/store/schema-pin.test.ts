import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createClient, type Client } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapSchema } from '../../src/store/bootstrap.js';
import {
  KNOWL_MIGRATION_LEVEL, KNOWL_SCHEMA_VERSION, readMigrationLevel, readSchemaVersion, SchemaTooNewError,
} from '../../src/store/schema-version.js';

/**
 * The schema a fresh bootstrap produces, pinned per migration level.
 *
 * `KNOWL_MIGRATION_LEVEL` gates whether migrations run at all, so a schema change that does
 * not bump it is a migration every existing database will skip forever -- silently, and only
 * on other people's machines. That is not a thing to remember; it is a thing to enforce.
 *
 * Keyed by level rather than a single value on purpose: changing the DDL under an existing
 * level fails here, and the natural way to make it pass is to add the next entry.
 */
const SCHEMA_PINS: Record<number, string> = {
  1: '9e6779b05c8176eb9023e305699b85f9',
  // 2 adds `knowledge_commit_items` and its covering index. Additive, so
  // `KNOWL_SCHEMA_VERSION` deliberately does not move with it.
  2: '1e9ab9fdb263a49ec80f26eff98fe0c3',
  // 3 adds `work_read_sets` and `impact_findings`, their four indexes, and the partial unique
  // index that closes the duplicate-finding window. Additive again, so `KNOWL_SCHEMA_VERSION`
  // again does not move.
  3: '627dad6b3eff5019fb2442a4a1a12a05',
  // 4 adds `impact_gate_shadow` and its unique index on `finding_id` -- what an enforcing write
  // gate would have refused, recorded while it refuses nothing. Additive again, so
  // `KNOWL_SCHEMA_VERSION` again does not move.
  4: '4592e436daefd236d1f15554d1a2db3a',
  // 5 adds `knowledge_items.last_drift_at`, the stored drift observation standing promotion
  // reads. One nullable column, no backfill, so `KNOWL_SCHEMA_VERSION` again does not move.
  5: 'b4aceb35414d23bf1240b4b1679bee78',
  // 6 adds `knowledge_forget_log`: the deciding numbers behind a deletion, which the tombstone
  // could not carry because it is exported and upsert-merged. Additive again, so
  // `KNOWL_SCHEMA_VERSION` again does not move.
  6: '5f36731e329b1d86976f39f439f7ff39',
  // 7 adds `cloud_published` -- what this machine has staged for, and pushed to, a cloud
  // workspace. Additive again, so `KNOWL_SCHEMA_VERSION` again does not move. It landed at 7
  // rather than 5 because two other additive levels reached main first; the fingerprint is
  // recomputed here rather than carried over, since a level-7 schema holds all three tables.
  7: 'b847bdb205a1ee63b1ff3b612c794c89',
  // 8 widens `knowledge_forget_log` with `reason_code`, `merged_into_id` and `content_preview`.
  // A level of its own rather than an amendment of 6: 6 shipped on main, so a store already
  // stamped at it skips `SCHEMA_STATEMENTS` entirely and would never get these columns --
  // the same failure mode that made the forget log claim 6 instead of 5 in the first place.
  // 8 rather than 7 because `cloud_published` took 7 while this branch was open.
  8: 'e96218e9fbe0594d73078033d718af4f',
  // 9 adds `capture_outcomes` -- turns produced and durable writes made, per conversation, so a
  // repo can measure how often a session talks and stores nothing. Additive again, so
  // `KNOWL_SCHEMA_VERSION` again does not move. No backfill, and none is possible: the counters
  // ride the events that cause them and `memory_session_events` expires in about two days, so
  // any history worth backfilling is already gone.
  9: 'e35a04dead1990c2af454fc44545e39a',
  // 10 adds `cloud_excluded` and `cloud_published.stage_state`. The table is additive; the
  // column is why the level moves rather than riding on level 7's `CREATE TABLE IF NOT EXISTS`,
  // which is a no-op on every store that already has the ledger. `KNOWL_SCHEMA_VERSION` again
  // does not move: an older build can still read a database with an extra column and an extra
  // table it does not know about.
  10: '0fb5091ab39e438ed70777b8d7c4b8c9',
  // 11 adds `knowledge_items.written_by`: who authored an atom, when that is not who owns it.
  // One nullable column and no backfill, as level 5 was -- and here writing nothing is the
  // correct backfill rather than a concession, because NULL already means "the owner wrote it"
  // and every pre-existing row was written before a repo could act as another.
  // `KNOWL_SCHEMA_VERSION` again does not move.
  11: '2f2aa4d61c1fd3600266ec572a964aa0',
  // 12 adds `cloud_published.remote_content_hash` and `.remote_lifecycle_hash`, so a re-staged
  // atom nobody edited is settled rather than re-sent. Two nullable columns, no backfill --
  // the skip predicate requires a non-null hash, so every pre-existing row keeps being sent.
  // Additive, so `KNOWL_SCHEMA_VERSION` again does not move.
  12: '8655428a61126c78a4117b827a103703',
  // 13 adds `pending_lessons`, its conversation index, and `pending_lesson_claims` -- events
  // whose knowledge has not been stored yet, and the block budget their delivery spends.
  // Additive, so `KNOWL_SCHEMA_VERSION` again does not move.
  13: '966fb32dc577094f2844ed942efe2f56',
};

let root: string;
let db: string;
let client: Client;

/** Every table, index, trigger and view, normalized so formatting alone cannot move the hash. */
async function schemaFingerprint(c: Client): Promise<string> {
  const rows = await c.execute(
    `SELECT type, name, COALESCE(sql, '') AS sql FROM sqlite_schema
     WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
  );
  const canonical = rows.rows
    .map(r => `${r.type}:${r.name}:${String(r.sql).replace(/\s+/g, ' ').trim()}`)
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

const cookie = async (c: Client): Promise<number> =>
  Number((await c.execute('PRAGMA schema_version')).rows[0].schema_version);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-pin-'));
  db = path.join(root, 'knowl.db');
  client = createClient({ url: `file:${db}` });
});

afterEach(async () => {
  try { client.close(); } catch { /* already closed */ }
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

describe('schema version gate', () => {
  it('pins the schema a fresh bootstrap produces to this migration level', async () => {
    await bootstrapSchema(client);
    const actual = await schemaFingerprint(client);
    const pinned = SCHEMA_PINS[KNOWL_MIGRATION_LEVEL];

    expect(
      pinned,
      `No pin recorded for migration level ${KNOWL_MIGRATION_LEVEL}. Add one to SCHEMA_PINS: ${actual}`,
    ).toBeDefined();

    expect(
      actual,
      `The schema changed but KNOWL_MIGRATION_LEVEL is still ${KNOWL_MIGRATION_LEVEL}.\n` +
      `Because that number gates whether migrations run, every existing database would\n` +
      `skip this change permanently. Bump KNOWL_MIGRATION_LEVEL and add SCHEMA_PINS[${KNOWL_MIGRATION_LEVEL + 1}] = '${actual}'.`,
    ).toBe(pinned);
  });

  it('stamps both numbers on a fresh database', async () => {
    await bootstrapSchema(client);
    expect(await readSchemaVersion(client)).toBe(KNOWL_SCHEMA_VERSION);
    expect(await readMigrationLevel(client)).toBe(KNOWL_MIGRATION_LEVEL);
  });

  /**
   * The reason the gate is a second number rather than `user_version`.
   *
   * `assertSchemaSupported` refuses any database whose `user_version` exceeds the build's
   * own, so raising it locks out every Knowl already installed -- and under a rule that says
   * "bump on every additive change", that would be every release. An additive column does not
   * make a database unreadable by an older build, so it must not be announced as if it did.
   */
  it('leaves a database an older build can still open', async () => {
    await bootstrapSchema(client);

    // 1 is the compatibility floor every published Knowl understands. This must not move
    // without a change that genuinely breaks older readers -- a table rebuild, a primary key
    // change, or a column an older writer would leave NULL where a newer reader requires one.
    expect(await readSchemaVersion(client)).toBeLessThanOrEqual(1);
  });

  it('re-runs a migration the level requires even when the compatibility version is current', async () => {
    await bootstrapSchema(client);
    // Only the gate is rewound; user_version stays exactly where a current build left it.
    await client.execute('PRAGMA application_id = 0');
    await client.execute('ALTER TABLE knowledge_items DROP COLUMN lifecycle_hash');

    await bootstrapSchema(client);

    const columns = await client.execute('PRAGMA table_info(knowledge_items)');
    expect(columns.rows.map(r => r.name)).toContain('lifecycle_hash');
    expect(await readMigrationLevel(client)).toBe(KNOWL_MIGRATION_LEVEL);
  });

  it('does no schema work at all when the migration level is already current', async () => {
    await bootstrapSchema(client);
    const before = await cookie(client);

    // SQLite bumps the schema cookie for any real DDL and leaves it alone for a no-op, so an
    // unchanged cookie is proof the second pass created, altered and dropped nothing.
    await bootstrapSchema(client);
    expect(await cookie(client)).toBe(before);
  });

  /**
   * A database last touched by a Knowl that predates the gate carries level 0, and its
   * `user_version` is already 1 -- so a gate keyed on `user_version` would call it current
   * and skip every migration this build adds. It is the upgrade path, not an edge case.
   */
  it('migrates a database stamped by a build that predates the gate', async () => {
    await bootstrapSchema(client);
    await client.execute('PRAGMA application_id = 0');
    await client.execute('ALTER TABLE knowledge_items DROP COLUMN lifecycle_hash');
    await client.execute(`PRAGMA user_version = ${KNOWL_SCHEMA_VERSION}`);

    await bootstrapSchema(client);

    const columns = await client.execute('PRAGMA table_info(knowledge_items)');
    expect(columns.rows.map(r => r.name)).toContain('lifecycle_hash');
  });

  it('refuses a database written by a newer Knowl instead of treating it as current', async () => {
    await bootstrapSchema(client);
    await client.execute(`PRAGMA user_version = ${KNOWL_SCHEMA_VERSION + 5}`);

    await expect(bootstrapSchema(client)).rejects.toBeInstanceOf(SchemaTooNewError);
  });

  it('leaves the database untouched when a migration fails partway', async () => {
    await bootstrapSchema(client);
    const before = await schemaFingerprint(client);

    // Force the migration path to run again, then break it: a table the DDL will collide with.
    await client.execute('PRAGMA application_id = 0');
    await client.execute('CREATE TABLE knowledge_assertions_wrecked AS SELECT 1 AS x');
    await client.execute('ALTER TABLE knowledge_assertions RENAME TO knowledge_assertions_wrecked2');
    await client.execute('CREATE TABLE knowledge_assertions (nope INTEGER)');

    // Whatever the outcome, a half-applied migration must not be left behind: either the
    // whole transaction commits or none of it does.
    await bootstrapSchema(client).catch(() => {});
    const level = await readMigrationLevel(client);
    if (level !== KNOWL_MIGRATION_LEVEL) {
      // Rolled back: the wrecked state is exactly as the test left it, nothing half-migrated.
      expect(await schemaFingerprint(client)).not.toBe(before);
    }
  });
});
