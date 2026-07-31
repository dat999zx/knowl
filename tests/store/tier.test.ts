import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getClient, getDb, initDb } from '../../src/store/database.js';
import { scoreCandidates } from '../../src/store/agent-query.js';
import { recordKnowledgeFeedback } from '../../src/store/access-feedback.js';
import { applyFeedbackToTier } from '../../src/store/tier.js';
import * as repo from '../../src/store/repository.js';
import type { KnowledgeItem } from '../../src/core/types.js';

const ROOT = path.resolve('.knowl-tier-test');

describe('evidence tier and provenance', () => {
  let projectId = '';

  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'Tier test')).id;
  });

  beforeEach(async () => {
    const db = getDb() as any;
    await db.run(sql`DELETE FROM knowledge_access`);
    await db.run(sql`DELETE FROM knowledge_items`);
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('every write starts asserted, carrying its provenance class', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Observed fact', content: 'Seen in a test run.', provenance: 'observed',
    });
    expect(item.tier).toBe('asserted');
    expect(item.provenance).toBe('observed');

    const legacy = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Unclassified fact', content: 'Written with no class.',
    });
    expect(legacy.provenance).toBeNull();
  });

  it('promotes only at the confirmation threshold, then demotes on correction', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Useful fact', content: 'Confirmed by use twice.',
    });

    await recordKnowledgeFeedback({ itemId: item.id, used: true, useful: true });
    expect(await applyFeedbackToTier(projectId, item.id, { useful: true })).toBeNull();
    expect((await repo.getKnowledgeItem(item.id))?.tier).toBe('asserted');

    await recordKnowledgeFeedback({ itemId: item.id, used: true, useful: true });
    const promoted = await applyFeedbackToTier(projectId, item.id, { useful: true });
    expect(promoted).toEqual({ itemId: item.id, tier: 'verified', reason: 'promoted' });
    expect((await repo.getKnowledgeItem(item.id))?.tier).toBe('verified');

    const demoted = await applyFeedbackToTier(projectId, item.id, { causedCorrection: true });
    expect(demoted).toEqual({ itemId: item.id, tier: 'asserted', reason: 'demoted' });
    expect((await repo.getKnowledgeItem(item.id))?.tier).toBe('asserted');
  });

  it('a content edit resets verified to asserted — verified means verified-verbatim', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Edited fact', content: 'Original wording.',
    });
    await repo.updateKnowledgeItem(item.id, { tier: 'verified' });

    const touched = await repo.updateKnowledgeItem(item.id, { content: 'Reworded claim.' });
    expect(touched.tier).toBe('asserted');

    // A non-content update leaves earned standing alone.
    await repo.updateKnowledgeItem(item.id, { tier: 'verified' });
    const statusOnly = await repo.updateKnowledgeItem(item.id, { freshness: 'stale' });
    expect(statusOnly.tier).toBe('verified');
  });

  it('ranks verified above asserted and observed above inferred, all else equal', () => {
    const base = (id: string, overrides: Partial<KnowledgeItem>): { item: KnowledgeItem; bm25Rank: number } => ({
      item: {
        id, category: 'fact', status: 'active', title: 'Same claim', content: 'Same content.',
        freshness: 'fresh', confidence: 1, tier: 'asserted', provenance: null,
        version: 1, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z',
      } as KnowledgeItem,
      bm25Rank: 1,
    });

    const tierRanked = scoreCandidates([
      base('asserted-item', {}),
      { ...base('verified-item', {}), item: { ...base('verified-item', {}).item, tier: 'verified' } },
    ], { limit: 2, usingVector: false });
    expect(tierRanked[0].item.id).toBe('verified-item');

    const provenanceRanked = scoreCandidates([
      { ...base('inferred-item', {}), item: { ...base('inferred-item', {}).item, provenance: 'inferred' } },
      { ...base('observed-item', {}), item: { ...base('observed-item', {}).item, provenance: 'observed' } },
    ], { limit: 2, usingVector: false });
    expect(provenanceRanked[0].item.id).toBe('observed-item');
  });

  it('round-trips tier and provenance through the row mapping', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'constraint', title: 'Inferred limit', content: 'Concluded from one log line.', provenance: 'inferred',
    });
    await repo.updateKnowledgeItem(item.id, { tier: 'verified' });

    const row = (await getClient().execute({
      sql: 'SELECT tier, provenance FROM knowledge_items WHERE id = ?',
      args: [item.id],
    })).rows[0];
    expect(String(row.tier)).toBe('verified');
    expect(String(row.provenance)).toBe('inferred');

    const mapped = await repo.getKnowledgeItem(item.id);
    expect(mapped?.tier).toBe('verified');
    expect(mapped?.provenance).toBe('inferred');
  });
});
