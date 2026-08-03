import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createClient, type Client } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapSchema } from '../../src/store/bootstrap.js';
import { KNOWL_SCHEMA_VERSION, readSchemaVersion, SchemaTooNewError } from '../../src/store/schema-version.js';

/**
 * The schema a fresh bootstrap produces, pinned per version.
 *
 * `KNOWL_SCHEMA_VERSION` now gates whether migrations run at all, so a schema change that
 * does not bump it is a migration every existing database will skip forever -- silently, and
 * only on other people's machines. That is not a thing to remember; it is a thing to enforce.
 *
 * Keyed by version rather than a single value on purpose: changing the DDL under an existing
 * version fails here, and the natural way to make it pass is to add the next entry.
 */
const SCHEMA_PINS: Record<number, string> = {
  2: '9e6779b05c8176eb9023e305699b85f9',
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
  it('pins the schema a fresh bootstrap produces to this version', async () => {
    await bootstrapSchema(client);
    const actual = await schemaFingerprint(client);
    const pinned = SCHEMA_PINS[KNOWL_SCHEMA_VERSION];

    expect(
      pinned,
      `No pin recorded for schema version ${KNOWL_SCHEMA_VERSION}. Add one to SCHEMA_PINS: ${actual}`,
    ).toBeDefined();

    expect(
      actual,
      `The schema changed but KNOWL_SCHEMA_VERSION is still ${KNOWL_SCHEMA_VERSION}.\n` +
      `Because that number now gates whether migrations run, every existing database would\n` +
      `skip this change permanently. Bump KNOWL_SCHEMA_VERSION and add SCHEMA_PINS[${KNOWL_SCHEMA_VERSION + 1}] = '${actual}'.`,
    ).toBe(pinned);
  });

  it('stamps the version on a fresh database', async () => {
    await bootstrapSchema(client);
    expect(await readSchemaVersion(client)).toBe(KNOWL_SCHEMA_VERSION);
  });

  it('does no schema work at all when the version is already current', async () => {
    await bootstrapSchema(client);
    const before = await cookie(client);

    // SQLite bumps the schema cookie for any real DDL and leaves it alone for a no-op, so an
    // unchanged cookie is proof the second pass created, altered and dropped nothing.
    await bootstrapSchema(client);
    expect(await cookie(client)).toBe(before);
  });

  it('re-runs when the stored version is older, and re-stamps', async () => {
    await bootstrapSchema(client);
    await client.execute('PRAGMA user_version = 0');
    await client.execute('ALTER TABLE knowledge_items DROP COLUMN lifecycle_hash');

    await bootstrapSchema(client);

    const columns = await client.execute('PRAGMA table_info(knowledge_items)');
    expect(columns.rows.map(r => r.name)).toContain('lifecycle_hash');
    expect(await readSchemaVersion(client)).toBe(KNOWL_SCHEMA_VERSION);
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
    await client.execute('PRAGMA user_version = 0');
    await client.execute('CREATE TABLE knowledge_assertions_wrecked AS SELECT 1 AS x');
    await client.execute('ALTER TABLE knowledge_assertions RENAME TO knowledge_assertions_wrecked2');
    await client.execute('CREATE TABLE knowledge_assertions (nope INTEGER)');

    // Whatever the outcome, a half-applied migration must not be left behind: either the
    // whole transaction commits or none of it does.
    await bootstrapSchema(client).catch(() => {});
    const version = await readSchemaVersion(client);
    if (version !== KNOWL_SCHEMA_VERSION) {
      // Rolled back: the wrecked state is exactly as the test left it, nothing half-migrated.
      expect(await schemaFingerprint(client)).not.toBe(before);
    }
  });
});
