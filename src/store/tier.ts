import { getClient, withClientTransaction } from './database.js';
import * as repo from './repository.js';
import type { CommitChange } from '../core/types.js';

/**
 * Confirmed-useful feedback events required before an asserted item is promoted. One use
 * can be a coincidence of phrasing; two independent confirmations are the item earning
 * its place. Kept deliberately low because feedback is rare — agents report it after
 * actually using a result, not on every retrieval.
 */
export const VERIFY_THRESHOLD = 2;

export type TierChange = {
  itemId: string;
  tier: 'asserted' | 'verified';
  reason: 'promoted' | 'demoted';
};

/**
 * The one place feedback changes an item's standing. Telemetry recording stays in
 * access-feedback.ts and still never alters retrieval by itself; standing is a separate,
 * deliberate consequence applied here, so the boundary between "we log what happened"
 * and "what happened has weight" is a function call you can find.
 *
 * Promotion needs VERIFY_THRESHOLD confirmed-useful events. A correction demotes
 * immediately and unconditionally: one proof of wrongness outweighs any history of
 * usefulness — the poisoning literature's core finding is confidence accumulating
 * without ground truth, and this is the ground-truth valve.
 */
export async function applyFeedbackToTier(
  projectId: string,
  itemId: string,
  feedback: { useful?: boolean; causedCorrection?: boolean },
): Promise<TierChange | null> {
  const item = await repo.getKnowledgeItem(itemId);
  if (!item || item.status !== 'active') return null;

  if (feedback.causedCorrection === true) {
    if (item.tier === 'asserted') return null;
    const updated = await repo.updateKnowledgeItem(itemId, { tier: 'asserted' });
    await repo.createKnowledgeCommit(projectId, `Demote to asserted: ${item.title}`, [
      { itemId, action: 'update', before: item, after: updated },
    ]);
    return { itemId, tier: 'asserted', reason: 'demoted' };
  }

  if (feedback.useful !== true || item.tier === 'verified') return null;

  // Counted from when the current tier began, not from the item's whole history. An
  // unbounded count made both resets cosmetic: a correction or a rewording dropped the
  // item to asserted, and the very next confirmation re-promoted it on the strength of
  // events that had confirmed a claim the item no longer makes.
  // NULL tier_since means a row written before the column existed: it has never been
  // reset, so its full history still belongs to its current standing.
  // `>=`, not `>`. `tier_since` is stamped at creation and at every reset, and ISO timestamps
  // are millisecond-granular — so a confirmation recorded in the same millisecond as the
  // boundary was dropped, and the item silently needed VERIFY_THRESHOLD + 1 events. It only
  // looked correct because most machines take a millisecond to get from one call to the next;
  // on CI's ubuntu runner three tests in this area failed at random depending on which side of
  // a tick they landed. An event AT the boundary belongs to the standing that began there.
  //
  // This does not weaken what the boundary is for. The event that causes a reset is a
  // correction or an edit, never `useful = 1`, so it is already excluded by the predicate
  // above it — the guard against re-promotion on stale confirmations is untouched.
  const row = (await getClient().execute({
    sql: `SELECT COUNT(*) AS confirmations FROM knowledge_access
          WHERE knowledge_item_id = ? AND surface = 'feedback' AND useful = 1
            AND retrieved_at >= COALESCE(?, '')`,
    args: [itemId, item.tierSince ?? null],
  })).rows[0];
  if (Number(row?.confirmations ?? 0) < VERIFY_THRESHOLD) return null;

  const updated = await repo.updateKnowledgeItem(itemId, { tier: 'verified' });
  await repo.createKnowledgeCommit(projectId, `Promote to verified: ${item.title}`, [
    { itemId, action: 'update', before: item, after: updated },
  ]);
  return { itemId, tier: 'verified', reason: 'promoted' };
}

/** Feedback recording must never fail because standing could not be updated. */
export async function applyFeedbackToTierBestEffort(
  projectId: string,
  itemId: string,
  feedback: { useful?: boolean; causedCorrection?: boolean },
): Promise<TierChange | null> {
  try {
    return await applyFeedbackToTier(projectId, itemId, feedback);
  } catch {
    return null;
  }
}

/**
 * Distinct days an item must be retrieved on, and distinct questions it must have answered,
 * before use alone earns it `verified`.
 *
 * Days rather than hits: twenty retrievals inside one session are one agent circling one
 * problem, which is the coincidence VERIFY_THRESHOLD's comment warns about, restated at a
 * different scale. Surviving three separate days means three separate occasions found it
 * worth surfacing. Distinct `query_fingerprint` adds the second axis — an item that only
 * ever answers the same question has been retrieved repeatedly, not confirmed repeatedly.
 */
export const OBSERVED_USE_MIN_DAYS = 3;
export const OBSERVED_USE_MIN_QUESTIONS = 3;

/**
 * Ceiling on promotions per run. Measured on a real 748-item store, the gate below selects
 * roughly 69 items on its first pass over an unpromoted corpus; applying all of them at one
 * session start is the corpus-wide standing change that `drift-auto.ts` deliberately refused
 * to make. Ten a run drains a backlog over a week of sessions and keeps any single run's
 * blast radius reviewable.
 */
export const OBSERVED_USE_MAX_PER_RUN = 10;

export type ObservedUseResult = {
  promoted: TierChange[];
  /** Eligible items the per-run cap left behind. Reported, never silently dropped. */
  deferred: number;
};

/**
 * Promote items the store has watched earn their place, without waiting for anyone to say so.
 *
 * WHY THIS EXISTS. `applyFeedbackToTier` is reachable only from `knowl_feedback`, a voluntary
 * call an agent has to choose to make. Measured 2026-08-09 on this project's own store: the
 * standing feature shipped 2026-07-31, every feedback event on record predates it (19 rows,
 * last one 2026-07-23), and in the nine days since it shipped the store served roughly 1,800
 * retrievals and received zero feedback events. 748 items, all `asserted`, zero promotions
 * ever recorded. The ladder was not too steep; its only input never arrived. Standing has to
 * be derived from what the store observes, not from what a caller volunteers.
 *
 * WHY IT CANNOT BE RECURRENCE ALONE. Retrieval count is not ground truth — an item can be
 * surfaced a hundred times and be wrong, and promoting on that is precisely the confidence
 * accumulating without ground truth that `applyFeedbackToTier` was written to prevent. So
 * recurrence only nominates. The gate is FALSIFIABILITY: an item qualifies only if it carries
 * `affected_paths`, which is what makes it reachable by the drift checker. An item with no
 * paths can never be marked `needs_review` by drift, so `freshness: 'fresh'` on it is not
 * evidence of anything — nothing was ever in a position to contradict it. Requiring paths
 * means every promotion is backed by a claim about the codebase that has had the opportunity
 * to fail and has not. Anything that ever caused a correction is excluded outright, on the
 * same "one proof of wrongness outweighs any history of usefulness" rule applied above.
 *
 * `driftingItemIds` closes the hole stored freshness leaves. The session-start drift check is
 * detection only — by deliberate design, it names what moved without flipping anything — so
 * an item whose files changed this morning still reads `fresh` until somebody runs
 * `knowl pr check` by hand. Resting the gate on that would make this feature depend on the
 * same voluntary act it exists to stop depending on, so the caller passes the live detection
 * result and anything currently drifting is refused regardless of what the column says.
 *
 * Demotion is untouched and stays immediate, unconditional and uncapped. This path only
 * ever moves items up, and only ever by one step.
 */
export async function promoteByObservedUse(
  projectId: string,
  driftingItemIds: readonly string[] = [],
): Promise<ObservedUseResult> {
  // Counted from `tier_since` for the same reason the feedback path counts from it: a reset
  // means the item no longer makes the claim its earlier retrievals were about.
  const rows = (await getClient().execute({
    sql: `SELECT ki.id AS id, COUNT(DISTINCT substr(ka.retrieved_at, 1, 10)) AS days
          FROM knowledge_items ki
          JOIN knowledge_access ka
            ON ka.knowledge_item_id = ki.id
           AND ka.surface != 'feedback'
           AND ka.retrieved_at >= COALESCE(ki.tier_since, '')
          WHERE ki.status = 'active'
            AND ki.tier = 'asserted'
            AND ki.freshness = 'fresh'
            AND ki.affected_paths IS NOT NULL
            AND ki.affected_paths != '[]'
            AND NOT EXISTS (
              SELECT 1 FROM knowledge_access bad
              WHERE bad.knowledge_item_id = ki.id
                AND bad.caused_correction = 1
                AND bad.retrieved_at >= COALESCE(ki.tier_since, '')
            )
          GROUP BY ki.id
          HAVING COUNT(DISTINCT substr(ka.retrieved_at, 1, 10)) >= ?
             AND COUNT(DISTINCT ka.query_fingerprint) >= ?`,
    args: [OBSERVED_USE_MIN_DAYS, OBSERVED_USE_MIN_QUESTIONS],
  })).rows;

  if (rows.length === 0) return { promoted: [], deferred: 0 };

  // Ordered here rather than in SQL so the cap and the deferred count read off one list.
  // Most-recurring first, id as the tiebreak, so a run is deterministic and a backlog drains
  // in a stable order instead of reshuffling every session.
  const drifting = new Set(driftingItemIds);
  const ranked = rows
    .map(row => ({ id: String(row.id), days: Number(row.days) }))
    .filter(candidate => !drifting.has(candidate.id))
    .sort((a, b) => b.days - a.days || a.id.localeCompare(b.id));
  if (ranked.length === 0) return { promoted: [], deferred: 0 };
  const selected = ranked.slice(0, OBSERVED_USE_MAX_PER_RUN);

  const promoted: TierChange[] = [];
  const changes: CommitChange[] = [];

  // Client-level for the same reason drift.ts gives: this runs on the session hook inside the
  // long-lived MCP server.
  await withClientTransaction(async tx => {
    for (const candidate of selected) {
      const item = await repo.getKnowledgeItem(candidate.id, tx);
      // Re-read inside the transaction: the query above ran outside it, and an item can be
      // edited, retired or corrected between selection and application.
      if (!item || item.status !== 'active' || item.tier !== 'asserted') continue;

      const updated = await repo.updateKnowledgeItem(candidate.id, { tier: 'verified' }, undefined, tx);
      changes.push({ itemId: candidate.id, action: 'update', before: item, after: updated });
      promoted.push({ itemId: candidate.id, tier: 'verified', reason: 'promoted' });
    }

    if (changes.length > 0) {
      await repo.createKnowledgeCommit(
        projectId,
        `Promote to verified by observed use: ${changes.length} item(s)`,
        changes,
        tx,
      );
    }
  });

  return { promoted, deferred: ranked.length - promoted.length };
}

/** Hooks must never fail the host: a failed promotion pass reads as "nothing promoted". */
export async function promoteByObservedUseBestEffort(
  projectId: string,
  driftingItemIds: readonly string[] = [],
): Promise<ObservedUseResult | null> {
  try {
    return await promoteByObservedUse(projectId, driftingItemIds);
  } catch {
    return null;
  }
}

/**
 * The session-start line. Silent when nothing moved — standing changes are routine, and a
 * line every session would train the reader to skip the block that also carries drift.
 */
export function describeObservedUsePromotions(result: ObservedUseResult | null): string | undefined {
  if (!result || result.promoted.length === 0) return undefined;
  const more = result.deferred > 0 ? ` ${result.deferred} more are eligible and will follow on later sessions.` : '';
  // No review command is named on purpose: nothing in the CLI lists items by tier today, and
  // pointing at a flag that does not exist is worse than pointing at nothing. The audit trail
  // is the knowledge commit each run writes.
  return `STANDING: ${result.promoted.length} knowledge item(s) promoted to verified on observed use — retrieved across ${OBSERVED_USE_MIN_DAYS}+ days for ${OBSERVED_USE_MIN_QUESTIONS}+ distinct questions, with their cited files still clean.${more} A correction demotes immediately.`;
}
