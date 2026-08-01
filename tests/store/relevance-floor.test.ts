import { describe, expect, it } from 'vitest';
import { MIN_VECTOR_RELEVANCE, scoreCandidates } from '../../src/store/agent-query.js';
import type { KnowledgeItem } from '../../src/core/types.js';

describe('MIN_VECTOR_RELEVANCE', () => {
  it('sits inside the measured gap between off-topic and legitimate queries', () => {
    // Measured 2026-08-01: off-topic tops out at 0.223, legitimate bottoms out at 0.401.
    expect(MIN_VECTOR_RELEVANCE).toBeGreaterThan(0.223);
    expect(MIN_VECTOR_RELEVANCE).toBeLessThan(0.401);
  });
});

const item = (id: string): KnowledgeItem => ({
  id, category: 'fact', status: 'active', title: `item ${id}`, content: 'content',
  confidence: 1, freshness: 'fresh', version: 1,
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
} as KnowledgeItem);

describe('scoreCandidates with the relevance floor', () => {
  it('returns nothing when the best candidate is below the floor', () => {
    // The point of the feature: a question the store knows nothing about gets no answer.
    const scored = scoreCandidates(
      [
        { item: item('a'), embedded: true, vectorRank: 1, vectorScore: 0.06 },
        { item: item('b'), embedded: true, vectorRank: 2, vectorScore: 0.04 },
      ],
      { limit: 10, usingVector: true },
    );

    expect(scored).toEqual([]);
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

  it('keeps an unembedded candidate even when the query is judged unanswerable', () => {
    // Written since the last successful index, or written while the embedding model was not
    // cached. A verdict reached without ever looking at it must not suppress it.
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

    expect(scored.map((row) => row.item.id)).toEqual(['unindexed']);
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
