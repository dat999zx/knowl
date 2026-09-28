import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import type { KnowledgeCategory } from '../../src/core/types.js';
import {
  findLikelyDuplicateKnowledgeItem, resolveDuplicate, storeKnowledgeAtomsDeduped, storeKnowledgeItemDeduped,
} from '../../src/store/knowledge-writer.js';
import { recordDecisionDirect } from '../../src/store/knowledge-actions.js';

const ROOT = path.resolve('./.knowl-supersede-target-test');

/**
 * A write that names X in `supersedes` while fuzzy-matching a same-subject Y used to retire Y and
 * leave X active: the detected duplicate outranked the id the caller asked for. Each case seeds
 * the pair, asks the duplicate search which one it finds, and names the OTHER, so the test holds
 * whichever of the two the search happens to rank first.
 */
describe('an explicit supersedes target outranks a detected duplicate', () => {
  let projectId = '';
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'supersede-target')).id;
  });
  afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  const incoming = (category: KnowledgeCategory) => ({
    category, title: 'Cache TTL policy for the API tier', content: 'API tier responses are cached for 120 seconds.',
  });

  async function seedPair(category: KnowledgeCategory) {
    // Written past the dedup path: the two titles are the same subject, so storing the second
    // through it would retire the first before the case under test began.
    const x = await repo.createKnowledgeItem(projectId, {
      category, title: 'Cache TTL policy', content: 'API responses are cached for 60 seconds by policy.',
    });
    const y = await repo.createKnowledgeItem(projectId, {
      category, title: 'Cache TTL', content: 'Cached API responses expire after 60 seconds.',
    });
    const detected = await findLikelyDuplicateKnowledgeItem(projectId, incoming(category));
    expect([x.id, y.id]).toContain(detected?.id);
    // The detected one must qualify on its own, or the explicit id already won before the fix.
    expect(resolveDuplicate(incoming(category), detected!)).toBe('supersede');
    const named = detected!.id === x.id ? y : x;
    return { detected: detected!, named };
  }

  it('retires the named item and reports the detected one as left beside it', async () => {
    const { detected, named } = await seedPair('fact');
    const written = await storeKnowledgeItemDeduped(projectId, { ...incoming('fact'), supersedes: named.id });

    expect(written.superseded?.id).toBe(named.id);
    expect((await repo.getKnowledgeItem(named.id))!.status).toBe('superseded');
    expect((await repo.getKnowledgeItem(detected.id))!.status).toBe('active');
    expect(written.nearDuplicate?.id).toBe(detected.id);
  });

  it('does the same in the batch path', async () => {
    const { detected, named } = await seedPair('constraint');
    const result = await storeKnowledgeAtomsDeduped(projectId, [{ ...incoming('constraint'), supersedes: named.id }]);

    expect(result.supersededIds).toEqual([named.id]);
    expect((await repo.getKnowledgeItem(detected.id))!.status).toBe('active');
    expect(result.outcomes[0].nearDuplicateId).toBe(detected.id);
  });

  it('does the same for a recorded decision', async () => {
    const { detected, named } = await seedPair('decision');
    const { category: _category, ...decision } = incoming('decision');
    const result = await recordDecisionDirect(projectId, { ...decision, supersedes: named.id });

    expect(result.superseded?.id).toBe(named.id);
    expect((await repo.getKnowledgeItem(named.id))!.status).toBe('superseded');
    expect((await repo.getKnowledgeItem(detected.id))!.status).toBe('active');
    expect(result.nearDuplicate?.id).toBe(detected.id);
  });
});
