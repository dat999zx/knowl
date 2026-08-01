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
  it('drops vector-backed results that fall below the floor', () => {
    const scored = scoreCandidates(
      [
        { item: item('keep'), embedded: true, vectorRank: 1, vectorScore: 0.9 },
        { item: item('drop'), embedded: true, vectorRank: 2, vectorScore: 0.05 },
      ],
      { limit: 10, usingVector: true },
    );

    expect(scored.map((row) => row.item.id)).toEqual(['keep']);
  });

  it('returns nothing when every candidate is below the floor', () => {
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

  it('drops an embedded candidate that vector ranked outside its top N', () => {
    // The junk case that motivates the whole feature, and the one that separates this design
    // from flooring only candidates that carry a vectorScore. `a` is embedded, so vector had
    // every chance to rank it and did not -- it is semantically distant, and its BM25 rank
    // says nothing about absolute relevance. Measured against the live store, off-topic
    // lexical hits like this score 0.034-0.035 and match on stopwords alone.
    const scored = scoreCandidates(
      [
        { item: item('real'), embedded: true, vectorRank: 1, vectorScore: 0.62 },
        { item: item('a'), embedded: true, bm25Rank: 1 },
      ],
      { limit: 10, usingVector: true },
    );

    expect(scored.map((row) => row.item.id)).toEqual(['real']);
  });

  it('keeps an unembedded candidate even when vector contributed', () => {
    // Written since the last successful index, or written while the embedding model was not
    // cached. Vector never had a chance to rank it, so a low fused score means "invisible to
    // vector", not "semantically distant" -- the exact opposite conclusion from the case above.
    const scored = scoreCandidates(
      [
        { item: item('real'), embedded: true, vectorRank: 1, vectorScore: 0.62 },
        { item: item('unindexed'), embedded: false, bm25Rank: 1 },
      ],
      { limit: 10, usingVector: true },
    );

    expect(scored.map((row) => row.item.id)).toEqual(['real', 'unindexed']);
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
    const scored = scoreCandidates(
      [{ item: item('a'), embedded: true, bm25Rank: 1 }, { item: item('b'), embedded: true, bm25Rank: 2 }],
      { limit: 10, usingVector: false },
    );

    expect(scored).toHaveLength(2);
  });

  it('filters before the limit, so a capped query is not short-changed', () => {
    // Three clear the floor and one does not; with limit 3 the caller must still get 3.
    const scored = scoreCandidates(
      [
        { item: item('a'), embedded: true, vectorRank: 1, vectorScore: 0.90 },
        { item: item('b'), embedded: true, vectorRank: 2, vectorScore: 0.80 },
        { item: item('junk'), embedded: true, vectorRank: 3, vectorScore: 0.02 },
        { item: item('c'), embedded: true, vectorRank: 4, vectorScore: 0.70 },
      ],
      { limit: 3, usingVector: true },
    );

    expect(scored.map((row) => row.item.id)).toEqual(['a', 'b', 'c']);
  });
});
