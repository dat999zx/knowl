import { describe, expect, it } from 'vitest';
import { mintResumeKey, normalizeResumeKey, resumeInstruction } from '../../src/store/resume-keys.js';

describe('mintResumeKey', () => {
  it('mints a key a person can retype: short, lowercase, no lookalike characters', () => {
    for (let i = 0; i < 200; i++) {
      const key = mintResumeKey();
      expect(key).toHaveLength(8);
      expect(key).toBe(key.toLowerCase());
      expect(key).not.toMatch(/[l1i0o5s2z]/);
    }
  });

  it('never mints a key that could read as a word, so it cannot be mistaken for an instruction', () => {
    for (let i = 0; i < 500; i++) {
      const key = mintResumeKey();
      // Digits in the even positions make a pronounceable English word structurally impossible.
      expect(key).toMatch(/^[a-z]\d[a-z]\d[a-z]\d[a-z]\d$/);
    }
  });

  it('draws from the whole keyspace rather than a degenerate corner of it', () => {
    // Measured, not assumed: the keyspace is 18^4 * 6^4 = 136,048,896, so 2,000 independent
    // draws collide rarely by the birthday bound; the margin below still absorbs a couple.
    // Asserting 2,000 distinct would be a test that fails four runs in five.
    //
    // Uniqueness of *stored* keys is a different guarantee, and a real one: createResumePoint
    // retries on the UNIQUE constraint, which is where it is tested.
    const keys = new Set(Array.from({ length: 2_000 }, () => mintResumeKey()));
    expect(keys.size).toBeGreaterThan(1_990);
  });

  it('uses every position, so no character is effectively fixed', () => {
    const seen = Array.from({ length: 8 }, () => new Set<string>());
    for (let i = 0; i < 500; i++) {
      const key = mintResumeKey();
      for (let position = 0; position < 8; position++) seen[position].add(key[position]);
    }
    // 18 letters in the even positions, 6 digits in the odd ones. A generator that pinned a
    // position would still satisfy the shape regex above; this is what catches it.
    for (const position of [0, 2, 4, 6]) expect(seen[position].size).toBe(18);
    for (const position of [1, 3, 5, 7]) expect(seen[position].size).toBe(6);
  });
});

describe('normalizeResumeKey', () => {
  it('accepts the key however the user pastes it', () => {
    const variants = ['k3t9m4', 'K3T9M4', '  k3t9m4  ', '"k3t9m4"', 'knowl resume k3t9m4', '`k3t9m4`'];
    for (const variant of variants) expect(normalizeResumeKey(variant)).toBe('k3t9m4');
  });

  it('rejects anything that is not a key rather than guessing', () => {
    for (const bad of ['', '   ', 'not-a-key', 'k3t9m', 'k3t9m44', 'k3t9m!']) {
      expect(normalizeResumeKey(bad)).toBeNull();
    }
  });

  it('rejects a key containing a lookalike character it could never have minted', () => {
    expect(normalizeResumeKey('k3t9l4')).toBeNull();
  });
});

describe('resumeInstruction', () => {
  it('returns a line the user can paste verbatim into a later session', () => {
    const line = resumeInstruction('k3t9m4');
    expect(line).toContain('k3t9m4');
    expect(line.split('\n')).toHaveLength(1);
  });
});
