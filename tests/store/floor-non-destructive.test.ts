import { describe, expect, it } from 'vitest';
import { scoreCandidates } from '../../src/store/agent-query.js';

// Arctic's floor, named here so the assertions say which model's scale they are on. The floor
// is per-model now (see tests/core/model-relevance-floor.test.ts); this file is about the
// non-destructive guarantee, which holds at every value.
const FLOOR = 0.16;
import type { KnowledgeItem } from '../../src/core/types.js';

/**
 * The relevance floor reports its verdict instead of acting on it alone.
 *
 * It used to delete: below the bar, `scoreCandidates` returned an empty list and the caller
 * could not tell "the store does not know this" from "the store is empty" from "the index is
 * missing". That is a destructive answer to a question the number could only answer
 * approximately, and it was measured deleting real answers.
 *
 * **What was measured** (docs/evals/floor-sweep.md). A fixed absolute cosine does not transfer
 * between corpora, so no constant is right for all of them:
 *
 * - The real 483-item store it was tuned on: off-topic queries top out at 0.2678 and legitimate
 *   ones bottom out at 0.3137, so 0.30 sits in the gap -- but only 0.014 below the weakest real
 *   answer, not the 0.10 the old comment claimed from a smaller query set.
 * - `docs/evals/semantic-suite.json`: the two distributions do not merely narrow, they OVERLAP.
 *   Gold answers for blanked cases score 0.087-0.277 -- inside and below the real store's junk
 *   band -- and at 0.30 the floor blanked **23 of 110 answerable queries**, taking Recall@10
 *   from 0.9818 to 0.7909. The blanked cases are the moderate and extreme tiers: the
 *   half-remembered phrasings vector search exists to serve.
 * - Not the embeddings. Re-embedding each blanked gold item alone (K-71's batch perturbation,
 *   worth up to 5.4e-2 cosine) moved them by at most 0.034 and lifted **0 of 13** over the bar.
 *
 * The file's own principle already said which way to err -- "silencing one is worse than
 * admitting a weak one" -- and the destructive floor was breaking it. Every result now carries a
 * calibrated `score`, so a weak answer arrives visibly weak; the verdict rides along as
 * `explanation.abstained` and `knowl_query` states it in words. Silence carried less
 * information than a low number does, not more.
 */
const item = (id: string): KnowledgeItem => ({
  id, category: 'fact', status: 'active', title: `item ${id}`, content: 'content',
  confidence: 1, freshness: 'fresh', version: 1,
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
} as KnowledgeItem);

describe('the floor reports rather than deletes', () => {
  it('returns the ranking, marked abstained, when nothing clears the bar', () => {
    const scored = scoreCandidates(
      [
        { item: item('a'), embedded: true, vectorRank: 1, vectorScore: 0.06 },
        { item: item('b'), embedded: true, vectorRank: 2, vectorScore: 0.04 },
      ],
      { limit: 10, usingVector: true, minRelevance: FLOOR },
    );

    // Nothing is deleted...
    expect(scored.map(row => row.item.id)).toEqual(['a', 'b']);
    // ...and every result says the store has no confident match for this query.
    expect(scored.every(row => row.explanation.abstained === true)).toBe(true);
    // The score is the evidence behind the verdict: low, and comparable across queries.
    expect(scored[0].score).toBeLessThan(FLOOR);
  });

  it('says nothing about abstention when the query is answered', () => {
    const scored = scoreCandidates(
      [
        { item: item('top'), embedded: true, vectorRank: 1, vectorScore: 0.62 },
        { item: item('tail'), embedded: true, vectorRank: 2, vectorScore: 0.05 },
      ],
      { limit: 10, usingVector: true, minRelevance: FLOOR },
    );

    expect(scored.map(row => row.item.id)).toEqual(['top', 'tail']);
    // Absent rather than false, so an answered query costs no bytes in the response.
    expect(scored.every(row => row.explanation.abstained === undefined)).toBe(true);
  });

  it('keeps honouring the limit while abstaining', () => {
    const scored = scoreCandidates(
      [
        { item: item('a'), embedded: true, vectorRank: 1, vectorScore: 0.10 },
        { item: item('b'), embedded: true, vectorRank: 2, vectorScore: 0.09 },
        { item: item('c'), embedded: true, vectorRank: 3, vectorScore: 0.08 },
      ],
      { limit: 2, usingVector: true, minRelevance: FLOOR },
    );

    expect(scored.map(row => row.item.id)).toEqual(['a', 'b']);
    expect(scored.every(row => row.explanation.abstained === true)).toBe(true);
  });

  it('does not abstain on the lexical path, which has no absolute scale', () => {
    const scored = scoreCandidates(
      [{ item: item('a'), embedded: true, bm25Rank: 1 }, { item: item('b'), embedded: true, bm25Rank: 2 }],
      { limit: 10, usingVector: false },
    );

    expect(scored).toHaveLength(2);
    expect(scored.every(row => row.explanation.abstained === undefined)).toBe(true);
  });

  it('does not abstain when nothing was embedded, so the floor judged nothing', () => {
    // The outage case: vector enabled on a store with no embeddings. A verdict reached without
    // looking at anything is not a verdict.
    const scored = scoreCandidates(
      [{ item: item('a'), embedded: false, bm25Rank: 1 }, { item: item('b'), embedded: false, bm25Rank: 2 }],
      { limit: 10, usingVector: true, minRelevance: FLOOR },
    );

    expect(scored.map(row => row.item.id)).toEqual(['a', 'b']);
    expect(scored.every(row => row.explanation.abstained === undefined)).toBe(true);
  });

  // The exemption reads the way the destructive floor read it, which is the opposite of the
  // obvious guess. The set the old code KEPT is the set left unlabelled, and the peer whose
  // store judged nothing is not in it -- it was the row the old code deleted (K-36), and
  // exempting it would leave it as the only unlabelled row on an abstained page, which is the
  // whole hazard lane 3 reported.
  it('exempts a row its own store could not judge, and labels one from a store that judged nothing', () => {
    const scored = scoreCandidates(
      [
        { item: item('judged'), repo: 'indexed', embedded: true, vectorRank: 1, vectorScore: 0.06 },
        // Same store, written since the last index: the verdict was reached without seeing it.
        { item: item('just-written'), repo: 'indexed', embedded: false, bm25Rank: 1 },
        // A peer with no embeddings at all: it took part in nothing.
        { item: item('peer'), repo: 'unindexed', embedded: false, bm25Rank: 1 },
      ],
      { limit: 10, usingVector: true, minRelevance: FLOOR },
    );

    const byId = new Map(scored.map(row => [row.item.id, row]));
    expect(byId.get('judged')!.explanation.abstained).toBe(true);
    expect(byId.get('just-written')!.explanation.abstained).toBeUndefined();
    expect(byId.get('peer')!.explanation.abstained).toBe(true);
  });
});
