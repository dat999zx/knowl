import { describe, expect, it } from 'vitest';
import { calibrate, chooseThreshold } from '../src/calibrate.js';

describe('chooseThreshold', () => {
  it('separates cleanly split pairs and reports perfect agreement', () => {
    const scored = [
      { similarity: 0.9, same: true },
      { similarity: 0.85, same: true },
      { similarity: 0.3, same: false },
      { similarity: 0.2, same: false },
    ];

    const { threshold, agreement } = chooseThreshold(scored);

    expect(agreement).toBe(1);
    expect(threshold).toBeGreaterThan(0.3);
    expect(threshold).toBeLessThan(0.85);
  });

  it('maximizes agreement when an outlier prevents perfection', () => {
    // Two true pairs, two false pairs, and one false outlier with high similarity.
    // Best threshold is 0.575 (midpoint between 0.3 and 0.85), correctly classifying
    // all pairs except the 0.95 outlier, yielding 4/5 = 0.8 agreement.
    const scored = [
      { similarity: 0.9, same: true },
      { similarity: 0.85, same: true },
      { similarity: 0.3, same: false },
      { similarity: 0.2, same: false },
      { similarity: 0.95, same: false }, // outlier: false but scored very high
    ];

    const { threshold, agreement } = chooseThreshold(scored);

    expect(agreement).toBeCloseTo(0.8, 10);
  });

  it('throws on an empty set rather than inventing a threshold', () => {
    expect(() => chooseThreshold([])).toThrow(/calibration/i);
  });

  it('does not return a threshold equal to an observed similarity even with duplicates', () => {
    // Forward-looking test: guards the invariant stated in the module doc comment.
    // Currently passes both with and without the duplicate guard (due to strict > tie-break),
    // but catches any future change from > to >= in the selection rule (line 43).
    const scored = [
      { similarity: 1.0, same: true },
      { similarity: 1.0, same: true },
      { similarity: 0.2, same: false },
    ];

    const { threshold } = chooseThreshold(scored);

    const observedSimilarities = scored.map((s) => s.similarity);
    expect(observedSimilarities).not.toContain(threshold);
  });
});

describe('calibrate', () => {
  it('embeds each side of a pair and scores it', async () => {
    const vectors: Record<string, number[]> = {
      'a same': [1, 0],
      'b same': [1, 0],
      'a diff': [1, 0],
      'b diff': [0, 1],
    };
    const embed = async (texts: string[]) => texts.map((text) => vectors[text]);

    const result = await calibrate(
      [
        { a: 'a same', b: 'b same', same: true },
        { a: 'a diff', b: 'b diff', same: false },
      ],
      embed,
    );

    expect(result.scored.map((s) => s.same)).toEqual([true, false]);
    expect(result.scored[0].similarity).toBeCloseTo(1, 10);
    expect(result.scored[1].similarity).toBeCloseTo(0, 10);
    expect(result.agreement).toBe(1);
  });
});
