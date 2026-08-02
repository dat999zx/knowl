import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { recordKnowledgeAccess, recordKnowledgeFeedback } from '../../src/store/access-feedback.js';
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

    // --ignore-access archives the hot item too.
    const forced = await previewKnowledgeGc(projectId, { now: NOW, ignoreAccess: true });
    const forcedArchived = forced.candidates.filter(candidate => candidate.action === 'archive').map(candidate => candidate.itemId);
    expect(forcedArchived).toContain(cold.id);
    expect(forcedArchived).toContain(hot.id);
  });

  it('lets explicit feedback outrank retrieval volume in both directions', async () => {
    // Retrieval alone is weak evidence of worth: an item that keeps surfacing in results it
    // does not belong in gets retrieved BECAUSE it is noise, and counting that as heat let the
    // worst rows earn the strongest protection from collection.
    const rejected = await repo.createKnowledgeItem(projectId, { category: 'state', title: 'Noisy state', content: 'Retrieved often, useful never.' });
    const used = await repo.createKnowledgeItem(projectId, { category: 'state', title: 'Quietly useful state', content: 'Retrieved once, actually used.' });
    await backdate(rejected.id);
    await backdate(used.id);

    for (let index = 0; index < 5; index++) {
      await recordKnowledgeAccess({ itemId: rejected.id, surface: 'agent_query', rank: 1, retrievedAt: NOW });
    }
    await recordKnowledgeFeedback({ itemId: rejected.id, used: true, useful: false, retrievedAt: NOW });

    // One old retrieval — cold by count and by recency — but marked genuinely useful.
    await recordKnowledgeAccess({ itemId: used.id, surface: 'agent_query', rank: 1, retrievedAt: OLD });
    await recordKnowledgeFeedback({ itemId: used.id, used: true, useful: true, retrievedAt: OLD });

    const archived = (await previewKnowledgeGc(projectId, { now: NOW }))
      .candidates.filter(candidate => candidate.action === 'archive').map(candidate => candidate.itemId);
    expect(archived).toContain(rejected.id);
    expect(archived).not.toContain(used.id);
  });
});

describe('spent one-shot records', () => {
  let projectId = '';
  const HANDOFF_ROOT = path.resolve('./.knowl-gc-oneshot-test');
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

  async function handoff(title: string, body: Record<string, unknown>, updatedAt: string) {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'state', title, content: JSON.stringify(body),
      tags: ['pending_handoff', 'claude'], conflictKey: 'pending-session-handoff:claude', conflictExclusive: false,
    } as any);
    await getClient().execute({ sql: 'UPDATE knowledge_items SET updated_at = ? WHERE id = ?', args: [updatedAt, item.id] });
    return item;
  }

  beforeAll(async () => {
    await fs.rm(HANDOFF_ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(HANDOFF_ROOT, '.knowl'), { recursive: true });
    await initDb(HANDOFF_ROOT);
    projectId = (await repo.createProject(HANDOFF_ROOT, 'gc-oneshot')).id;
  });
  afterAll(async () => { await closeDb(); await fs.rm(HANDOFF_ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('collects spent handoffs well inside the 60-day clock, and spares a live one', async () => {
    // These are one-shot: delivered to the NEXT session that starts. The old rule waited 60
    // days for a `state` item and then let `isHot` protect it anyway — and these get retrieved
    // precisely because they pollute unrelated result sets, so noise immunised itself.
    const superseded = await handoff('Older pending', { kind: 'rate_limit', failedAt: daysAgo(10), consumed: false }, daysAgo(10));
    const newest = await handoff('Newest pending', { kind: 'rate_limit', failedAt: daysAgo(1), consumed: false }, daysAgo(1));
    const consumed = await handoff('Already consumed', { kind: 'auth', failedAt: daysAgo(2), consumed: true }, daysAgo(2));

    // Make the spent ones look maximally "hot" — under the old rule this guaranteed survival.
    for (let index = 0; index < 6; index++) {
      await recordKnowledgeAccess({ itemId: superseded.id, surface: 'agent_query', rank: 1, retrievedAt: NOW });
      await recordKnowledgeAccess({ itemId: consumed.id, surface: 'agent_query', rank: 1, retrievedAt: NOW });
    }

    const archived = (await previewKnowledgeGc(projectId, { now: NOW }))
      .candidates.filter(candidate => candidate.action === 'archive').map(candidate => candidate.itemId);
    expect(archived).toContain(superseded.id);
    expect(archived).toContain(consumed.id);
    // The one still legitimately pending is not collected.
    expect(archived).not.toContain(newest.id);
  });

  it('collects a lone handoff nothing ever claimed', async () => {
    const stale = await handoff('Never claimed', { kind: 'provider_outage', failedAt: daysAgo(9), consumed: false }, daysAgo(9));
    const archived = (await previewKnowledgeGc(projectId, { now: NOW }))
      .candidates.filter(candidate => candidate.action === 'archive').map(candidate => candidate.itemId);
    expect(archived).toContain(stale.id);
  });
});
