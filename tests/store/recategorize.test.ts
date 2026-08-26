import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { updateKnowledgeItemWithCommit } from '../../src/store/knowledge-actions.js';
import { hashKnowledgeLifecycle } from '../../src/store/freshness.js';
import { classifyIncomingItem } from '../../src/store/import-policy.js';

/**
 * Correcting a misfiled category without rewriting the item.
 *
 * The point is not the enum. `category` is the only thing GC reads to decide whether an item is
 * archivable at all, so an atom that is really a decision but was captured as `state` is on the
 * archive path -- and the only previous fix was to store it again and retire the original, which
 * throws away exactly the record showing it mattered.
 */

const ROOT = path.resolve('./.knowl-recategorize-test');

describe('re-categorizing an item', () => {
  let projectId = '';
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'recategorize')).id;
  });
  afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('promotes a state atom to a decision, keeping its identity and its words', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'state',
      title: 'Retries are capped at three attempts',
      content: 'Three, chosen because the fourth attempt never once succeeded in the sampled runs.',
    });

    const updated = await updateKnowledgeItemWithCommit(projectId, item.id, { category: 'decision' }, { projectRoot: ROOT });

    expect(updated.id).toBe(item.id);
    expect(updated.category).toBe('decision');
    // The words did not change, so neither does the fingerprint over them -- a re-category is
    // not an edit, and must not read as one to drift or to import's divergence check.
    expect(updated.contentHash).toBe(item.contentHash);
    expect(updated.title).toBe(item.title);
    expect(updated.content).toBe(item.content);

    // The commit log carries it, so the change is attributable rather than a silent mutation.
    const reread = await repo.getKnowledgeItem(item.id);
    expect(reread?.category).toBe('decision');
  });

  it('moves the lifecycle hash, so the change can travel through an export', () => {
    const base = { status: 'active', freshness: 'fresh', supersededById: null, originRepo: null, visibility: 'repo' };
    const asState = hashKnowledgeLifecycle({ ...base, category: 'state' });
    const asDecision = hashKnowledgeLifecycle({ ...base, category: 'decision' });
    expect(asState).not.toBe(asDecision);

    // Without category in that hash this pair is `identical` and the plan skips it: same words,
    // same content hash, and the receiving side keeps the misfiled category forever. That is the
    // bug status and visibility had before the lifecycle hash existed.
    const contentHash = 'same-words';
    expect(classifyIncomingItem(
      { id: 'a', contentHash, updatedAt: '2026-07-09T00:00:00.000Z', version: 2, lifecycleHash: asDecision },
      { id: 'a', contentHash, updatedAt: '2026-07-01T00:00:00.000Z', version: 1, lifecycleHash: asState },
    )).toBe('metadata-divergent');
  });
});
