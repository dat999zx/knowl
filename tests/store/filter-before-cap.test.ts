import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { searchKnowledgeItems } from '../../src/store/search.js';
import { resetWriteOwnershipCache } from '../../src/store/write-ownership.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

const ROOT = path.resolve('./.knowl-filter-cap');

describe('search filters before it caps', () => {
  beforeEach(async () => {
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await saveConfig(ROOT, { ...DEFAULT_CONFIG });

    await initDb(ROOT);
    const projectId = (await repo.createProject(ROOT, 'p')).id;
    // 25 archived matches, then one active one. The active item is well past any
    // reasonable candidate window.
    for (let index = 0; index < 25; index += 1) {
      const stored = await storeKnowledgeItemDeduped(projectId, {
        category: 'fact',
        title: `Retention policy note ${index}`,
        content: `Retention policy detail number ${index} for the archive.`,
      });
      await repo.updateKnowledgeItem(stored.item.id, { status: 'archived' });
    }
    await storeKnowledgeItemDeduped(projectId, {
      category: 'fact',
      title: 'Retention policy is ninety days',
      content: 'Retention policy keeps records for ninety days.',
    });
    await closeDb();
  });

  afterEach(async () => {
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('finds the one active match behind a wall of archived ones', async () => {
    // Cap-then-filter returns nothing here: the LIMIT is spent on archived rows and the
    // status filter then discards all of them.
    await initDb(ROOT);
    try {
      const found = await searchKnowledgeItems('local', { query: 'retention policy', limit: 5 });
      expect(found.map(item => item.title)).toContain('Retention policy is ninety days');
    } finally {
      await closeDb();
    }
  });

  it('returns only workspace-visible items when asked for them', async () => {
    await initDb(ROOT);
    try {
      await getClient().execute(
        "UPDATE knowledge_items SET visibility = 'workspace' WHERE title = 'Retention policy is ninety days'",
      );

      const shared = await searchKnowledgeItems('local', {
        query: 'retention policy', limit: 5, visibility: 'workspace',
      });
      expect(shared.map(item => item.title)).toEqual(['Retention policy is ninety days']);
    } finally {
      await closeDb();
    }
  });

  it('excludes private items even when they would fill the whole candidate window', async () => {
    // The peer case: 25 private items rank above the one shared item. A post-filter would
    // return nothing, which reads as "that repo knows nothing about this".
    await initDb(ROOT);
    try {
      await getClient().execute("UPDATE knowledge_items SET status = 'active'");
      await getClient().execute(
        "UPDATE knowledge_items SET visibility = 'workspace' WHERE title = 'Retention policy is ninety days'",
      );

      const shared = await searchKnowledgeItems('local', {
        query: 'retention policy', limit: 3, visibility: 'workspace',
      });
      expect(shared.map(item => item.title)).toEqual(['Retention policy is ninety days']);
    } finally {
      await closeDb();
    }
  });

  it('still filters by category, now in SQL rather than after the cap', async () => {
    await initDb(ROOT);
    try {
      const found = await searchKnowledgeItems('local', {
        query: 'retention policy', limit: 5, category: 'decision',
      });
      // Every seeded item is a fact, so a decision filter must return nothing rather than
      // leaking facts through.
      expect(found).toEqual([]);
    } finally {
      await closeDb();
    }
  });
});
