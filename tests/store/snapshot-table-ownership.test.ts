import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { classifySnapshotTable, SNAPSHOT_TABLE_POLICY } from '../../src/store/snapshot-tables.js';

const TEST_ROOT = path.resolve('./.knowl-snapshot-ownership-test');

describe('snapshot table ownership', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  // The gate. A table added without a policy is a table whose behaviour under recovery
  // nobody decided -- which is exactly how `knowledge_commit_items` came to be destroyed
  // by a successful restore.
  it('classifies every application table in a bootstrapped store', async () => {
    const live = (await getClient().execute(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )).rows.map(row => String(row.name));

    const unclassified = live.filter(name => classifySnapshotTable(name) === undefined);
    expect(unclassified, `Unclassified tables. Add each to SNAPSHOT_TABLE_POLICY in src/store/snapshot-tables.ts with a reason: ${unclassified.join(', ')}`).toEqual([]);
  });

  it('does not classify tables that no longer exist', async () => {
    const live = new Set((await getClient().execute(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )).rows.map(row => String(row.name)));

    const stale = Object.keys(SNAPSHOT_TABLE_POLICY).filter(name => !live.has(name));
    expect(stale, `Policy names tables that are not in the schema: ${stale.join(', ')}`).toEqual([]);
  });
});
