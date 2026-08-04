import { describe, expect, it } from 'vitest';
import { scoreCandidates } from '../../src/store/agent-query.js';
import type { KnowledgeItem } from '../../src/core/types.js';

const item = (id: string): KnowledgeItem => ({
  id, category: 'fact', status: 'active', title: `item ${id}`, content: 'content',
  confidence: 1, freshness: 'fresh', version: 1,
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
} as KnowledgeItem);

/** Two candidates far below any plausible floor. */
const weak = [
  { item: item('a'), embedded: true, vectorRank: 1, vectorScore: 0.06 },
  { item: item('b'), embedded: true, vectorRank: 2, vectorScore: 0.04 },
];

describe('abstention requires a calibrated floor', () => {
  it('never abstains when no floor is supplied', () => {
    // There is no default any more, deliberately. A default is a number measured on one model
    // applied to another, which is the defect this replaces -- at 0.30 it mislabelled 24 of
    // 110 real answers on arctic and fired not once on granite. An uncalibrated model gets a
    // withheld claim rather than a borrowed one.
    const scored = scoreCandidates(weak, { limit: 10, usingVector: true });

    expect(scored.map(row => row.item.id)).toEqual(['a', 'b']);
    expect(scored.every(row => row.explanation.abstained === undefined)).toBe(true);
  });

  it('never abstains when the floor is explicitly null', () => {
    // What `relevanceFloorFor` returns for an unmeasured model, threaded through unchanged.
    const scored = scoreCandidates(weak, { limit: 10, usingVector: true, minRelevance: null });

    expect(scored.every(row => row.explanation.abstained === undefined)).toBe(true);
  });

  it('abstains once a floor is supplied and the best cosine is under it', () => {
    const scored = scoreCandidates(weak, { limit: 10, usingVector: true, minRelevance: 0.30 });

    expect(scored.map(row => row.item.id)).toEqual(['a', 'b']);
    expect(scored.every(row => row.explanation.abstained === true)).toBe(true);
  });

  it('judges against the floor it is given, not a shared one', () => {
    // The same candidate set, answerable on arctic's scale and not on granite's. One constant
    // could not express both; this is the property that fixes it.
    const granitish = [
      { item: item('a'), embedded: true, vectorRank: 1, vectorScore: 0.50 },
      { item: item('b'), embedded: true, vectorRank: 2, vectorScore: 0.48 },
    ];

    const onArctic = scoreCandidates(granitish, { limit: 10, usingVector: true, minRelevance: 0.16 });
    const onGranite = scoreCandidates(granitish, { limit: 10, usingVector: true, minRelevance: 0.76 });

    expect(onArctic.every(row => row.explanation.abstained === undefined)).toBe(true);
    expect(onGranite.every(row => row.explanation.abstained === true)).toBe(true);
  });

  it('does not let a floor change the ranking, whatever it is', () => {
    // The non-destructive guarantee, restated per-floor: recall and order must be identical at
    // every value, or the constant becomes load-bearing again.
    const ids = (floor: number | null) => scoreCandidates(
      [
        { item: item('top'), embedded: true, vectorRank: 1, vectorScore: 0.62 },
        { item: item('mid'), embedded: true, vectorRank: 2, vectorScore: 0.30 },
        { item: item('low'), embedded: true, vectorRank: 3, vectorScore: 0.05 },
      ],
      { limit: 10, usingVector: true, minRelevance: floor },
    ).map(row => row.item.id);

    expect(ids(null)).toEqual(['top', 'mid', 'low']);
    expect(ids(0.16)).toEqual(['top', 'mid', 'low']);
    expect(ids(0.76)).toEqual(['top', 'mid', 'low']);
    expect(ids(0.99)).toEqual(['top', 'mid', 'low']);
  });
});
