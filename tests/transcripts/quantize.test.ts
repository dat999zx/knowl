import { describe, expect, it } from 'vitest';
import { dequantizeVector, dotQuantized, quantizeScale, quantizeVector, transcriptVectorFingerprint } from '../../src/transcripts/quantize.js';

/** A unit-length vector, which is what the embedder produces (`normalize: true`). */
function unitVector(dims: number, seed: number): number[] {
  const raw = Array.from({ length: dims }, (_, i) => Math.sin(seed * (i + 1)));
  const norm = Math.hypot(...raw);
  return raw.map(v => v / norm);
}

describe('quantizeScale', () => {
  it('clips at roughly six sigma for the given dimensionality', () => {
    // L2-normalised components have RMS 1/sqrt(dims), so 6/sqrt(dims) is a ~6 sigma clip.
    expect(quantizeScale(384)).toBeCloseTo(6 / Math.sqrt(384), 10);
    expect(quantizeScale(1024)).toBeCloseTo(6 / Math.sqrt(1024), 10);
  });

  it('shrinks as dimensionality grows, because components do', () => {
    expect(quantizeScale(1024)).toBeLessThan(quantizeScale(384));
  });
});

describe('quantizeVector', () => {
  it('produces one byte per dimension', () => {
    const { bytes } = quantizeVector(unitVector(384, 1));
    expect(bytes.byteLength).toBe(384);
  });

  it('round-trips within quantization error', () => {
    const original = unitVector(384, 3);
    const { scale, bytes } = quantizeVector(original);
    const restored = dequantizeVector(bytes, scale);

    for (let i = 0; i < original.length; i++) {
      expect(Math.abs(restored[i] - original[i])).toBeLessThan(scale / 127);
    }
  });

  it('clamps a component beyond the clip range instead of wrapping', () => {
    const dims = 4;
    const scale = quantizeScale(dims);
    const { bytes } = quantizeVector([scale * 10, -scale * 10, 0, 0]);
    const signed = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    expect(signed[0]).toBe(127);
    expect(signed[1]).toBe(-127);
  });
});

describe('dotQuantized', () => {
  /**
   * The accuracy this method actually has, derived rather than guessed.
   *
   * Each component is rounded to a step of `scale/127`, so its error is uniform over that step
   * with standard deviation `step/sqrt(12)`. The dot product against a unit-length query sums
   * those errors weighted by the query's components, giving an error standard deviation of
   * `||a|| * step/sqrt(12)` = `step/sqrt(12)`. At 384 dims that is ~0.0007.
   *
   * Six sigma is the bound below. Asserting three decimal places -- absolute error under
   * 0.0005 -- would be asserting *below one sigma*, which fails on ordinary seed pairs: the
   * first one tried here missed by 0.00084, a perfectly normal 1.2 sigma draw.
   */
  const errorBound = (dims: number) => 6 * (quantizeScale(dims) / 127) / Math.sqrt(12);

  it('preserves cosine similarity to within six sigma of quantization noise', () => {
    for (const [seedA, seedB] of [[5, 9], [1, 2], [3, 13], [7, 21], [11, 4]]) {
      const a = unitVector(384, seedA);
      const b = unitVector(384, seedB);
      const exact = a.reduce((sum, value, i) => sum + value * b[i], 0);

      const { scale, bytes } = quantizeVector(b);

      expect(Math.abs(dotQuantized(a, bytes, scale) - exact)).toBeLessThan(errorBound(384));
    }
  });

  it('scores a vector against itself near 1', () => {
    const a = unitVector(384, 7);
    const { scale, bytes } = quantizeVector(a);
    expect(dotQuantized(a, bytes, scale)).toBeCloseTo(1, 2);
  });

  it('returns 0 when dimensions disagree', () => {
    const { scale, bytes } = quantizeVector(unitVector(384, 2));
    expect(dotQuantized(unitVector(16, 2), bytes, scale)).toBe(0);
  });

  /**
   * Quantization must not reorder results -- the only property search actually depends on.
   *
   * The candidates are built by mixing the query with noise in graded amounts, so their exact
   * similarities are separated by far more than the ~0.0007 error above. Ranking 25 *random*
   * vectors instead tests nothing useful: they are all near-orthogonal to the query and to each
   * other, so neighbouring scores differ by less than the quantization noise and the order of
   * those near-ties is arbitrary in either representation.
   */
  it('preserves the ranking of a well-separated candidate set', () => {
    const query = unitVector(384, 11);
    const candidates = Array.from({ length: 20 }, (_, i) => {
      const noise = unitVector(384, i + 31);
      const weight = i / 20; // 0 (pure noise) up to 0.95 (nearly the query)
      const mixed = query.map((q, d) => weight * q + (1 - weight) * noise[d]);
      const norm = Math.hypot(...mixed);
      return mixed.map(v => v / norm);
    });

    const score = (c: number[]) => c.reduce((sum, v, d) => sum + v * query[d], 0);
    const exactScores = candidates.map(score);

    // The premise of the test: consecutive candidates really are far apart.
    const gaps = exactScores.slice().sort((a, b) => a - b).slice(1)
      .map((s, i) => s - exactScores.slice().sort((a, b) => a - b)[i]);
    expect(Math.min(...gaps)).toBeGreaterThan(errorBound(384));

    const order = (scores: number[]) =>
      scores.map((s, i) => ({ i, s })).sort((a, b) => b.s - a.s).map(e => e.i);

    const quantizedScores = candidates.map(c => {
      const { scale, bytes } = quantizeVector(c);
      return dotQuantized(query, bytes, scale);
    });

    expect(order(quantizedScores)).toEqual(order(exactScores));
  });
});

/**
 * The round trip must preserve the vector, not merely a scaled copy of it.
 *
 * This is the test that was missing. `quantizeScale` clipped at `6/sqrt(dims)` on the argument
 * that L2-normalised components sit near `1/sqrt(dims)` -- true on average, false in the tail
 * that matters. `granite-small-en-r2`, the shipped default, carries a rogue component near 0.70
 * against a 0.3062 threshold, so exactly one component of 384 clipped and cost 25% of the norm
 * and ~22 degrees of direction. Nothing detected it: `dotQuantized` documents itself as cosine
 * because "both sides are unit-length", and the stored side quietly was not.
 *
 * A synthetic smooth vector cannot catch this -- `Math.sin(i)` normalised has a max component
 * around 0.07 and sails through the old scheme. The fixture below is shaped like a real
 * embedding: one dominant dimension, the rest small.
 */
describe('quantize round trip preserves the vector', () => {
  /** One rogue component, 383 ordinary ones — the shape a real transformer embedding has. */
  const roguey = (): number[] => {
    const v = new Array(384).fill(0).map((_, i) => Math.sin(i * 12.9898) * 0.05);
    v[7] = 0.70;
    const n = Math.hypot(...v);
    return v.map(x => x / n);
  };
  const norm = (v: number[]) => Math.hypot(...v);
  const cos = (a: number[], b: number[]) => {
    const d = a.reduce((s, x, i) => s + x * b[i], 0);
    return d / (norm(a) * norm(b));
  };

  it('keeps unit length when a component exceeds the old fixed threshold', () => {
    const v = roguey();
    expect(Math.max(...v.map(Math.abs))).toBeGreaterThan(quantizeScale(384));

    const { scale, bytes } = quantizeVector(v);
    const back = dequantizeVector(bytes, scale);

    // The old fixed scale produced 0.75 here. Anything materially below 1 is a clipped component.
    expect(norm(back)).toBeGreaterThan(0.99);
    expect(norm(back)).toBeLessThan(1.01);
  });

  it('keeps direction, so a stored vector still means what it meant', () => {
    const v = roguey();
    const { scale, bytes } = quantizeVector(v);
    // The old fixed scale produced 0.923 here.
    expect(cos(v, dequantizeVector(bytes, scale))).toBeGreaterThan(0.999);
  });

  it('makes dotQuantized the cosine it claims to be', () => {
    const v = roguey();
    const { scale, bytes } = quantizeVector(v);
    // Query against the document's own direction: a true cosine is 1, a norm-scaled one is not.
    expect(dotQuantized(v, bytes, scale)).toBeGreaterThan(0.999);
  });

  it('does not divide by zero on a zero vector', () => {
    const { scale, bytes } = quantizeVector(new Array(384).fill(0));
    expect(Number.isFinite(scale)).toBe(true);
    expect(dequantizeVector(bytes, scale).every(Number.isFinite)).toBe(true);
  });

  it('stamps a quantization version the profile fingerprint cannot see', () => {
    // The repair path: `embedPendingMessages` deletes rows whose fingerprint differs, so a
    // change in encoding has to change the fingerprint or stale rows are searched forever.
    expect(transcriptVectorFingerprint('abc')).not.toBe('abc');
    expect(transcriptVectorFingerprint('abc')).toContain('abc');
  });
});
