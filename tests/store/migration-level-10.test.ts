import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapSchema } from '../../src/store/bootstrap.js';
import { KNOWL_MIGRATION_LEVEL, readMigrationLevel } from '../../src/store/schema-version.js';

let root: string;
let client: Client;

/**
 * A store as a level-9 build left it: the ledger without `stage_state`, and no `cloud_excluded`.
 *
 * Built by bootstrapping the current schema and removing what level 10 added, rather than by
 * pasting level 9's DDL — a copy would drift from `bootstrap.ts` silently and start testing a
 * schema no build ever wrote.
 */
async function makeLevel9Store(c: Client): Promise<void> {
  await bootstrapSchema(c);
  await c.execute('ALTER TABLE cloud_published DROP COLUMN stage_state');
  await c.execute('DROP TABLE IF EXISTS cloud_excluded');
  // Only the gate is rewound. `user_version` stays where a current build left it, which is what
  // makes this a migration test rather than a compatibility one.
  await c.execute('PRAGMA application_id = 9');
}

/** A ledger row as level 7 wrote it, with no `stage_state` at all. */
async function insertLegacyRow(c: Client, input: {
  itemId: string;
  pushedAt: string | null;
  retractedAt: string | null;
  remoteVersion: number | null;
}): Promise<void> {
  await c.execute({
    sql: `INSERT INTO cloud_published
            (item_id, remote_workspace, remote_version, staged_at, staged_on_branch, pushed_at, retracted_at)
          VALUES (?, 'ws-1', ?, '2026-08-01T00:00:00.000Z', 'main', ?, ?)`,
    args: [input.itemId, input.remoteVersion, input.pushedAt, input.retractedAt],
  });
}

const stateOf = async (c: Client): Promise<Record<string, string>> => {
  const rows = await c.execute('SELECT item_id, stage_state FROM cloud_published ORDER BY item_id');
  return Object.fromEntries(rows.rows.map(row => [String(row.item_id), String(row.stage_state)]));
};

describe('a level-9 store upgrading to level 10', () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-mig10-'));
    client = createClient({ url: `file:${path.join(root, 'knowl.db')}` });
    await makeLevel9Store(client);
  });

  afterEach(async () => {
    try { client.close(); } catch { /* already closed */ }
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('gets the column, the table and the stamp from one bootstrap', async () => {
    expect(await readMigrationLevel(client)).toBe(9);

    await bootstrapSchema(client);

    const columns = await client.execute('PRAGMA table_info(cloud_published)');
    expect(columns.rows.map(row => String(row.name))).toContain('stage_state');

    const tables = await client.execute(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'cloud_excluded'",
    );
    expect(tables.rows).toHaveLength(1);
    // The CURRENT level, not the literal 10. What this asserts is that one bootstrap stamps the
    // gate forward, and pinning the number made an unrelated later level fail a test about this
    // one -- the brittleness `impact-schema.test.ts` already avoids by asserting `>= 4`.
    expect(await readMigrationLevel(client)).toBe(KNOWL_MIGRATION_LEVEL);
  });

  it('maps the old three-column predicate onto explicit states', async () => {
    await insertLegacyRow(client, { itemId: 'staged', pushedAt: null, retractedAt: null, remoteVersion: null });
    await insertLegacyRow(client, { itemId: 'pushed', pushedAt: '2026-08-02T00:00:00.000Z', retractedAt: null, remoteVersion: 3 });
    await insertLegacyRow(client, { itemId: 'retracted', pushedAt: '2026-08-02T00:00:00.000Z', retractedAt: '2026-08-03T00:00:00.000Z', remoteVersion: null });

    await bootstrapSchema(client);

    expect(await stateOf(client)).toEqual({ pushed: 'clear', retracted: 'clear', staged: 'pending' });
  });

  it('never promotes a pushed row to pending, because that would re-send published history', async () => {
    await insertLegacyRow(client, { itemId: 'pushed', pushedAt: '2026-08-02T00:00:00.000Z', retractedAt: null, remoteVersion: 9 });

    await bootstrapSchema(client);

    const rows = await client.execute(
      "SELECT COUNT(*) AS n FROM cloud_published WHERE stage_state = 'pending'",
    );
    expect(Number(rows.rows[0].n)).toBe(0);
  });

  it('preserves remote_version through the migration', async () => {
    await insertLegacyRow(client, { itemId: 'pushed', pushedAt: '2026-08-02T00:00:00.000Z', retractedAt: null, remoteVersion: 42 });

    await bootstrapSchema(client);

    const rows = await client.execute(
      "SELECT remote_version FROM cloud_published WHERE item_id = 'pushed'",
    );
    expect(Number(rows.rows[0].remote_version)).toBe(42);
  });

  it('is idempotent — a second bootstrap re-stages nothing', async () => {
    await insertLegacyRow(client, { itemId: 'pushed', pushedAt: '2026-08-02T00:00:00.000Z', retractedAt: null, remoteVersion: 1 });
    await bootstrapSchema(client);

    // Simulates the atom being unstaged after the upgrade. If the migration ran again it would
    // read `pushed_at IS NULL AND retracted_at IS NULL` afresh -- it must not, because the column
    // now exists and `ensureLedgerStageState` returns early.
    await bootstrapSchema(client);

    expect((await stateOf(client)).pushed).toBe('clear');
  });
});
