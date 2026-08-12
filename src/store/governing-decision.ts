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
 * WHY NEITHER A COSINE NOR A CONSTANT. The first version compared a raw cosine to a constant
 * fitted per embedding profile. On a labelled set whose negatives were drawn UNIFORMLY from the
 * real write population that was the WEAKEST option measured -- AUC 0.836, and 0% recall at the
 * fire rate it shipped at. An earlier evaluation scored it 0.972, but that set was stratified
 * across score bands, which over-selects exactly the pairs an absolute threshold handles well.
 * The scoring and the gate both changed as a result, and the reasoning lives in `guard-stats.ts`:
 * CSLS to stop broad "hub" decisions winning every write, and a percentile of this store's own
 * distribution so no constant is fitted to any particular corpus.
 */

import { KnowledgeItem } from '../core/types.js';
import { getConfigRoot } from './database.js';
import { buildKnowledgeEmbeddingText } from './vector-index.js';
import { searchKnowledgeEmbeddings } from './vector.js';
import { resolveWriteEmbedder } from './write-embedding.js';
import { CSLS_K, MIN_POOL_FOR_Z, guardStats } from './guard-stats.js';

export type GoverningDecision = {
  id: string;
  title: string;
  /** The CSLS score that cleared the gate, for the caller's own reporting. */
  score: number;
  /** Which rule admitted it, so a surprising notice can be explained without re-running it. */
  via: 'csls-percentile';
};

/**
 * The pool is capped rather than unbounded. A store with thousands of decisions would otherwise
 * make every write pay for scoring all of them, and the guard only ever reports the top one.
 */
const POOL_LIMIT = 200;

/**
 * Mean of the k highest values. Exported for its own test because it is the CSLS scaling term,
 * and a wrong k or a wrong mean silently changes which decision wins without failing anything.
 */
export function meanTopK(values: number[], k: number): number {
  const top = [...values].sort((a, b) => b - a).slice(0, k);
  return top.length ? top.reduce((sum, v) => sum + v, 0) / top.length : 0;
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

    const [{ loadConfig }, { fingerprintProfile, resolveVectorProfile }] =
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

    const fingerprint = fingerprintProfile(resolveVectorProfile(config));
    const hits = await searchKnowledgeEmbeddings(projectId, {
      vector: Array.from(vector),
      category: 'decision',
      status: 'active',
      profileFingerprint: fingerprint,
      limit: POOL_LIMIT,
    });

    const pool = hits.filter(hit => hit.item.id !== (self?.id ?? item.id));
    if (pool.length < MIN_POOL_FOR_Z) return undefined;

    // No statistics, no opinion. A corpus too small or too fresh to have a score distribution
    // cannot say whether this match is unusual, and guessing would fire on noise.
    const stats = await guardStats(fingerprint);
    if (!stats) return undefined;

    // CSLS re-ranks the raw-cosine shortlist rather than the whole store: the scaling can only
    // demote, and a decision outside the top of the cosine ranking cannot be promoted past one
    // inside it by a bounded correction. rWrite comes from this write's own neighbourhood.
    const rWrite = meanTopK(pool.map(hit => hit.score), CSLS_K);
    let best: { hit: (typeof pool)[number]; score: number } | null = null;
    for (const hit of pool) {
      const hub = stats.hub.get(hit.item.id);
      if (hub === undefined) continue;         // indexed under another profile; not comparable
      const scaled = 2 * hit.score - rWrite - hub;
      if (!best || scaled > best.score) best = { hit, score: scaled };
    }

    if (!best || best.score < stats.threshold) return undefined;
    return { id: best.hit.item.id, title: best.hit.item.title, score: best.score, via: 'csls-percentile' };
  } catch {
    return undefined;
  }
}
