import { describe, expect, it } from 'vitest';
import { cosine, inBand, maxCardinalityMatch } from '../src/matcher.js';

describe('cosine', () => {
  it('scores identical vectors as 1', () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it('scores orthogonal vectors as 0', () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it('is scale invariant, so unnormalised vectors still compare correctly', () => {
    expect(cosine([1, 2], [10, 20])).toBeCloseTo(1, 10);
  });

  it('returns 0 for a zero vector rather than NaN', () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe('inBand', () => {
  it('flags a similarity within the default band of the threshold', () => {
    expect(inBand(0.72, 0.7)).toBe(true);
    expect(inBand(0.62, 0.7)).toBe(true);
  });

  it('does not flag a similarity clear of the band', () => {
    expect(inBand(0.95, 0.7)).toBe(false);
    expect(inBand(0.4, 0.7)).toBe(false);
  });
});

describe('maxCardinalityMatch', () => {
  it('pairs each left with a distinct right', () => {
    const edges = [
      [true, true],
      [true, false],
    ];

    const matched = maxCardinalityMatch(edges, 2, 2);

    expect(matched.filter((left) => left !== -1)).toHaveLength(2);
  });

  it('beats greedy: it does not strand a gold item whose only partner was taken', () => {
    // Left 0 can pair with either right; left 1 only with right 0. A greedy pass that gives
    // right 0 to left 0 strands left 1 and understates recall.
    const edges = [
      [true, true],
      [true, false],
    ];

    const matched = maxCardinalityMatch(edges, 2, 2);

    expect(new Set(matched.filter((left) => left !== -1)).size).toBe(2);
  });

  it('leaves unmatched rights as -1', () => {
    const matched = maxCardinalityMatch([[false, false]], 1, 2);

    expect(matched).toEqual([-1, -1]);
  });
});
