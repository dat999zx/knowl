import { getClient, withClientTransaction } from './database.js';
import * as repo from './repository.js';
import type { CommitChange } from '../core/types.js';

/**
 * Distinct DAYS carrying a confirmed-useful feedback event before an asserted item is
 * promoted. One use can be a coincidence of phrasing; two independent confirmations are the
 * item earning its place. Kept deliberately low because feedback is rare — agents report it
 * after actually using a result, not on every retrieval.
 *
 * Days, not rows. The comment above has always said "independent" and the query counted
 * `COUNT(*)`, so two `knowl_feedback` calls in one turn, on one item, by one agent, promoted it
 * — one source counted twice, the correlated-confirmation bias the observed-use path below
 * already refuses at a different scale ("twenty retrievals inside one session are one agent
 * circling one problem"). Measured on this project's own store before the change (#223): every
 * item the row count would have promoted was a burst inside a single session — four events in
 * seven minutes on one, two four minutes apart on another — and under distinct days not one of
 * them clears the bar. Not `query_fingerprint`, which the observed-use path uses as its second
 * axis: `recordKnowledgeFeedback` carries no query, so every feedback row's fingerprint is NULL
 * and a distinct count over it is zero forever.
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
 * Promotion needs confirmed-useful events on VERIFY_THRESHOLD distinct days. A correction
 * demotes immediately and unconditionally: one proof of wrongness outweighs any history of
 * usefulness — the poisoning literature's core finding is confidence accumulating
 * without ground truth, and this is the ground-truth valve.
 *
 * This runs at the instant a feedback row is written and nowhere else, which is why
 * `promoteByConfirmedFeedback` exists: an item whose confirmations crossed the bar before this
 * path was wired, or while the path was disabled, satisfies the predicate and is never asked.
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
  if (await confirmedDaysSinceTierBegan(itemId, item.tierSince ?? null) < VERIFY_THRESHOLD) return null;

  const updated = await repo.updateKnowledgeItem(itemId, { tier: 'verified' });
  await repo.createKnowledgeCommit(projectId, `Promote to verified: ${item.title}`, [
    { itemId, action: 'update', before: item, after: updated },
  ]);
  return { itemId, tier: 'verified', reason: 'promoted' };
}

/**
 * The feedback path's one predicate, shared by the edge-triggered promotion above and the
 * sweep below so the two cannot disagree about what "confirmed" means.
 *
 * Counted from when the current tier began, not from the item's whole history. An
 * unbounded count made both resets cosmetic: a correction or a rewording dropped the
 * item to asserted, and the very next confirmation re-promoted it on the strength of
 * events that had confirmed a claim the item no longer makes.
 * NULL tier_since means a row written before the column existed: it has never been
 * reset, so its full history still belongs to its current standing.
 * `>=`, not `>`. `tier_since` is stamped at creation and at every reset, and ISO timestamps
 * are millisecond-granular — so a confirmation recorded in the same millisecond as the
 * boundary was dropped, and the item silently needed VERIFY_THRESHOLD + 1 events. It only
 * looked correct because most machines take a millisecond to get from one call to the next;
 * on CI's ubuntu runner three tests in this area failed at random depending on which side of
 * a tick they landed. An event AT the boundary belongs to the standing that began there.
 *
 * This does not weaken what the boundary is for. The event that causes a reset is a
 * correction or an edit, never `useful = 1`, so it is already excluded by the predicate
 * above it — the guard against re-promotion on stale confirmations is untouched.
 *
 * `substr(retrieved_at, 1, 10)` is the calendar day of an ISO timestamp, the same expression
 * `promoteByObservedUse` groups on. Two confirmations minutes apart are one day and count once.
 *
 * Always on the base client: a SQLite transaction belongs to the connection, so inside
 * `withClientTransaction` this statement is already part of it (see `database.ts`).
 */
async function confirmedDaysSinceTierBegan(itemId: string, tierSince: string | null): Promise<number> {
  const row = (await getClient().execute({
    sql: `SELECT COUNT(DISTINCT substr(retrieved_at, 1, 10)) AS days FROM knowledge_access
          WHERE knowledge_item_id = ? AND surface = 'feedback' AND useful = 1
            AND retrieved_at >= COALESCE(?, '')`,
    args: [itemId, tierSince],
  })).rows[0];
  return Number(row?.days ?? 0);
}

export type ConfirmedFeedbackResult = {
  promoted: TierChange[];
  /** Eligible items the per-run cap left behind. Reported, never silently dropped. */
  deferred: number;
};

/**
 * Promote every asserted item whose confirmations already clear the bar, because the
 * edge-triggered path never looks back.
 *
 * `applyFeedbackToTier` is reachable from `knowl_feedback` alone and runs solely at the
 * instant a feedback row is written; nothing re-evaluates. So any item that crossed the
 * threshold before that path existed — this project's own store holds one with three useful
 * events against a threshold of two, `tier_since` NULL, still `asserted` — stays unpromoted
 * forever, and a tightened predicate does not help an item the predicate is never run against
 * (#223). This is the re-evaluation, run once per session start beside `promoteByObservedUse`.
 *
 * The same predicate as the edge, deliberately, re-checked per item inside the transaction:
 * the candidate query is a cheap filter, and the per-item check is the one the feedback tool
 * would have applied had it fired. A correction since the tier began is excluded here where the
 * edge does not need to exclude it — a correction demotes and resets `tier_since` on the way
 * through, so the edge never sees one, but a pre-column row (`tier_since` NULL) with a
 * historic correction never had that reset applied, and "one proof of wrongness outweighs any
 * history of usefulness" is the rule this path exists to honour.
 *
 * Not gated on the drift check the way observed use is. Observed use promotes on recurrence,
 * which is only meaningful if something was in a position to contradict the item; a
 * confirmation is an agent saying the item was right, and needs no such witness. Capped the
 * same way, for the same blast-radius reason.
 */
export async function promoteByConfirmedFeedback(projectId: string): Promise<ConfirmedFeedbackResult> {
  const rows = (await getClient().execute({
    sql: `SELECT ki.id AS id, COUNT(DISTINCT substr(ka.retrieved_at, 1, 10)) AS days
          FROM knowledge_items ki
          JOIN knowledge_access ka
            ON ka.knowledge_item_id = ki.id
           AND ka.surface = 'feedback'
           AND ka.useful = 1
           AND ka.retrieved_at >= COALESCE(ki.tier_since, '')
          WHERE ki.status = 'active'
            AND ki.tier = 'asserted'
            AND NOT EXISTS (
              SELECT 1 FROM knowledge_access bad
              WHERE bad.knowledge_item_id = ki.id
                AND bad.caused_correction = 1
                AND bad.retrieved_at >= COALESCE(ki.tier_since, '')
            )
          GROUP BY ki.id
          HAVING COUNT(DISTINCT substr(ka.retrieved_at, 1, 10)) >= ?`,
    args: [VERIFY_THRESHOLD],
  })).rows;

  if (rows.length === 0) return { promoted: [], deferred: 0 };

  const ranked = rows
    .map(row => ({ id: String(row.id), days: Number(row.days) }))
    .sort((a, b) => b.days - a.days || a.id.localeCompare(b.id));
  const selected = ranked.slice(0, OBSERVED_USE_MAX_PER_RUN);

  const promoted: TierChange[] = [];
  const changes: CommitChange[] = [];

  await withClientTransaction(async tx => {
    for (const candidate of selected) {
      const item = await repo.getKnowledgeItem(candidate.id, tx);
      if (!item || item.status !== 'active' || item.tier !== 'asserted') continue;
      if (await confirmedDaysSinceTierBegan(candidate.id, item.tierSince ?? null) < VERIFY_THRESHOLD) continue;

      const updated = await repo.updateKnowledgeItem(candidate.id, { tier: 'verified' }, undefined, tx);
      changes.push({ itemId: candidate.id, action: 'update', before: item, after: updated });
      promoted.push({ itemId: candidate.id, tier: 'verified', reason: 'promoted' });
    }

    if (changes.length > 0) {
      await repo.createKnowledgeCommit(
        projectId,
        `Promote to verified by confirmed feedback: ${changes.length} item(s)`,
        changes,
        tx,
      );
    }
  });

  return { promoted, deferred: ranked.length - selected.length };
}

/** Hooks must never fail the host: a failed sweep reads as "nothing promoted". */
export async function promoteByConfirmedFeedbackBestEffort(projectId: string): Promise<ConfirmedFeedbackResult | null> {
  try {
    return await promoteByConfirmedFeedback(projectId);
  } catch {
    return null;
  }
}

/** The session-start line for the sweep. Silent when nothing moved, like its sibling below. */
export function describeConfirmedFeedbackPromotions(result: ConfirmedFeedbackResult | null): string | undefined {
  if (!result || result.promoted.length === 0) return undefined;
  const more = result.deferred > 0 ? ` ${result.deferred} more are eligible and will follow on later sessions.` : '';
  return `STANDING: ${result.promoted.length} knowledge item(s) promoted to verified on confirmed feedback — reported useful on ${VERIFY_THRESHOLD}+ separate days.${more} A correction demotes immediately.`;
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
 * Ceiling on promotions per run. Measured 2026-08-09 on this project's own store (697 active
 * items), the gate below selects 85 on its first pass over an unpromoted corpus; applying all
 * of them at one session start is the corpus-wide standing change that `drift-auto.ts`
 * deliberately refused to make. Ten a run drains a backlog over a week of sessions and keeps
 * any single run's blast radius reviewable.
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
 * call an agent has to choose to make, and it is called at a rate that cannot clear its own
 * threshold. Measured 2026-08-09 on this project's own store: 31 feedback events in total
 * against 4,432 retrievals, 6 of them in the nine days since the standing feature shipped on
 * 2026-07-31, spread across six different items. VERIFY_THRESHOLD is 2, and exactly one item
 * in the corpus has ever accumulated two confirmations against a single standing — that one
 * on 2026-07-30, before this code existed. 697 active items, all `asserted`, and not one
 * `Promote to verified` commit in 788.
 *
 * So the mechanism is not broken and the ladder is not too steep: at roughly one confirmation
 * per 143 retrievals, scattered one-per-item, a two-event threshold is essentially never met.
 * Standing has to be derived from what the store observes, not from what a caller volunteers.
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
 * `last_drift_at` closes the hole stored freshness leaves, and it has to be a stored column
 * rather than the live candidate list. Since 2026-08-13 the session-start check does flip
 * survivors to `needs_review`, which the `freshness = 'fresh'` clause above already excludes;
 * the stamp is not redundant with it, because `updateKnowledgeItem` clears the two on
 * different conditions. But the live list only
 * covers the one session that happened to straddle the commit: the watermark then advances,
 * the next session computes no candidates at all, and an item refused an hour ago sails
 * through unchanged. Measured on this store, 12 of the 85 items the recurrence gate selects
 * cite `package.json`, `CHANGELOG.md` or `.github/workflows/cd.yml`, all reading `fresh`
 * immediately after a release commit touched exactly those files. So the observation is
 * persisted when it is made and cleared when somebody revisits the item (see
 * `updateKnowledgeItem`), and a stamped item is refused for as long as it stays unexamined.
 *
 * Demotion is untouched and stays immediate, unconditional and uncapped. This path only
 * ever moves items up, and only ever by one step.
 */
export async function promoteByObservedUse(projectId: string): Promise<ObservedUseResult> {
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
            AND ki.last_drift_at IS NULL
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
  const ranked = rows
    .map(row => ({ id: String(row.id), days: Number(row.days) }))
    .sort((a, b) => b.days - a.days || a.id.localeCompare(b.id));
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

  // Against `selected`, not `promoted`. An item the re-read disqualified was retired or
  // edited under us -- it is not eligible and no later run will take it, so counting it here
  // would have the session line promise a backlog that does not exist.
  return { promoted, deferred: ranked.length - selected.length };
}

/** Hooks must never fail the host: a failed promotion pass reads as "nothing promoted". */
export async function promoteByObservedUseBestEffort(projectId: string): Promise<ObservedUseResult | null> {
  try {
    return await promoteByObservedUse(projectId);
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
