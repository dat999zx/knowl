/**
 * Write-side guard: does an active decision already govern what is being written?
 *
 * THE FAILURE THIS EXISTS FOR. On 2026-08-11 an agent recommended stripping MCP tool-argument
 * descriptions and stored an atom saying so, while an active decision in the same workspace had
 * already rejected exactly that, with a stated bar for re-opening it. The write landed silently.
 *
 * RETRIEVAL WAS NOT AT FAULT, and that is why this is a write-side guard rather than a ranking
 * change. Measured afterwards: on the question "should we trim MCP tool descriptions to save
 * tokens" the decision returns rank 1, cross-repo, with no filter. It simply was never asked --
 * the agent had queried about startup performance, a different subject, and carried those results
 * across. No ranking improvement reaches a query nobody runs. The one moment the system holds both
 * the proposal and the decision at once is the write, so the check belongs here.
 *
 * WHY IT ONLY WARNS. Across three embedding models the separation between a real governing match
 * and the best false one is about one standard deviation. That is enough to raise a question and
 * nowhere near enough to refuse a write, and a heuristic gate that blocks is a gate people turn
 * off -- the same lesson as the secret validator's false positive. `knowl_store` never fails
 * because of this module.
 *
 * WHY THE THRESHOLD IS PER PROFILE. A cosine means different things in different embedding
 * spaces: median similarity between UNRELATED items measured 0.838 under granite, 0.735 under bge
 * and 0.510 under arctic. One shared constant would fire on nearly everything under granite. A
 * scale-free z-score does transfer, but it discriminates worse in every model (AUC 0.960-0.977
 * against 0.982-0.992), because normalising against the pool's own spread discards the absolute
 * signal -- a write in a dense topic region gets its z deflated even when the match is strong. So
 * the calibrated constant is primary and the z-score is the fallback for uncalibrated profiles.
 */

import { KnowledgeItem } from '../core/types.js';
import { getConfigRoot } from './database.js';
import { buildKnowledgeEmbeddingText } from './vector-index.js';
import { searchKnowledgeEmbeddings } from './vector.js';
import { resolveWriteEmbedder } from './write-embedding.js';

export type GoverningDecision = {
  id: string;
  title: string;
  /** Cosine between the write and the decision, for the caller's own reporting. */
  score: number;
  /** Which rule admitted it, so a surprising notice can be explained without re-running it. */
  via: 'calibrated' | 'z-score';
};

/**
 * How many standard deviations above the pool's own mean a top match must sit when the profile
 * has no calibrated constant.
 *
 * 3.32 is where a single threshold across granite, bge and arctic pooled maximised accuracy
 * (90.7%, TPR 90.6%, FPR 9.2%). It is deliberately the weaker path: on any profile that has a
 * constant, that constant is 5-6 accuracy points better.
 */
const FALLBACK_Z = 3.32;

/**
 * Below this many decisions the fallback abstains outright, because the threshold above is not
 * reachable in a small pool and would otherwise be a silent no-op that LOOKS like a working gate.
 *
 * A z-score has a hard ceiling set by the sample size: one value above n-1 identical others
 * scores at most sqrt(n-1). That is exactly 3.0 at n=10, so on a store with ten decisions
 * NOTHING can ever clear 3.32 — not even a perfect match against a pool of complete strangers.
 * Solving sqrt(n-1) >= 3.32 puts the arithmetic floor at n = 13, and sitting on the floor would
 * mean only a flawless outlier ever fires. 25 gives a ceiling of sqrt(24) = 4.90, enough headroom
 * for a realistic match, and is still far below the pools of 82 the threshold was calibrated on.
 *
 * Found by a test asserting that a clear outlier clears the bar: it did not, at z = 2.99. The
 * failure was arithmetic rather than a bad fixture, and without the explicit floor the guard
 * would have shipped looking correct while being inert on every young repository.
 */
const MIN_POOL_FOR_Z = 25;

/**
 * The pool is capped rather than unbounded. A store with thousands of decisions would otherwise
 * make every write pay for scoring all of them, and the guard only ever reports the top one --
 * beyond the first page the extra rows change nothing but the mean used by the fallback.
 */
const POOL_LIMIT = 200;

/**
 * Exported for its own test. The fallback is the path an UNCALIBRATED profile takes, so it is
 * the one nobody exercises by hand and the one that must not quietly fire on everything: it is
 * reached exactly when there is no measured constant to check it against.
 */
export function zScore(scores: number[], top: number): number {
  if (scores.length < 2) return 0;
  const mean = scores.reduce((sum, s) => sum + s, 0) / scores.length;
  const variance = scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length;
  const sd = Math.sqrt(variance);
  // A pool with no spread cannot say anything about how unusual its top hit is. Returning 0
  // abstains rather than dividing by an epsilon and manufacturing a huge z from rounding.
  if (sd < 1e-9) return 0;
  return (top - mean) / sd;
}

/**
 * The active decision that governs this write, or `undefined`.
 *
 * Never throws and never blocks: every failure path -- no project, no embedder, model absent,
 * vector search unavailable -- returns `undefined`, exactly like the cross-repo advisory it sits
 * beside. A write must not fail because an advisory could not be computed.
 *
 * `self` excludes the item being written from its own pool, which matters when the write IS a
 * decision: a decision is otherwise its own best match at cosine 1.0.
 */
export async function governingDecisionForWrite(
  projectId: string,
  item: KnowledgeItem,
  self?: { id?: string },
): Promise<GoverningDecision | undefined> {
  try {
    const embedder = await resolveWriteEmbedder();
    if (!embedder) return undefined;

    const [{ loadConfig }, { fingerprintProfile, resolveVectorProfile, governingDecisionThresholdFor }] =
      await Promise.all([
        import('../core/config.js'),
        import('../core/vector-profile.js'),
      ]);
    const config = await loadConfig(getConfigRoot());

    // One text per forward pass, matching how the item's own stored vector is produced. A
    // different batching here would score the write against the corpus with a vector that
    // disagrees with the one the corpus holds for it.
    const [vector] = await embedder.embed([buildKnowledgeEmbeddingText(item)], { maxBatch: 1 });
    if (!vector || vector.length === 0) return undefined;

    const hits = await searchKnowledgeEmbeddings(projectId, {
      vector: Array.from(vector),
      category: 'decision',
      status: 'active',
      profileFingerprint: fingerprintProfile(resolveVectorProfile(config)),
      limit: POOL_LIMIT,
    });

    const pool = hits.filter(hit => hit.item.id !== (self?.id ?? item.id));
    if (pool.length === 0) return undefined;

    const top = pool[0];
    const threshold = governingDecisionThresholdFor(config);

    if (threshold !== null) {
      if (top.score < threshold) return undefined;
      return { id: top.item.id, title: top.item.title, score: top.score, via: 'calibrated' };
    }

    // Uncalibrated profile. Ask the scale-free question instead of guessing a constant, because
    // a cosine that means "unrelated" in one space means "same subject" in another.
    if (pool.length < MIN_POOL_FOR_Z) return undefined;
    if (zScore(pool.map(hit => hit.score), top.score) < FALLBACK_Z) return undefined;
    return { id: top.item.id, title: top.item.title, score: top.score, via: 'z-score' };
  } catch {
    return undefined;
  }
}
