import { describe, expect, it } from 'vitest';
import { WORDLIST } from '../../src/cloud/send/wordlist.js';
import { CODE_WORDS, deriveKey, deriveMailboxId, generateCode, normalizeCode } from '../../src/cloud/send/code.js';
import { seal, unseal } from '../../src/cloud/send/seal.js';

describe('the send code', () => {
  it('is five words from the list, joined so a human can read it aloud', () => {
    const code = generateCode();
    const words = code.split('-');
    expect(words).toHaveLength(CODE_WORDS);
    for (const word of words) expect(WORDLIST).toContain(word);
  });

  it('does not repeat itself', () => {
    // Not a randomness test -- a broken generator that returned a constant would pass every other
    // case in this file, and this is the cheapest thing that catches it.
    const codes = new Set(Array.from({ length: 50 }, () => generateCode()));
    expect(codes.size).toBe(50);
  });

  it('accepts a code the way a human retypes it', () => {
    // Spaces for hyphens, stray case, stray whitespace. The code travels through chat and voice,
    // so the shapes it comes back in are not the shape it left in.
    const canonical = 'owl-cascade-ridge-plum-tin';
    for (const typed of ['owl cascade ridge plum tin', 'OWL-Cascade-Ridge-PLUM-tin', '  owl-cascade-ridge-plum-tin  ']) {
      expect(normalizeCode(typed)).toBe(canonical);
    }
  });
});

describe('deriving the mailbox id and the key from one code', () => {
  const code = 'owl-cascade-ridge-plum-tin';

  it('is deterministic, or the recipient cannot find the bundle', () => {
    expect(deriveMailboxId(code)).toBe(deriveMailboxId(code));
    expect(deriveKey(code).equals(deriveKey(code))).toBe(true);
  });

  it('gives a different id and key for a different code', () => {
    expect(deriveMailboxId(code)).not.toBe(deriveMailboxId('owl-cascade-ridge-plum-tan'));
  });

  it('derives the id and the key independently', () => {
    // Both come from one secret, so the id -- which is public, and travels to the server -- must
    // not disclose the key. Two HKDF calls with distinct info labels is what buys that. A weak
    // assertion, but it fails loudly if someone collapses the two labels into one.
    const id = deriveMailboxId(code);
    const key = deriveKey(code).toString('hex');
    expect(id).not.toBe(key);
    expect(key.startsWith(id)).toBe(false);
    expect(id.startsWith(key)).toBe(false);
  });

  it('normalizes before deriving, so a retyped code still finds the bundle', () => {
    expect(deriveMailboxId('OWL CASCADE RIDGE PLUM TIN')).toBe(deriveMailboxId(code));
  });
});

describe('sealing a bundle', () => {
  const code = 'owl-cascade-ridge-plum-tin';
  const payload = Buffer.from('{"format":3,"items":[{"id":"a"}]}\n', 'utf8');

  it('round-trips byte for byte', () => {
    expect(unseal(seal(payload, code), code).equals(payload)).toBe(true);
  });

  it('produces a different ciphertext every time, for the same input', () => {
    // A fresh nonce per seal. Identical ciphertexts would leak that two people were handed the
    // same bundle, to anybody who can read the table.
    expect(seal(payload, code).equals(seal(payload, code))).toBe(false);
  });

  it('refuses a wrong code rather than returning garbage', () => {
    // GCM's authentication tag doing its job. If this ever returns a Buffer instead of throwing,
    // the cipher has been swapped for one without integrity and the receiver would import noise.
    expect(() => unseal(seal(payload, code), 'owl-cascade-ridge-plum-tan')).toThrow();
  });

  it('refuses a tampered ciphertext', () => {
    const sealed = seal(payload, code);
    sealed[sealed.length - 1] ^= 0xff;
    expect(() => unseal(sealed, code)).toThrow();
  });

  it('never contains the code or the key in what goes to the server', () => {
    // The one property the server cannot check for itself, and the whole basis of the claim that
    // it stores a blob it cannot open.
    const sealed = seal(payload, code).toString('hex');
    expect(sealed).not.toContain(Buffer.from(code, 'utf8').toString('hex'));
    expect(sealed).not.toContain(deriveKey(code).toString('hex'));
  });
});
