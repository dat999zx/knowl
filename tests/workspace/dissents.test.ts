import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';

/**
 * A dissent is one repo's recorded disagreement with an atom another repo owns.
 *
 * Two single-writer rows, joined at read time: the dissent lives in the DISSENTING repo's store
 * and the resolution in the OWNING repo's. Nothing here ever writes another repo's database,
 * which is the invariant `assertOwnedItem` enforces and the one this feature exists not to bend.
 */

const ROOT = path.join(os.tmpdir(), 'knowl-dissent-schema');

describe('dissent schema', () => {
  beforeEach(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
  });

  afterEach(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('bootstrap creates both tables', async () => {
    const tables = await getClient().execute({
      sql: `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('dissents', 'dissent_resolutions') ORDER BY name`,
      args: [],
    });
    expect(tables.rows.map(row => String(row.name))).toEqual(['dissent_resolutions', 'dissents']);
  });

  it('the overlay lookup is indexed, because it runs per returned atom', async () => {
    const plan = await getClient().execute({
      sql: `EXPLAIN QUERY PLAN SELECT * FROM dissents WHERE target_item_id = 'x'`,
      args: [],
    });
    expect(JSON.stringify(plan.rows)).toContain('idx_dissents_target');
  });

  it('resolutions are looked up the same way, by the atom being defended', async () => {
    const plan = await getClient().execute({
      sql: `EXPLAIN QUERY PLAN SELECT * FROM dissent_resolutions WHERE target_item_id = 'x'`,
      args: [],
    });
    expect(JSON.stringify(plan.rows)).toContain('idx_dissent_resolutions_target');
  });

  it('re-opening an existing store is idempotent', async () => {
    await closeDb();
    await expect(initDb(ROOT)).resolves.not.toThrow();
    const tables = await getClient().execute({
      sql: `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('dissents', 'dissent_resolutions')`,
      args: [],
    });
    expect(Number(tables.rows[0].n)).toBe(2);
  });

  it('a dissent pins the revision it was raised against, so a rewrite can stale it out', async () => {
    // Not decoration: without the pinned hash, a dissent raised against revision N would still
    // read as live against N+1, and the owner's rewrite -- the most likely response -- could
    // never clear it.
    const columns = await getClient().execute({ sql: `PRAGMA table_info(dissents)`, args: [] });
    const names = columns.rows.map(row => String(row.name));
    expect(names).toContain('target_content_hash');
    expect(names).toContain('target_repo');
    expect(names).toContain('claim');
    expect(names).toContain('replacement_item_id');
    expect(names).toContain('status');
  });
});
