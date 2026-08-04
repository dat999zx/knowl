import { getClient } from './database.js';
import * as repo from './repository.js';

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
