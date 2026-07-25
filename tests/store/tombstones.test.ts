import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { listTombstones, pruneTombstones, recordTombstone } from '../../src/store/tombstones.js';

const ROOT = path.resolve('.knowl-tombstones-test');

describe('tombstones', () => {
  let projectId = '';

  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'Tombstones')).id;
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('records a tombstone when an item is deleted', async () => {
    // A hard delete leaves no trace, so a peer importing a later export cannot tell a
    // removed item from one that never existed. The tombstone is the only record.
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Doomed fact', content: 'This will be purged.',
    });

    await repo.deleteKnowledgeItem(item.id);

    const tombstones = await listTombstones();
    expect(tombstones.map(entry => entry.id)).toContain(item.id);
  });

  it('prunes tombstones older than the retention window', async () => {
    await recordTombstone('ancient-id', '2020-01-01T00:00:00.000Z');
    await recordTombstone('recent-id', new Date().toISOString());

    const removed = await pruneTombstones(90);

    expect(removed).toBe(1);
    const ids = (await listTombstones()).map(entry => entry.id);
    expect(ids).toContain('recent-id');
    expect(ids).not.toContain('ancient-id');
  });
});
