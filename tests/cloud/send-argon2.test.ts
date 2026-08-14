import { describe, expect, it } from 'vitest';
import { ARGON2_PARAMS, argon2id, fallbackArgon2id, nativeArgon2id } from '../../src/cloud/send/argon2.js';

/**
 * The one property a two-backend KDF has to keep.
 *
 * `send` derives on the sender's runtime and `receive` derives on the receiver's, and nothing
 * makes those the same Node version. If the built-in and the fallback disagreed by one byte, a
 * bundle sealed on Node 24 would be unopenable on Node 22 -- and it would fail as "no bundle
 * waiting on that code", because a derivation that lands on the wrong mailbox id looks exactly
 * like a typo. That is the failure this file exists to prevent.
 */
describe('the two Argon2id backends', () => {
  it('agree byte for byte, or a bundle stops crossing Node versions', () => {
    if (!nativeArgon2id) {
      // Node < 24.7 has only one backend, so there is nothing to compare. Skipped rather than
      // silently passing: a green run on such a runtime has NOT checked this.
      expect(nativeArgon2id).toBeNull();
      return;
    }
    const secret = 'owl-cascade-ridge-plum-tin';
    const salt = 'knowl-send:v2';
    expect(Buffer.from(nativeArgon2id(secret, salt, 32)).toString('hex'))
      .toBe(Buffer.from(fallbackArgon2id(secret, salt, 32)).toString('hex'));
  });

  it('is reached through whichever one exists', () => {
    const derived = argon2id('owl-cascade-ridge-plum-tin', 'knowl-send:v2', 32);
    expect(derived).toHaveLength(32);
    const expected = nativeArgon2id ?? fallbackArgon2id;
    expect(derived.equals(expected('owl-cascade-ridge-plum-tin', 'knowl-send:v2', 32))).toBe(true);
  });
});

describe('the cost parameters', () => {
  it('are the ones the whole change is for', () => {
    // 64 MiB per guess is the number that takes 2^55 out of reach. A later edit that quietly
    // lowered it would leave every test in this repository green while undoing the issue.
    expect(ARGON2_PARAMS.memory).toBe(65_536);
    expect(ARGON2_PARAMS.passes).toBe(3);
    expect(ARGON2_PARAMS.parallelism).toBe(1);
  });
});

describe('the derivation itself', () => {
  it('separates domains by salt', () => {
    const secret = 'owl-cascade-ridge-plum-tin';
    expect(argon2id(secret, 'knowl-send:v2', 32).equals(argon2id(secret, 'knowl-send:v3', 32)))
      .toBe(false);
  });

  it('is deterministic, or the recipient cannot find the bundle', () => {
    const a = argon2id('owl-cascade-ridge-plum-tin', 'knowl-send:v2', 32);
    const b = argon2id('owl-cascade-ridge-plum-tin', 'knowl-send:v2', 32);
    expect(a.equals(b)).toBe(true);
  });
});
