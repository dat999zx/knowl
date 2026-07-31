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

  const row = (await getClient().execute({
    sql: `SELECT COUNT(*) AS confirmations FROM knowledge_access
          WHERE knowledge_item_id = ? AND surface = 'feedback' AND useful = 1`,
    args: [itemId],
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
