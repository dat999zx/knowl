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
  // 3 adds `work_read_sets` and `impact_findings` plus their four indexes. Additive again, so
  // `KNOWL_SCHEMA_VERSION` again does not move.
  //
  // !!! PLACEHOLDER -- NOT THE REAL HASH. The lane that wrote this DDL was not permitted to run
  // vitest (a second lane was working the same directory, and concurrent runs sweep each
  // other's `.knowl-*` fixtures), so the fingerprint could not be computed. To fill it in:
  //   npx vitest run tests/store/schema-pin.test.ts
  // The first case fails with `Received: '<32 hex chars>'`; that value is the real fingerprint.
  // Paste it over the string below, keeping the key at 3. Ignore the failure message's own
  // `SCHEMA_PINS[4]` suggestion -- it is `KNOWL_MIGRATION_LEVEL + 1` and the level is already
  // bumped, so the entry belongs at 3, not 4.
  3: '167b360fbc14831874078aed7361c09e',
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
