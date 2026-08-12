import { describe, expect, it } from 'vitest';
import { decodeVector, encodeVector, VectorDecodeError } from '../../src/cloud/vector-codec.js';

describe('vector codec', () => {
  it('encodes to base64 of a little-endian Float32Array', () => {
    // A FIXED expected value, not a round-trip through our own decoder -- that would pass for any
    // self-consistent encoding, including one knowl-cloud cannot read. This literal is the
    // contract; verify it once by decoding it there, then treat it as a constant.
    expect(encodeVector([1, 2])).toBe('AACAPwAAAEA=');
  });

  it('round-trips without loss', () => {
    const original = Float32Array.from([0.5, -0.25, 0, 1]);
    expect(Array.from(decodeVector(encodeVector(original), 4))).toEqual([0.5, -0.25, 0, 1]);
  });

  it('accepts a plain number array on the way in', () => {
    expect(encodeVector(Float32Array.from([1, 2]))).toBe(encodeVector([1, 2]));
  });

  it('produces four bytes per dimension', () => {
    expect(Buffer.from(encodeVector(new Array(384).fill(0)), 'base64').byteLength).toBe(384 * 4);
  });

  it('refuses a payload that is not base64', () => {
    expect(() => decodeVector('not base64 !!!', 4)).toThrow(VectorDecodeError);
  });

  it('refuses a byte length that is not a whole number of floats', () => {
    expect(() => decodeVector(Buffer.from([1, 2, 3]).toString('base64'), 1)).toThrow(/float32/i);
  });

  it('refuses the right encoding at the wrong dimension', () => {
    // The replica's vector column has no width constraint either, so a 768-dim vector from a
    // workspace on another model would store happily and rank as noise forever.
    expect(() => decodeVector(encodeVector([1, 2, 3]), 384)).toThrow(/dimension/i);
  });

  it('names the reason, so a caller can say something useful', () => {
    try {
      decodeVector(encodeVector([1]), 384);
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as VectorDecodeError).reason).toBe('wrong-dimensions');
    }
  });

  it('does not read a neighbour\'s bytes when the buffer is pooled', () => {
    const vectors = Array.from({ length: 64 }, (_, i) => [i, i + 0.5, i + 0.25, i + 0.125]);
    for (const values of vectors) {
      expect(Array.from(decodeVector(encodeVector(values), 4))).toEqual(values);
    }
  });
});
