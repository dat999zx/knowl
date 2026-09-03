import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getClient, getDb, initDb } from '../../src/store/database.js';
import { scoreCandidates } from '../../src/store/agent-query.js';
import { recordKnowledgeFeedback } from '../../src/store/access-feedback.js';
import {
  applyFeedbackToTier,
  OBSERVED_USE_MAX_PER_RUN,
  OBSERVED_USE_MIN_DAYS,
  OBSERVED_USE_MIN_QUESTIONS,
  promoteByConfirmedFeedback,
  promoteByObservedUse,
  VERIFY_THRESHOLD,
} from '../../src/store/tier.js';
import { recordKnowledgeAccess } from '../../src/store/access-feedback.js';
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

  /**
   * One confirmed-useful feedback event, `day` calendar days after the item's CURRENT
   * `tier_since`. Anchored to the boundary rather than the wall clock for the reason the
   * observed-use suite gives: an edit or a correction moves the boundary, and wall-clock offsets
   * would leave pre-reset rows sitting after the new boundary. A minute past the boundary so the
   * `>=` test below is the only one that exercises the boundary instant itself.
   */
  async function confirmOnDay(itemId: string, day: number) {
    const since = Date.parse((await repo.getKnowledgeItem(itemId))!.tierSince!);
    await recordKnowledgeFeedback({
      itemId, used: true, useful: true,
      retrievedAt: new Date(since + day * 86_400_000 + 60_000).toISOString(),
    });
  }

  /** VERIFY_THRESHOLD confirmations on VERIFY_THRESHOLD distinct days. */
  async function confirmAcrossDays(itemId: string) {
    for (let day = 0; day < VERIFY_THRESHOLD; day++) await confirmOnDay(itemId, day);
  }

  /**
   * Put the item's boundary a month back. The reset tests need the climb to sit in the PAST:
   * a reset moves `tier_since` forward by milliseconds, so confirmations seeded on days after
   * a just-created boundary would still clear the new one and the test would pass an item it
   * is supposed to refuse -- the same trap the observed-use suite records below.
   */
  async function backdateBoundary(itemId: string) {
    await getClient().execute({
      sql: 'UPDATE knowledge_items SET tier_since = ? WHERE id = ?',
      args: [new Date(Date.now() - 30 * 86_400_000).toISOString(), itemId],
    });
  }

  it('promotes only at the confirmation threshold, then demotes on correction', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Useful fact', content: 'Confirmed by use twice.',
    });

    await confirmOnDay(item.id, 0);
    expect(await applyFeedbackToTier(projectId, item.id, { useful: true })).toBeNull();
    expect((await repo.getKnowledgeItem(item.id))?.tier).toBe('asserted');

    await confirmOnDay(item.id, 1);
    const promoted = await applyFeedbackToTier(projectId, item.id, { useful: true });
    expect(promoted).toEqual({ itemId: item.id, tier: 'verified', reason: 'promoted' });
    expect((await repo.getKnowledgeItem(item.id))?.tier).toBe('verified');

    const demoted = await applyFeedbackToTier(projectId, item.id, { causedCorrection: true });
    expect(demoted).toEqual({ itemId: item.id, tier: 'asserted', reason: 'demoted' });
    expect((await repo.getKnowledgeItem(item.id))?.tier).toBe('asserted');
  });

  // The comment above VERIFY_THRESHOLD promised "two independent confirmations" and the query
  // counted rows, so two knowl_feedback calls in one turn — one agent, one item, one source —
  // promoted. Measured on the project's own store: every item the row count would have promoted
  // was a burst inside a single session. Days are the unit the sibling path already uses.
  it('refuses a burst of confirmations inside one day — independent means separate days', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Bursty fact', content: 'Confirmed twice in seven minutes.',
    });
    const since = Date.parse((await repo.getKnowledgeItem(item.id))!.tierSince!);
    for (let minute = 1; minute <= VERIFY_THRESHOLD * 2; minute++) {
      await recordKnowledgeFeedback({
        itemId: item.id, used: true, useful: true,
        retrievedAt: new Date(since + minute * 60_000).toISOString(),
      });
    }

    expect(await applyFeedbackToTier(projectId, item.id, { useful: true })).toBeNull();
    expect((await repo.getKnowledgeItem(item.id))?.tier).toBe('asserted');

    // The same item, confirmed once more on another day, has now been confirmed independently.
    await confirmOnDay(item.id, 1);
    expect(await applyFeedbackToTier(projectId, item.id, { useful: true }))
      .toEqual({ itemId: item.id, tier: 'verified', reason: 'promoted' });
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
    await backdateBoundary(item.id);
    await confirmAcrossDays(item.id);
    await applyFeedbackToTier(projectId, item.id, { useful: true });
    expect((await repo.getKnowledgeItem(item.id))?.tier).toBe('verified');

    await repo.updateKnowledgeItem(item.id, { content: 'A materially different claim.' });
    expect((await repo.getKnowledgeItem(item.id))?.tier).toBe('asserted');

    // One confirmation of the NEW wording is below the threshold. The pre-edit events
    // confirmed words that no longer exist and must not count toward this promotion — and they
    // sit on days after the new boundary only if the boundary were ignored, which is the point.
    await confirmOnDay(item.id, 0);
    expect(await applyFeedbackToTier(projectId, item.id, { useful: true })).toBeNull();
    expect((await repo.getKnowledgeItem(item.id))?.tier).toBe('asserted');

    // A full threshold of post-edit confirmations does promote again.
    await confirmOnDay(item.id, 1);
    expect(await applyFeedbackToTier(projectId, item.id, { useful: true }))
      .toEqual({ itemId: item.id, tier: 'verified', reason: 'promoted' });
  });

  // The boundary is inclusive, and that is not cosmetic. `tier_since` is stamped at creation,
  // and the confirmation count used a strict `>` against it — so a confirmation landing in the
  // same millisecond as the boundary was silently dropped and the item needed VERIFY_THRESHOLD
  // + 1 events to promote. On Windows the clock had usually ticked and it passed; on CI's
  // ubuntu runner the loop finished inside one millisecond and `tier` stayed `asserted`. This
  // pins the semantics rather than the timing: the rows are written AT the boundary instant,
  // so it fails on every platform before the fix and passes on every platform after.
  it('counts a confirmation recorded in the same instant as the tier boundary', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Boundary fact', content: 'Confirmed at the instant it began.',
    });
    const boundary = (await repo.getKnowledgeItem(item.id))!.tierSince!;
    expect(boundary).toBeTruthy();

    // One row AT the boundary instant, and the rest on later days: the boundary row is the
    // one this test is about, and it must count as a day of its own.
    await getClient().execute({
      sql: `INSERT INTO knowledge_access (id, knowledge_item_id, surface, rank, useful, retrieved_at)
            VALUES (?, ?, 'feedback', 1, 1, ?)`,
      args: ['boundary-0', item.id, boundary],
    });
    for (let day = 1; day < VERIFY_THRESHOLD; day++) await confirmOnDay(item.id, day);

    expect(await applyFeedbackToTier(projectId, item.id, { useful: true }))
      .toEqual({ itemId: item.id, tier: 'verified', reason: 'promoted' });
  });

  it('a correction restarts the confirmation count — one useful event does not undo it', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Corrected fact', content: 'A claim proven wrong.',
    });
    await backdateBoundary(item.id);
    await confirmAcrossDays(item.id);
    await applyFeedbackToTier(projectId, item.id, { useful: true });
    expect((await repo.getKnowledgeItem(item.id))?.tier).toBe('verified');

    await recordKnowledgeFeedback({ itemId: item.id, used: true, causedCorrection: true });
    await applyFeedbackToTier(projectId, item.id, { causedCorrection: true });
    expect((await repo.getKnowledgeItem(item.id))?.tier).toBe('asserted');

    // Proof of wrongness must cost more than a single subsequent confirmation.
    await confirmOnDay(item.id, 0);
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

    // No boundary to anchor to, so the days are absolute — and in the past, which is where a
    // pre-column row's confirmations actually are.
    for (let day = 0; day < VERIFY_THRESHOLD; day++) {
      await recordKnowledgeFeedback({
        itemId: item.id, used: true, useful: true,
        retrievedAt: new Date(Date.UTC(2026, 6, 20 + day, 12)).toISOString(),
      });
    }
    expect(await applyFeedbackToTier(projectId, item.id, { useful: true }))
      .toEqual({ itemId: item.id, tier: 'verified', reason: 'promoted' });
  });

  it('ranks verified above asserted and observed above inferred, all else equal', () => {
    const base = (id: string, _overrides?: Partial<KnowledgeItem>): { item: KnowledgeItem; bm25Rank: number } => ({
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

// Its own root: the suite above holds an open handle on its database for the whole file, and
// on Windows re-initialising the same path fails with EBUSY rather than silently reopening.
const OBSERVED_ROOT = path.resolve('.knowl-observed-use-test');

describe('standing earned by observed use', () => {
  let projectId = '';

  beforeAll(async () => {
    await fs.rm(OBSERVED_ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(OBSERVED_ROOT, '.knowl'), { recursive: true });
    await initDb(OBSERVED_ROOT);
    projectId = (await repo.createProject(OBSERVED_ROOT, 'Observed use test')).id;
  });

  beforeEach(async () => {
    const db = getDb() as any;
    await db.run(sql`DELETE FROM knowledge_access`);
    await db.run(sql`DELETE FROM knowledge_items`);
    // Commits too, unlike the suite above: this one asserts on the commit log itself, and a
    // commit left by the previous test reads as a second promotion from this one.
    // knowledge_commit_items cascades, so the index clears with it.
    await db.run(sql`DELETE FROM knowledge_commits`);
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(OBSERVED_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  async function seedItem(title: string, options: { paths?: string[] | null } = {}) {
    return repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title,
      content: `${title} — content.`,
      affectedPaths: options.paths === undefined ? ['src/store/tier.ts'] : options.paths,
    });
  }

  /**
   * One retrieval per day, each asking a different question, anchored to the item's CURRENT
   * `tier_since` rather than to the wall clock. The pass counts only from that boundary, and
   * an edit moves it — so wall-clock offsets would leave the pre-edit rows sitting after the
   * new boundary and the reset test would pass an item it should have refused. Reading the
   * boundary each call is what makes "an edit restarts the climb" actually testable.
   */
  async function seedRetrievals(itemId: string, days: number, options: { query?: string } = {}) {
    const since = Date.parse((await repo.getKnowledgeItem(itemId))!.tierSince!);
    for (let day = 0; day < days; day++) {
      await recordKnowledgeAccess({
        itemId,
        query: options.query ?? `distinct question ${day}`,
        surface: 'mcp',
        rank: 0,
        retrievedAt: new Date(since + day * 86_400_000 + 60_000).toISOString(),
      });
    }
  }

  it('promotes an item the store watched answer distinct questions across distinct days', async () => {
    const item = await seedItem('Recurring fact');
    await seedRetrievals(item.id, OBSERVED_USE_MIN_DAYS);

    const result = await promoteByObservedUse(projectId);
    expect(result.promoted).toEqual([{ itemId: item.id, tier: 'verified', reason: 'promoted' }]);
    expect(result.deferred).toBe(0);
    expect((await repo.getKnowledgeItem(item.id))?.tier).toBe('verified');
  });

  it('writes a knowledge commit, so every automatic promotion stays auditable', async () => {
    const item = await seedItem('Audited fact');
    await seedRetrievals(item.id, OBSERVED_USE_MIN_DAYS);
    await promoteByObservedUse(projectId);

    const row = (await getClient().execute({
      sql: `SELECT COUNT(*) AS n FROM knowledge_commits WHERE message LIKE 'Promote to verified by observed use%'`,
    })).rows[0];
    expect(Number(row.n)).toBe(1);
  });

  // The falsifiability gate, and the reason the whole feature is defensible. An item with no
  // affected paths is unreachable by the drift checker, so nothing was ever in a position to
  // contradict it — promoting it on use alone would be confidence accumulating without ground
  // truth, which is the failure the feedback path was built to avoid.
  it('refuses an item with no affected paths, however often it is retrieved', async () => {
    const item = await seedItem('Unfalsifiable fact', { paths: null });
    await seedRetrievals(item.id, OBSERVED_USE_MIN_DAYS + 3);

    expect((await promoteByObservedUse(projectId)).promoted).toEqual([]);
    expect((await repo.getKnowledgeItem(item.id))?.tier).toBe('asserted');
  });

  it('refuses a burst inside one day — recurrence is days, not hits', async () => {
    const item = await seedItem('Bursty fact');
    const oneMoment = new Date(Date.parse(item.tierSince!) + 60_000).toISOString();
    for (let hit = 0; hit < 20; hit++) {
      await recordKnowledgeAccess({
        itemId: item.id, query: `question ${hit}`, surface: 'mcp', rank: 0, retrievedAt: oneMoment,
      });
    }

    expect((await promoteByObservedUse(projectId)).promoted).toEqual([]);
  });

  it('refuses an item that only ever answered one question', async () => {
    const item = await seedItem('One-question fact');
    await seedRetrievals(item.id, OBSERVED_USE_MIN_DAYS + 2, { query: 'the only question ever asked' });

    expect(OBSERVED_USE_MIN_QUESTIONS).toBeGreaterThan(1);
    expect((await promoteByObservedUse(projectId)).promoted).toEqual([]);
  });

  it('refuses anything that ever caused a correction', async () => {
    const item = await seedItem('Once-wrong fact');
    await seedRetrievals(item.id, OBSERVED_USE_MIN_DAYS);
    await recordKnowledgeFeedback({ itemId: item.id, used: true, causedCorrection: true });

    expect((await promoteByObservedUse(projectId)).promoted).toEqual([]);
  });

  it('refuses an item whose files have moved, whatever the freshness column says', async () => {
    const item = await seedItem('Drifting fact');
    await seedRetrievals(item.id, OBSERVED_USE_MIN_DAYS);
    await getClient().execute({
      sql: 'UPDATE knowledge_items SET last_drift_at = ? WHERE id = ?',
      args: [new Date().toISOString(), item.id],
    });
    // Detection does not flip freshness, so the column still reads fresh — which is exactly
    // the state that would wrongly promote if the drift observation were not consulted.
    expect((await repo.getKnowledgeItem(item.id))?.freshness).toBe('fresh');

    expect((await promoteByObservedUse(projectId)).promoted).toEqual([]);
  });

  // The regression the live-candidate-list version could not catch. Auto-drift advances its
  // watermark as soon as it has reported a window, so the session after the one that saw the
  // change computes no candidates at all — and the item still reads `fresh`, because
  // detection deliberately never flipped it. Anything reading the in-session list promotes
  // here; only a stored observation still refuses.
  it('keeps refusing after the drift window has passed, until someone reviews the item', async () => {
    const item = await seedItem('Long-drifting fact');
    await seedRetrievals(item.id, OBSERVED_USE_MIN_DAYS);
    await getClient().execute({
      sql: 'UPDATE knowledge_items SET last_drift_at = ? WHERE id = ?',
      args: [new Date().toISOString(), item.id],
    });

    // Sessions later. No drift candidates anywhere, nothing flagged, freshness untouched.
    expect((await promoteByObservedUse(projectId)).promoted).toEqual([]);
    expect((await promoteByObservedUse(projectId)).promoted).toEqual([]);

    // A review discharges the observation, and only then does use count again.
    await repo.updateKnowledgeItem(item.id, { freshness: 'fresh' });
    expect((await promoteByObservedUse(projectId)).promoted).toHaveLength(1);
  });

  it('refuses an item already flagged needs_review', async () => {
    const item = await seedItem('Stale fact');
    await seedRetrievals(item.id, OBSERVED_USE_MIN_DAYS);
    await repo.updateKnowledgeItem(item.id, { freshness: 'needs_review' });

    expect((await promoteByObservedUse(projectId)).promoted).toEqual([]);
  });

  it('caps a run and reports the remainder rather than silently dropping it', async () => {
    const overflow = 3;
    for (let n = 0; n < OBSERVED_USE_MAX_PER_RUN + overflow; n++) {
      const item = await seedItem(`Eligible fact ${n}`);
      await seedRetrievals(item.id, OBSERVED_USE_MIN_DAYS);
    }

    const first = await promoteByObservedUse(projectId);
    expect(first.promoted).toHaveLength(OBSERVED_USE_MAX_PER_RUN);
    expect(first.deferred).toBe(overflow);

    // The backlog drains on later runs instead of stranding.
    const second = await promoteByObservedUse(projectId);
    expect(second.promoted).toHaveLength(overflow);
    expect(second.deferred).toBe(0);
    expect((await promoteByObservedUse(projectId)).promoted).toEqual([]);
  });

  it('counts only from tier_since, so an edit restarts the climb', async () => {
    const item = await seedItem('Reworded recurring fact');
    // The climb has to sit in the PAST for this to test anything. An edit moves `tier_since`
    // forward by milliseconds, so rows seeded from the original boundary would still clear the
    // new one and the test would pass an item it is supposed to refuse — which is exactly how
    // it failed the first time it ran.
    await getClient().execute({
      sql: 'UPDATE knowledge_items SET tier_since = ? WHERE id = ?',
      args: [new Date(Date.now() - 30 * 86_400_000).toISOString(), item.id],
    });
    await seedRetrievals(item.id, OBSERVED_USE_MIN_DAYS);
    expect((await promoteByObservedUse(projectId)).promoted).toHaveLength(1);

    await repo.updateKnowledgeItem(item.id, { content: 'A materially different claim.' });
    expect((await repo.getKnowledgeItem(item.id))?.tier).toBe('asserted');
    // The retrievals above confirmed wording this edit replaced; they must not carry over.
    expect((await promoteByObservedUse(projectId)).promoted).toEqual([]);

    // Use of the new wording earns it back.
    await seedRetrievals(item.id, OBSERVED_USE_MIN_DAYS);
    expect((await promoteByObservedUse(projectId)).promoted).toHaveLength(1);
  });
});

// Its own root again, for the same EBUSY reason as the suite above.
const CONFIRMED_ROOT = path.resolve('.knowl-confirmed-feedback-test');

/**
 * The feedback path's re-evaluation. `applyFeedbackToTier` runs at the instant a feedback row
 * is written and never again, so an item whose confirmations crossed the bar before that path
 * existed satisfies the predicate and is never asked. This sweep is the asking.
 */
describe('standing earned by confirmed feedback the edge never saw', () => {
  let projectId = '';

  beforeAll(async () => {
    await fs.rm(CONFIRMED_ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(CONFIRMED_ROOT, '.knowl'), { recursive: true });
    await initDb(CONFIRMED_ROOT);
    projectId = (await repo.createProject(CONFIRMED_ROOT, 'Confirmed feedback test')).id;
  });

  beforeEach(async () => {
    const db = getDb() as any;
    await db.run(sql`DELETE FROM knowledge_access`);
    await db.run(sql`DELETE FROM knowledge_items`);
    await db.run(sql`DELETE FROM knowledge_commits`);
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(CONFIRMED_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  const seedItem = (title: string) => repo.createKnowledgeItem(projectId, {
    category: 'fact', title, content: `${title} — content.`,
  });

  /** A confirmation `day` days after the item's current boundary, written with no promotion pass. */
  async function confirmOnDay(itemId: string, day: number) {
    const since = Date.parse((await repo.getKnowledgeItem(itemId))!.tierSince!);
    await recordKnowledgeFeedback({
      itemId, used: true, useful: true,
      retrievedAt: new Date(since + day * 86_400_000 + 60_000).toISOString(),
    });
  }

  it('promotes an item whose confirmations already clear the bar', async () => {
    // The shape on the project's own store: rows written before the promotion path was wired,
    // so nothing ever evaluated them.
    const item = await seedItem('Confirmed before the path existed');
    for (let day = 0; day < VERIFY_THRESHOLD; day++) await confirmOnDay(item.id, day);
    expect((await repo.getKnowledgeItem(item.id))?.tier).toBe('asserted');

    const result = await promoteByConfirmedFeedback(projectId);
    expect(result.promoted).toEqual([{ itemId: item.id, tier: 'verified', reason: 'promoted' }]);
    expect(result.deferred).toBe(0);
    expect((await repo.getKnowledgeItem(item.id))?.tier).toBe('verified');

    const row = (await getClient().execute({
      sql: `SELECT COUNT(*) AS n FROM knowledge_commits WHERE message LIKE 'Promote to verified by confirmed feedback%'`,
    })).rows[0];
    expect(Number(row.n)).toBe(1);

    // Idempotent: a second pass finds nothing left to do.
    expect((await promoteByConfirmedFeedback(projectId)).promoted).toEqual([]);
  });

  it('applies the same day rule as the edge — a single-day burst is not confirmed', async () => {
    const item = await seedItem('Burst before the path existed');
    const since = Date.parse((await repo.getKnowledgeItem(item.id))!.tierSince!);
    for (let minute = 1; minute <= 4; minute++) {
      await recordKnowledgeFeedback({
        itemId: item.id, used: true, useful: true,
        retrievedAt: new Date(since + minute * 60_000).toISOString(),
      });
    }

    expect((await promoteByConfirmedFeedback(projectId)).promoted).toEqual([]);
    expect((await repo.getKnowledgeItem(item.id))?.tier).toBe('asserted');
  });

  it('refuses a pre-column row that was ever corrected, however many confirmations it carries', async () => {
    // `tier_since` NULL means the demotion-and-reset that a correction performs today never
    // ran for this row, so its history is the only record that it was once proven wrong.
    const item = await seedItem('Legacy row with a correction in its past');
    await getClient().execute({ sql: 'UPDATE knowledge_items SET tier_since = NULL WHERE id = ?', args: [item.id] });
    for (let day = 0; day < VERIFY_THRESHOLD + 1; day++) {
      await recordKnowledgeFeedback({
        itemId: item.id, used: true, useful: true,
        retrievedAt: new Date(Date.UTC(2026, 6, 20 + day, 12)).toISOString(),
      });
    }
    await recordKnowledgeFeedback({
      itemId: item.id, used: true, causedCorrection: true,
      retrievedAt: new Date(Date.UTC(2026, 6, 25, 12)).toISOString(),
    });

    expect((await promoteByConfirmedFeedback(projectId)).promoted).toEqual([]);
    expect((await repo.getKnowledgeItem(item.id))?.tier).toBe('asserted');
  });

  it('counts only from tier_since, so confirmations of replaced wording do not carry over', async () => {
    const item = await seedItem('Reworded and confirmed');
    await getClient().execute({
      sql: 'UPDATE knowledge_items SET tier_since = ? WHERE id = ?',
      args: [new Date(Date.now() - 30 * 86_400_000).toISOString(), item.id],
    });
    for (let day = 0; day < VERIFY_THRESHOLD; day++) await confirmOnDay(item.id, day);
    await repo.updateKnowledgeItem(item.id, { content: 'A materially different claim.' });

    expect((await promoteByConfirmedFeedback(projectId)).promoted).toEqual([]);
    expect((await repo.getKnowledgeItem(item.id))?.tier).toBe('asserted');
  });

  it('caps a run and reports what it left, like the observed-use pass', async () => {
    const overflow = 2;
    for (let n = 0; n < OBSERVED_USE_MAX_PER_RUN + overflow; n++) {
      const item = await seedItem(`Confirmed fact ${n}`);
      for (let day = 0; day < VERIFY_THRESHOLD; day++) await confirmOnDay(item.id, day);
    }

    const first = await promoteByConfirmedFeedback(projectId);
    expect(first.promoted).toHaveLength(OBSERVED_USE_MAX_PER_RUN);
    expect(first.deferred).toBe(overflow);
    const second = await promoteByConfirmedFeedback(projectId);
    expect(second.promoted).toHaveLength(overflow);
    expect(second.deferred).toBe(0);
  });
});
