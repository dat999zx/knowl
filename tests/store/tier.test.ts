import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getClient, getDb, initDb } from '../../src/store/database.js';
import { scoreCandidates } from '../../src/store/agent-query.js';
import { recordKnowledgeFeedback } from '../../src/store/access-feedback.js';
import { applyFeedbackToTier, VERIFY_THRESHOLD } from '../../src/store/tier.js';
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

  it('a content edit restarts the confirmation count — old useful events do not re-promote', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Reworded fact', content: 'Original wording.',
    });
    for (let i = 0; i < VERIFY_THRESHOLD; i++) {
      await recordKnowledgeFeedback({ itemId: item.id, used: true, useful: true });
      await applyFeedbackToTier(projectId, item.id, { useful: true });
    }
    expect((await repo.getKnowledgeItem(item.id))?.tier).toBe('verified');

    await repo.updateKnowledgeItem(item.id, { content: 'A materially different claim.' });
    expect((await repo.getKnowledgeItem(item.id))?.tier).toBe('asserted');

    // One confirmation of the NEW wording is below the threshold. The pre-edit events
    // confirmed words that no longer exist and must not count toward this promotion.
    await recordKnowledgeFeedback({ itemId: item.id, used: true, useful: true });
    expect(await applyFeedbackToTier(projectId, item.id, { useful: true })).toBeNull();
    expect((await repo.getKnowledgeItem(item.id))?.tier).toBe('asserted');

    // A full threshold of post-edit confirmations does promote again.
    await recordKnowledgeFeedback({ itemId: item.id, used: true, useful: true });
    expect(await applyFeedbackToTier(projectId, item.id, { useful: true }))
      .toEqual({ itemId: item.id, tier: 'verified', reason: 'promoted' });
  });

  it('a correction restarts the confirmation count — one useful event does not undo it', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Corrected fact', content: 'A claim proven wrong.',
    });
    for (let i = 0; i < VERIFY_THRESHOLD; i++) {
      await recordKnowledgeFeedback({ itemId: item.id, used: true, useful: true });
      await applyFeedbackToTier(projectId, item.id, { useful: true });
    }
    expect((await repo.getKnowledgeItem(item.id))?.tier).toBe('verified');

    await recordKnowledgeFeedback({ itemId: item.id, used: true, causedCorrection: true });
    await applyFeedbackToTier(projectId, item.id, { causedCorrection: true });
    expect((await repo.getKnowledgeItem(item.id))?.tier).toBe('asserted');

    // Proof of wrongness must cost more than a single subsequent confirmation.
    await recordKnowledgeFeedback({ itemId: item.id, used: true, useful: true });
    expect(await applyFeedbackToTier(projectId, item.id, { useful: true })).toBeNull();
    expect((await repo.getKnowledgeItem(item.id))?.tier).toBe('asserted');
  });

  it('counts the full history of a row written before tier_since existed', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Legacy row', content: 'Written before the column existed.',
    });
    // Exactly what the migration leaves behind: standing has never been reset here, so the
    // confirmations the row already carries still belong to its current tier.
    await getClient().execute({
      sql: 'UPDATE knowledge_items SET tier_since = NULL WHERE id = ?',
      args: [item.id],
    });
    expect((await repo.getKnowledgeItem(item.id))?.tierSince).toBeNull();

    for (let i = 0; i < VERIFY_THRESHOLD; i++) {
      await recordKnowledgeFeedback({ itemId: item.id, used: true, useful: true });
    }
    expect(await applyFeedbackToTier(projectId, item.id, { useful: true }))
      .toEqual({ itemId: item.id, tier: 'verified', reason: 'promoted' });
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
