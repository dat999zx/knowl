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

  it('never abstains on a number that is not a threshold', () => {
    // `typeof x === 'number' && Number.isFinite(x)` -> `||` survived the whole suite, so the
    // `Number.isFinite` half was doing nothing any test could see. `NaN` is a number and
    // compares false against everything, so under the mutant `bestCosine >= floor` is false for
    // every query and the store abstains on all of them -- the loudest possible version of the
    // failure this file exists to prevent, reached by a threshold nobody ever set.
    for (const notAThreshold of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const scored = scoreCandidates(
        [{ item: item('a'), embedded: true, vectorRank: 1, vectorScore: 0.62 }],
        { limit: 10, usingVector: true, minRelevance: notAThreshold },
      );
      expect(scored.every(row => row.explanation.abstained === undefined)).toBe(true);
    }
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

  it('publishes the RAW cosine, not the rescaled one the ranking uses', () => {
    // The whole point of the field (#146). `rescaleSemantic` min-max scales the semantic half
    // across the page, so the top row's contribution is 1.0 whether its cosine was 0.93 or
    // 0.20 -- which is why the fused `score` could not separate an off-topic query from a
    // perfect match on a small store. `cosine` must survive that untouched.
    const scored = scoreCandidates(
      [
        { item: item('top'), embedded: true, vectorRank: 1, vectorScore: 0.62 },
        { item: item('mid'), embedded: true, vectorRank: 2, vectorScore: 0.30 },
        { item: item('low'), embedded: true, vectorRank: 3, vectorScore: 0.05 },
      ],
      { limit: 10, usingVector: true, minRelevance: 0.16 },
    );

    expect(scored.map(row => row.explanation.cosine)).toEqual([0.62, 0.30, 0.05]);
    // Min-max put the top row at 1.0 and the bottom at 0. If `cosine` were read off the
    // rescaled term instead, the first assertion would see 1 and the last 0.
    expect(scored[0].explanation.contributions.semantic).toBe(0.62);
  });

  it('publishes cosine on an abstained row, which is exactly when it is needed', () => {
    const scored = scoreCandidates(weak, { limit: 10, usingVector: true, minRelevance: 0.30 });

    expect(scored.every(row => row.explanation.abstained === true)).toBe(true);
    expect(scored.map(row => row.explanation.cosine)).toEqual([0.06, 0.04]);
  });

  it('withholds cosine where the row was never judged semantically', () => {
    // Same predicate `uncalibrated` fires on, and for the same reason: an unjudged row's
    // semantic half is 0 by ABSENCE, and publishing that 0 as a cosine would read as
    // "certainly irrelevant" where the truth is "vector never saw it".
    const lexicalOnly = scoreCandidates(
      [{ item: item('a'), bm25Rank: 1, lexicalScore: 2 }],
      { limit: 10, usingVector: false },
    );
    expect(lexicalOnly[0].explanation.uncalibrated).toBe('lexical-only');
    expect(lexicalOnly[0].explanation.cosine).toBeUndefined();

    const notEmbedded = scoreCandidates(
      [{ item: item('b'), embedded: false, bm25Rank: 1, lexicalScore: 2 }],
      { limit: 10, usingVector: true, minRelevance: 0.16 },
    );
    expect(notEmbedded[0].explanation.uncalibrated).toBe('not embedded');
    expect(notEmbedded[0].explanation.cosine).toBeUndefined();
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
