import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { recordKnowledgeAccess } from '../../src/store/access-feedback.js';
import { previewKnowledgeGc } from '../../src/store/gc.js';

const ROOT = path.resolve('./.knowl-gc-access-test');
const OLD = new Date(Date.now() - 90 * 86_400_000).toISOString();
const NOW = new Date().toISOString();

async function backdate(itemId: string) {
  await getClient().execute({ sql: 'UPDATE knowledge_items SET updated_at = ? WHERE id = ?', args: [OLD, itemId] });
}

describe('access-weighted GC decay', () => {
  let projectId = '';
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'gc-access')).id;
  });
  afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('archives a cold stale state item but protects a hot one', async () => {
    const cold = await repo.createKnowledgeItem(projectId, { category: 'state', title: 'Cold state', content: 'Old and never retrieved.' });
    const hot = await repo.createKnowledgeItem(projectId, { category: 'state', title: 'Hot state', content: 'Old but frequently retrieved.' });
    await backdate(cold.id);
    await backdate(hot.id);

    // The hot item is retrieved several times; the cold one never is.
    for (let index = 0; index < 4; index++) {
      await recordKnowledgeAccess({ itemId: hot.id, surface: 'agent_query', rank: 1, retrievedAt: NOW });
    }

    const result = await previewKnowledgeGc(projectId, { now: NOW });
    const archived = result.candidates.filter(candidate => candidate.action === 'archive').map(candidate => candidate.itemId);
    expect(archived).toContain(cold.id);
    expect(archived).not.toContain(hot.id);
  });
});
