import { describe, expect, it } from 'vitest';
import { MIN_VECTOR_RELEVANCE, vectorContributed } from '../../src/store/agent-query.js';

describe('MIN_VECTOR_RELEVANCE', () => {
  it('sits inside the measured gap between off-topic and legitimate queries', () => {
    // Measured 2026-08-01: off-topic tops out at 0.223, legitimate bottoms out at 0.401.
    expect(MIN_VECTOR_RELEVANCE).toBeGreaterThan(0.223);
    expect(MIN_VECTOR_RELEVANCE).toBeLessThan(0.401);
  });
});

describe('vectorContributed', () => {
  it('is true when at least one candidate carries a vector score', () => {
    expect(vectorContributed([{ vectorScore: undefined }, { vectorScore: 0.42 }])).toBe(true);
  });

  it('is false when no candidate carries one, even though vector may have been requested', () => {
    // The outage case: vector enabled on a store with no embeddings. Every candidate is
    // BM25-only and scores on the lexical scale, where a 0.30 floor would drop everything.
    expect(vectorContributed([{ vectorScore: undefined }, { vectorScore: undefined }])).toBe(false);
  });

  it('is false for no candidates at all', () => {
    expect(vectorContributed([])).toBe(false);
  });

  it('counts a zero vector score as a contribution', () => {
    // 0 is a real cosine result, not an absence. Treating it as absent would disable the
    // floor for exactly the most distant match.
    expect(vectorContributed([{ vectorScore: 0 }])).toBe(true);
  });
});
