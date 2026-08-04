import { describe, expect, it } from 'vitest';
import { MIN_VECTOR_RELEVANCE, scoreCandidates } from '../../src/store/agent-query.js';
import type { KnowledgeItem } from '../../src/core/types.js';

describe('MIN_VECTOR_RELEVANCE', () => {
  it('sits inside the gap re-measured on the same store, which is narrower than recorded', () => {
    // Re-measured 2026-08-04 on a copy of the same real store (483 items, 481 embedded),
    // 10 off-topic and 12 on-topic queries rather than the original 20: off-topic tops out at
    // 0.2678 and legitimate bottoms out at 0.3137. The bound was 0.223/0.401 from the smaller
    // set; the gap is real but a third as wide as it was believed to be, and 0.30 sits 0.014
    // below the weakest real answer rather than 0.10. Tightened here so the next query that
    // closes it fails this test instead of silently silencing an answer.
    expect(MIN_VECTOR_RELEVANCE).toBeGreaterThan(0.2678);
    expect(MIN_VECTOR_RELEVANCE).toBeLessThan(0.3137);
  });
});

const item = (id: string): KnowledgeItem => ({
  id, category: 'fact', status: 'active', title: `item ${id}`, content: 'content',
  confidence: 1, freshness: 'fresh', version: 1,
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
} as KnowledgeItem);

describe('scoreCandidates with the relevance floor', () => {
  // REPLACED, deliberately. This asserted `scored` was `[]` below the floor -- deletion as the
  // feature. The sweep in docs/evals/floor-sweep.md shows deletion was wrong: a fixed absolute
  // cosine does not transfer between corpora, and at 0.30 the floor blanked 23 of 110
  // answerable queries on semantic-suite.json (Recall@10 0.9818 -> 0.7909) while sitting only
  // 0.014 below the weakest real answer on the store it was tuned on. The verdict is kept; the
  // deletion is not. Behaviour now lives in tests/store/floor-non-destructive.test.ts.
  it('reports the verdict instead of deleting the ranking', () => {
    const scored = scoreCandidates(
      [
        { item: item('a'), embedded: true, vectorRank: 1, vectorScore: 0.06 },
        { item: item('b'), embedded: true, vectorRank: 2, vectorScore: 0.04 },
      ],
      { limit: 10, usingVector: true },
    );

    expect(scored.map((row) => row.item.id)).toEqual(['a', 'b']);
    expect(scored.every((row) => row.explanation.abstained === true)).toBe(true);
  });

  it('keeps the whole ranking once the best candidate clears the floor', () => {
    // The floor judges the query, not each result. A weak 3rd or 5th hit under an answer that
    // clearly cleared is the tail of a real answer, not junk -- measured against the 500-case
    // suite, filtering per candidate dropped `span export backend` -> obs-otel at 0.269 on a
    // query whose top result scored 0.389, and cost Recall@10 0.994 -> 0.987.
    const scored = scoreCandidates(
      [
        { item: item('top'), embedded: true, vectorRank: 1, vectorScore: 0.62 },
        { item: item('tail'), embedded: true, vectorRank: 2, vectorScore: 0.05 },
      ],
      { limit: 10, usingVector: true },
    );

    expect(scored.map((row) => row.item.id)).toEqual(['top', 'tail']);
  });

  // AMENDED, deliberately. The old assertion was `['unindexed']` -- the embedded-but-distant
  // row was deleted and only the unjudged one survived. Both now stand; what the exemption
  // still buys is that the unjudged row is not LABELLED by a verdict reached without it.
  it('does not label a candidate the floor never judged', () => {
    // Written since the last successful index, or written while the embedding model was not
    // cached. A verdict reached without ever looking at it must not describe it.
    //
    // The verdict itself reads only embedded candidates. That guard is defensive rather than
    // observable: an unembedded candidate scores on the BM25 fallback and tops out near 0.086,
    // so it can never be what lifts a query over 0.30, and judging on the best candidate
    // overall would reach the same answer for any score either could actually hold.
    const scored = scoreCandidates(
      [
        { item: item('distant'), embedded: true, vectorRank: 1, vectorScore: 0.06 },
        { item: item('unindexed'), embedded: false, bm25Rank: 1 },
      ],
      { limit: 10, usingVector: true },
    );

    const byId = new Map(scored.map((row) => [row.item.id, row]));
    expect([...byId.keys()].sort()).toEqual(['distant', 'unindexed']);
    expect(byId.get('distant')!.explanation.abstained).toBe(true);
    expect(byId.get('unindexed')!.explanation.abstained).toBeUndefined();
  });

  it('does NOT apply the floor when vector was requested but nothing is embedded', () => {
    // The outage case: vector enabled on a store with no embeddings at all. usingVector is
    // true, but every candidate is unembedded and scores on the lexical scale (~0.036 here),
    // where a 0.30 floor would drop every result for every query.
    const scored = scoreCandidates(
      [
        { item: item('a'), embedded: false, bm25Rank: 1 },
        { item: item('b'), embedded: false, bm25Rank: 2 },
      ],
      { limit: 10, usingVector: true },
    );

    expect(scored.map((row) => row.item.id)).toEqual(['a', 'b']);
  });

  it('leaves a candidate alone when eligibility is unknown', () => {
    // A caller that assembles candidates itself and never sets `embedded` must not have its
    // results silently deleted. Absent evidence, the floor does not apply.
    const scored = scoreCandidates(
      [{ item: item('a'), bm25Rank: 1 }, { item: item('b'), bm25Rank: 2 }],
      { limit: 10, usingVector: true },
    );

    expect(scored).toHaveLength(2);
  });

  it('leaves the lexical path untouched', () => {
    // Off-topic and legitimate queries overlap completely without vector, so a floor there
    // would be arbitrary -- these scores sit around 0.036 and would all be cut.
    const scored = scoreCandidates(
      [{ item: item('a'), embedded: true, bm25Rank: 1 }, { item: item('b'), embedded: true, bm25Rank: 2 }],
      { limit: 10, usingVector: false },
    );

    expect(scored).toHaveLength(2);
  });

  it('still honours the limit on an answerable query', () => {
    const scored = scoreCandidates(
      [
        { item: item('a'), embedded: true, vectorRank: 1, vectorScore: 0.90 },
        { item: item('b'), embedded: true, vectorRank: 2, vectorScore: 0.80 },
        { item: item('c'), embedded: true, vectorRank: 3, vectorScore: 0.70 },
        { item: item('d'), embedded: true, vectorRank: 4, vectorScore: 0.60 },
      ],
      { limit: 3, usingVector: true },
    );

    expect(scored.map((row) => row.item.id)).toEqual(['a', 'b', 'c']);
  });
});
