import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped, storeKnowledgeAtomsDeduped } from '../../src/store/knowledge-writer.js';

const ROOT = path.resolve('./.knowl-supersede-write-test');

describe('supersede on write', () => {
  let projectId = '';
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'supersede')).id;
  });
  afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('a changed state atom supersedes its near-duplicate predecessor', async () => {
    const first = await storeKnowledgeItemDeduped(projectId, {
      category: 'state', title: 'Migration progress', content: 'Postgres migration is 40 percent complete, users table done.',
    });
    expect(first.action).toBe('inserted');

    const second = await storeKnowledgeItemDeduped(projectId, {
      category: 'state', title: 'Migration progress', content: 'Postgres migration is 90 percent complete, users and orders tables done.',
    });
    expect(second.action).toBe('inserted');

    const old = await repo.getKnowledgeItem(first.item.id);
    expect(old!.status).toBe('superseded');
    expect(old!.supersededById).toBe(second.item.id);
    expect((await repo.getKnowledgeItem(second.item.id))!.status).toBe('active');
  });

  it('an identical state re-store is still deduped, not churned', async () => {
    const content = 'Deploy pipeline is green on main.';
    const first = await storeKnowledgeItemDeduped(projectId, { category: 'state', title: 'Deploy status', content });
    const again = await storeKnowledgeItemDeduped(projectId, { category: 'state', title: 'Deploy status', content });
    expect(again.action).toBe('duplicate');
    expect(again.item.id).toBe(first.item.id);
    expect((await repo.getKnowledgeItem(first.item.id))!.status).toBe('active');
  });

  it('facts still coexist instead of superseding each other', async () => {
    const first = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Cache TTL', content: 'The product cache expires after 5 minutes.',
    });
    const second = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Cache TTL', content: 'The product cache expires after 30 minutes now.',
    });
    // near-duplicate fact is dropped, and the original stays active (no silent retirement)
    expect(second.action).toBe('duplicate');
    expect((await repo.getKnowledgeItem(first.item.id))!.status).toBe('active');
  });

  it('an explicit supersedes id retires the named item for any category', async () => {
    const original = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Node runtime', content: 'Services run on Node.js 18.',
    });
    const replacement = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Node runtime upgraded', content: 'Services now run on Node.js 22 LTS.',
      supersedes: original.item.id,
    });
    expect(replacement.action).toBe('inserted');
    const old = await repo.getKnowledgeItem(original.item.id);
    expect(old!.status).toBe('superseded');
    expect(old!.supersededById).toBe(replacement.item.id);
  });

  it('batch promotion supersedes stale state too', async () => {
    const seed = await storeKnowledgeItemDeduped(projectId, {
      category: 'state', title: 'Session outcome', content: 'Finished the retrieval refactor, tests passing.',
    });
    const result = await storeKnowledgeAtomsDeduped(projectId, [{
      category: 'state', title: 'Session outcome', content: 'Finished the retrieval refactor and the viewer rewrite, tests passing.',
    }], 'Finalize memory session');
    expect(result.insertedCount).toBe(1);
    expect((await repo.getKnowledgeItem(seed.item.id))!.status).toBe('superseded');
  });
});
