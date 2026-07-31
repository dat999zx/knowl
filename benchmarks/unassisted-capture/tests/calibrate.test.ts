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

  it('reports agreement below 1 when the classes overlap', () => {
    const scored = [
      { similarity: 0.6, same: true },
      { similarity: 0.65, same: false },
    ];

    expect(chooseThreshold(scored).agreement).toBeLessThan(1);
  });

  it('throws on an empty set rather than inventing a threshold', () => {
    expect(() => chooseThreshold([])).toThrow(/calibration/i);
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
