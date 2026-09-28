import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
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

  it('lists the most recent retirement first, whatever order the items were created in', async () => {
    const subjects = [
      { title: 'Session cookie lifetime', held: 'Session cookies expire after 8 hours.', swap: 'Session cookies expire after 90 days.' },
      { title: 'Backup retention window', held: 'Backups are retained for 35 days.', swap: 'Backups are retained for 2 days.' },
    ];
    const ids: string[] = [];
    for (const s of subjects) {
      ids.push((await storeKnowledgeItemDeduped(projectId, { category: 'constraint', title: s.title, content: s.held, provenance: 'observed' })).item.id);
    }
    for (const s of subjects) {
      expect((await storeKnowledgeItemDeduped(projectId, { category: 'constraint', title: s.title, content: s.swap })).superseded).toBeDefined();
    }
    // Pinned clocks, the first-created retired earlier: two retirements in one test can land in
    // the same millisecond, and store order alone would then pass without any sort.
    const stamp = (id: string, hoursAgo: number) => getClient().execute({
      sql: 'UPDATE knowledge_items SET updated_at = ? WHERE id = ?',
      args: [new Date(Date.now() - hoursAgo * 3_600_000).toISOString(), id],
    });
    await stamp(ids[0], 2);
    await stamp(ids[1], 1);

    const { retired } = await scanContradictions();
    expect(retired.map(row => row.retired.id)).toEqual([ids[1], ids[0]]);
  });

  it('says a replacement is no longer active once the swap has been undone', async () => {
    const held = await seed('observed');
    const swap = await storeKnowledgeItemDeduped(projectId, {
      category: 'constraint', title: 'Access token lifetime', content: 'Access tokens must expire after 30 days.',
    });
    // A different title, so only the explicit `supersedes` -- the documented undo -- can retire B.
    const undo = await storeKnowledgeItemDeduped(projectId, {
      category: 'constraint', title: 'Token expiry restored', content: 'Access tokens must expire after 15 minutes.',
      provenance: 'observed', supersedes: swap.item.id,
    });
    expect(undo.superseded?.id).toBe(swap.item.id);

    const row = (await scanContradictions()).retired.find(r => r.retired.id === held.item.id);
    expect(row?.replacedBy?.id).toBe(swap.item.id);
    expect(row?.replacedBy?.status).toBe('superseded');
  });

  it('lists a retirement whose replacement still stands before a newer one already undone', async () => {
    const live = (await storeKnowledgeItemDeduped(projectId, {
      category: 'constraint', title: 'Session cookie lifetime', content: 'Session cookies expire after 8 hours.', provenance: 'observed',
    })).item.id;
    await storeKnowledgeItemDeduped(projectId, {
      category: 'constraint', title: 'Session cookie lifetime', content: 'Session cookies expire after 90 days.',
    });
    const undone = (await storeKnowledgeItemDeduped(projectId, {
      category: 'constraint', title: 'Backup retention window', content: 'Backups are retained for 35 days.', provenance: 'observed',
    })).item.id;
    const swap = await storeKnowledgeItemDeduped(projectId, {
      category: 'constraint', title: 'Backup retention window', content: 'Backups are retained for 2 days.',
    });
    await storeKnowledgeItemDeduped(projectId, {
      category: 'constraint', title: 'Backup retention window', content: 'Backups are retained for 35 days, restored.',
      provenance: 'observed', supersedes: swap.item.id,
    });
    // The undone retirement is the newer one, so newest-first alone would list it first.
    const stamp = (id: string, hoursAgo: number) => getClient().execute({
      sql: 'UPDATE knowledge_items SET updated_at = ? WHERE id = ?',
      args: [new Date(Date.now() - hoursAgo * 3_600_000).toISOString(), id],
    });
    await stamp(live, 2);
    await stamp(undone, 1);

    const { retired } = await scanContradictions();
    expect(retired.map(row => row.retired.id)).toEqual([live, undone]);
    expect(retired.map(row => row.replacedBy?.status)).toEqual(['active', 'superseded']);
  });

  it('does not demote a verified fact retired with nothing named in its place', async () => {
    const orphan = (await seed('observed', 'Refresh token rotation', 'one use')).item.id;
    await repo.updateKnowledgeItem(orphan, { status: 'superseded' });
    const undone = (await seed('observed', 'Backup retention window', '35 days')).item.id;
    const swap = await storeKnowledgeItemDeduped(projectId, {
      category: 'constraint', title: 'Backup retention window', content: 'Backups are retained for 2 days.',
    });
    await storeKnowledgeItemDeduped(projectId, {
      category: 'constraint', title: 'Backup retention restored', content: 'Backups are retained for 35 days.',
      provenance: 'observed', supersedes: swap.item.id,
    });
    const stamp = (id: string, hoursAgo: number) => getClient().execute({
      sql: 'UPDATE knowledge_items SET updated_at = ? WHERE id = ?',
      args: [new Date(Date.now() - hoursAgo * 3_600_000).toISOString(), id],
    });
    await stamp(orphan, 2);
    await stamp(undone, 1);

    const { retired } = await scanContradictions();
    expect(retired.map(row => row.retired.id)).toEqual([orphan, undone]);
    expect(retired[0].replacedBy).toBeNull();
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
