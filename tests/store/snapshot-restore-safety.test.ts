import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { createSnapshot, restoreSnapshot } from '../../src/store/snapshots.js';

const TEST_ROOT = path.resolve('./.knowl-snapshot-restore-safety-test');

async function itemCount(): Promise<number> {
  return Number((await getClient().execute('SELECT count(*) AS n FROM knowledge_items')).rows[0]?.n ?? 0);
}

describe('snapshot restore safety', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
    const project = await repo.createProject(TEST_ROOT, 'Safety');
    await repo.createKnowledgeItem(project.id, { category: 'fact', title: 'Survivor', content: 'Still here.' });
  });

  beforeEach(async () => {
    await fs.rm(path.join(TEST_ROOT, '.knowl', 'snapshots'), { recursive: true, force: true });
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  // The pre-restore snapshot prunes to SNAPSHOT_KEEP and protects only itself, so the file
  // being restored is deleted before ATTACH reads it -- and ATTACH then creates it empty.
  it('never empties the store when the restore source is pruned out from under it', async () => {
    const oldest = await createSnapshot(TEST_ROOT);
    await new Promise(resolve => setTimeout(resolve, 20));
    await createSnapshot(TEST_ROOT);
    await new Promise(resolve => setTimeout(resolve, 20));
    await createSnapshot(TEST_ROOT);

    const before = await itemCount();
    expect(before).toBeGreaterThan(0);

    // Either it restores correctly or it refuses. What it must never do is succeed and
    // leave an empty store.
    await restoreSnapshot(TEST_ROOT, oldest.path, { confirm: true }).catch(() => {});

    expect(await itemCount()).toBe(before);
  });

  it('refuses a source path that does not exist rather than creating it', async () => {
    const before = await itemCount();
    const missing = path.join(TEST_ROOT, '.knowl', 'snapshots', 'not-there.db');
    await expect(restoreSnapshot(TEST_ROOT, missing, { confirm: true })).rejects.toThrow();
    expect(await itemCount()).toBe(before);
  });
});
