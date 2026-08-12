import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';

const ROOT = path.resolve('./.knowl-exclusions-root');

describe('cloud_excluded', () => {
  beforeEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await fs.writeFile(path.join(ROOT, '.knowl', 'config.json'), JSON.stringify({ version: 1 }), 'utf8');
    await initDb(ROOT);
    // Wiped rather than trusted to the directory removal: on Windows libSQL can hold the file,
    // the `rm` is silently refused, and a surviving row answers the next test's question.
    await getClient().execute('DELETE FROM cloud_excluded');
  });

  afterEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('exists, is keyed by item alone, and carries no workspace', async () => {
    const columns = await getClient().execute('PRAGMA table_info(cloud_excluded)');
    const names = columns.rows.map(row => String(row.name)).sort();
    expect(names).toEqual(['excluded_at', 'item_id', 'reason']);

    const pk = columns.rows.filter(row => Number(row.pk) > 0).map(row => String(row.name));
    expect(pk).toEqual(['item_id']);
  });

  it('rejects a second row for the same item', async () => {
    await getClient().execute({
      sql: 'INSERT INTO cloud_excluded (item_id, excluded_at) VALUES (?, ?)',
      args: ['item-1', '2026-08-11T00:00:00.000Z'],
    });
    await expect(getClient().execute({
      sql: 'INSERT INTO cloud_excluded (item_id, excluded_at) VALUES (?, ?)',
      args: ['item-1', '2026-08-11T00:00:01.000Z'],
    })).rejects.toThrow();
  });

  it('excludes, reports, lists and clears', async () => {
    const { clearExclusion, excludeFromPublish, isExcluded, listExcluded } =
      await import('../../src/cloud/exclusions.js');

    expect(await isExcluded('item-1')).toBe(false);

    await excludeFromPublish('item-1', 'machine-local path');
    expect(await isExcluded('item-1')).toBe(true);

    const listed = await listExcluded();
    expect(listed).toHaveLength(1);
    expect(listed[0].itemId).toBe('item-1');
    expect(listed[0].reason).toBe('machine-local path');
    expect(listed[0].excludedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await clearExclusion('item-1');
    expect(await isExcluded('item-1')).toBe(false);
    expect(await listExcluded()).toEqual([]);
  });

  it('excluding twice is idempotent rather than an error', async () => {
    const { excludeFromPublish, listExcluded } = await import('../../src/cloud/exclusions.js');

    await excludeFromPublish('item-1', 'first');
    await excludeFromPublish('item-1', 'second');

    const listed = await listExcluded();
    expect(listed).toHaveLength(1);
    // The later reason wins: re-excluding is a restatement, and the newer explanation is the
    // one the user just gave.
    expect(listed[0].reason).toBe('second');
  });

  it('filterExcluded removes excluded ids and preserves order', async () => {
    const { excludeFromPublish, filterExcluded } = await import('../../src/cloud/exclusions.js');

    await excludeFromPublish('b');
    expect(await filterExcluded(['a', 'b', 'c'])).toEqual(['a', 'c']);
    expect(await filterExcluded([])).toEqual([]);
  });

  it('clearing an exclusion that was never set is a no-op, not an error', async () => {
    const { clearExclusion } = await import('../../src/cloud/exclusions.js');
    await expect(clearExclusion('never-seen')).resolves.toBeUndefined();
  });
});
