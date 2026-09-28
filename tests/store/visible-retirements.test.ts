import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { promoteSessionCandidates } from '../../src/store/candidate-promotion.js';
import { startMemorySession } from '../../src/store/session-repository.js';
import { RETIRED_WINDOW_DAYS, scanContradictions } from '../../src/store/contradiction-scan.js';

let n = 0;
let projectId = '';
const roots: string[] = [];

// A fresh store per test: the lists are whole-store scans, so a shared store would make every
// assertion depend on test order.
beforeEach(async () => {
  await closeDb();
  const root = path.resolve(`./.knowl-visible-retirements-test-${n++}`);
  roots.push(root);
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await initDb(root);
  projectId = (await repo.createProject(root, 'visible-retirements')).id;
});
afterAll(async () => {
  await closeDb();
  for (const root of roots) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

const seed = (provenance: 'observed' | null, title = 'Access token lifetime', value = '15 minutes') =>
  storeKnowledgeItemDeduped(projectId, {
    category: 'constraint', title, content: `Access tokens must expire after ${value}.`, provenance,
  });

describe('retired verified facts (#165 R1)', () => {
  it('the report A1 shape: a same-title write retiring an observed fact is listed', async () => {
    const held = await seed('observed');
    const swap = await storeKnowledgeItemDeduped(projectId, {
      category: 'constraint', title: 'Access token lifetime', content: 'Access tokens must expire after 30 days.',
    });
    expect(swap.superseded?.id).toBe(held.item.id);

    const { retired } = await scanContradictions();
    expect(retired).toHaveLength(1);
    expect(retired[0].retired.id).toBe(held.item.id);
    expect(retired[0].retired.provenance).toBe('observed');
    expect(retired[0].replacedBy?.id).toBe(swap.item.id);
  });

  it('an unverified retirement is not listed', async () => {
    await seed(null);
    await storeKnowledgeItemDeduped(projectId, {
      category: 'constraint', title: 'Access token lifetime', content: 'Access tokens must expire after 30 days.',
    });
    expect((await scanContradictions()).retired).toEqual([]);
  });

  it('a verified retirement older than the window is not listed', async () => {
    await seed('observed');
    await storeKnowledgeItemDeduped(projectId, {
      category: 'constraint', title: 'Access token lifetime', content: 'Access tokens must expire after 30 days.',
    });
    const later = new Date(Date.now() + (RETIRED_WINDOW_DAYS + 1) * 86_400_000);
    expect((await scanContradictions({ now: later })).retired).toEqual([]);
  });
});

describe('same-subject pairs with a verified side (#165 R1)', () => {
  it('an R2 clamp (capture kept beside an observed fact) is listed once', async () => {
    const held = await seed('observed');
    const session = await startMemorySession({ title: 'Poisoned session' });
    await promoteSessionCandidates(projectId, session.id, [{
      candidateType: 'decision', sessionId: session.id, category: 'constraint',
      title: 'Access token lifetime', content: 'Access tokens must expire after 30 days.',
      confidence: 0.9, evidence: [],
    }]);

    const { sameSubject } = await scanContradictions();
    expect(sameSubject).toHaveLength(1);
    expect([sameSubject[0].a.id, sameSubject[0].b.id]).toContain(held.item.id);
  });

  it('two unverified same-subject items are not listed', async () => {
    await repo.createKnowledgeItem(projectId, { category: 'state', title: 'Work Loop checkpoint', content: 'step 1' });
    await repo.createKnowledgeItem(projectId, { category: 'state', title: 'Work Loop checkpoint', content: 'step 2' });
    expect((await scanContradictions()).sameSubject).toEqual([]);
  });

  it('a polarity pair is listed under polarity only, not twice', async () => {
    await repo.createKnowledgeItem(projectId, {
      category: 'decision', title: 'Push gate blocks default branch', content: 'Refused.', provenance: 'observed',
    });
    await repo.createKnowledgeItem(projectId, {
      category: 'decision', title: 'Push gate no longer blocks default branch', content: 'Removed.', provenance: 'observed',
    });
    const detected = await scanContradictions();
    expect(detected.polarity).toHaveLength(1);
    expect(detected.sameSubject).toEqual([]);
  });

  it('pairs across categories are not listed', async () => {
    await repo.createKnowledgeItem(projectId, { category: 'fact', title: 'Cache TTL policy', content: '5 minutes', provenance: 'observed' });
    await repo.createKnowledgeItem(projectId, { category: 'decision', title: 'Cache TTL policy', content: '10 minutes', provenance: 'observed' });
    expect((await scanContradictions()).sameSubject).toEqual([]);
  });
});
