import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { resetWriteOwnershipCache } from '../../src/store/write-ownership.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

let counter = 0;
let ROOT = '';

const LEXICAL_ONLY = {
  ...DEFAULT_CONFIG,
  search: { vector: { ...DEFAULT_CONFIG.search?.vector, enabled: false } },
};

async function counts() {
  const items = await getClient().execute('SELECT COUNT(*) AS n FROM knowledge_items');
  const assertions = await getClient().execute('SELECT COUNT(*) AS n FROM knowledge_assertions');
  const orphans = await getClient().execute(
    'SELECT COUNT(*) AS n FROM knowledge_assertions a LEFT JOIN knowledge_items i ON i.id = a.knowledge_item_id WHERE i.id IS NULL',
  );
  return {
    items: Number(items.rows[0].n),
    assertions: Number(assertions.rows[0].n),
    orphans: Number(orphans.rows[0].n),
  };
}

describe('knowledge writes are atomic', () => {
  beforeEach(async () => {
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    counter += 1;
    ROOT = path.resolve(`./.knowl-writetx${counter}`);
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await saveConfig(ROOT, LEXICAL_ONLY);
  });

  afterEach(async () => {
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('writes an item and its assertion together', async () => {
    await initDb(ROOT);
    try {
      const project = await repo.createProject(ROOT, 'p');
      await repo.createKnowledgeItem(project.id, {
        category: 'fact', title: 'Cache TTL is sixty seconds', content: 'Entries expire after a minute.',
      });

      const after = await counts();
      expect(after.items).toBe(1);
      expect(after.assertions).toBe(1);
      expect(after.orphans).toBe(0);
    } finally {
      await closeDb();
    }
  });

  it('leaves nothing behind when the write is refused mid-transaction', async () => {
    // The exclusive-conflict check runs *inside* the transaction, so this is a real path that
    // must roll back. It is the property that has to survive replacing Drizzle's transaction
    // wrapper with an explicit BEGIN/COMMIT: without a working rollback, a refused write would
    // leave the item row and orphan its assertion.
    await initDb(ROOT);
    try {
      const project = await repo.createProject(ROOT, 'p');
      await repo.createKnowledgeItem(project.id, {
        category: 'decision', title: 'Session store engine', content: 'Redis.',
        conflictKey: 'session.store.engine', conflictExclusive: true,
      } as never);

      const before = await counts();

      await expect(repo.createKnowledgeItem(project.id, {
        category: 'decision', title: 'Session store engine again', content: 'Memcached.',
        conflictKey: 'session.store.engine', conflictExclusive: true,
      } as never)).rejects.toMatchObject({ code: 'KNOWLEDGE_CONFLICT' });

      const after = await counts();
      expect(after).toEqual(before);
      expect(after.orphans).toBe(0);
    } finally {
      await closeDb();
    }
  });

});
