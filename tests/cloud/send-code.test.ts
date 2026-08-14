import { describe, expect, it } from 'vitest';
import { WORDLIST } from '../../src/cloud/send/wordlist.js';
import {
  CODE_WORDS, CURRENT_DERIVATION, DERIVATION_VERSIONS, MAX_CODE_WORDS,
  deriveMailboxId, deriveSecrets, generateCode, normalizeCode,
} from '../../src/cloud/send/code.js';
import { seal, unseal } from '../../src/cloud/send/seal.js';

describe('the send code', () => {
  it('is five words from the list, joined so a human can read it aloud', () => {
    const code = generateCode();
    const words = code.split('-');
    expect(words).toHaveLength(CODE_WORDS);
    for (const word of words) expect(WORDLIST).toContain(word);
  });

  it('takes a sixth word on request, for the sender who wants 2^66', () => {
    const words = generateCode(MAX_CODE_WORDS).split('-');
    expect(words).toHaveLength(MAX_CODE_WORDS);
    for (const word of words) expect(WORDLIST).toContain(word);
  });

  it('refuses a length nobody asked for', () => {
    // Four words is 2^44, which the wordlist would happily produce. A typo in a flag must not
    // quietly weaken the one secret in this feature.
    for (const words of [4, 7, 0, -1, 5.5]) expect(() => generateCode(words)).toThrow();
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

  it('sends under v2 and still understands v1', () => {
    expect(CURRENT_DERIVATION).toBe(2);
    // Newest first: a v2 bundle costs one round trip and a v1 bundle two. Reversing this would
    // make every receive pay the fallback.
    expect([...DERIVATION_VERSIONS]).toEqual([2, 1]);
  });

  for (const version of DERIVATION_VERSIONS) {
    describe(`v${version}`, () => {
      it('is deterministic, or the recipient cannot find the bundle', () => {
        const a = deriveSecrets(code, version);
        const b = deriveSecrets(code, version);
        expect(a.mailboxId).toBe(b.mailboxId);
        expect(a.key.equals(b.key)).toBe(true);
      });

      it('gives a different id and key for a different code', () => {
        expect(deriveMailboxId(code, version)).not.toBe(deriveMailboxId('owl-cascade-ridge-plum-tan', version));
      });

      it('derives the id and the key independently', () => {
        // Both come from one secret, so the id -- which is public, and travels to the server --
        // must not disclose the key. Distinct HKDF info labels is what buys that. A weak
        // assertion, but it fails loudly if someone collapses the two labels into one.
        const { mailboxId, key } = deriveSecrets(code, version);
        const keyHex = key.toString('hex');
        expect(mailboxId).not.toBe(keyHex);
        expect(keyHex.startsWith(mailboxId)).toBe(false);
        expect(mailboxId.startsWith(keyHex)).toBe(false);
      });

      it('normalizes before deriving, so a retyped code still finds the bundle', () => {
        expect(deriveMailboxId('OWL CASCADE RIDGE PLUM TIN', version)).toBe(deriveMailboxId(code, version));
      });

      it('emits an id the server will accept', () => {
        // Not cosmetic: knowl-cloud pins `^[a-f0-9]{32}$|^[a-f0-9]{64}$`, and an id of any other
        // width is rejected at the schema before it reaches a handler. This is the assertion that
        // says a v2 derivation needs no server change.
        expect(deriveMailboxId(code, version)).toMatch(/^[a-f0-9]{32}$/);
      });
    });
  }

  it('addresses a different mailbox under v2 than under v1', () => {
    // The reason a receiver has to try both. If these ever collided, the fallback would silently
    // hand a v1 key to a v2 bundle.
    expect(deriveMailboxId(code, 2)).not.toBe(deriveMailboxId(code, 1));
  });

  it('costs enough per guess to be worth the wait', () => {
    // The whole point of #102, measured rather than asserted about. HKDF-SHA256 -- what v1 does --
    // returns in microseconds; anything in that range here means the memory-hard pass is gone and
    // 2^55 is grindable again. The bound is deliberately loose, because CI runners vary far more
    // than the four orders of magnitude between the two answers.
    const started = performance.now();
    deriveSecrets(code, 2);
    expect(performance.now() - started).toBeGreaterThan(50);
  });
});

describe('sealing a bundle', () => {
  const code = 'owl-cascade-ridge-plum-tin';
  const payload = Buffer.from('{"format":3,"items":[{"id":"a"}]}\n', 'utf8');

  for (const version of DERIVATION_VERSIONS) {
    describe(`v${version}`, () => {
      const { key } = deriveSecrets(code, version);

      it('round-trips byte for byte', () => {
        expect(unseal(seal(payload, key, version), key, version).equals(payload)).toBe(true);
      });

      it('produces a different ciphertext every time, for the same input', () => {
        // A fresh nonce per seal. Identical ciphertexts would leak that two people were handed the
        // same bundle, to anybody who can read the table.
        expect(seal(payload, key, version).equals(seal(payload, key, version))).toBe(false);
      });

      it('refuses a wrong code rather than returning garbage', () => {
        // GCM's authentication tag doing its job. If this ever returns a Buffer instead of
        // throwing, the cipher has been swapped for one without integrity and the receiver would
        // import noise.
        const wrong = deriveSecrets('owl-cascade-ridge-plum-tan', version).key;
        expect(() => unseal(seal(payload, key, version), wrong, version)).toThrow();
      });

      it('refuses a tampered ciphertext', () => {
        const sealed = seal(payload, key, version);
        sealed[sealed.length - 1] ^= 0xff;
        expect(() => unseal(sealed, key, version)).toThrow();
      });

      it('refuses a truncated blob', () => {
        expect(() => unseal(Buffer.alloc(4), key, version)).toThrow(/too short/);
      });

      it('never contains the code or the key in what goes to the server', () => {
        // The one property the server cannot check for itself, and the whole basis of the claim
        // that it stores a blob it cannot open.
        const sealed = seal(payload, key, version).toString('hex');
        expect(sealed).not.toContain(Buffer.from(code, 'utf8').toString('hex'));
        expect(sealed).not.toContain(key.toString('hex'));
      });
    });
  }

  it('says which derivation it carries, in a byte the tag covers', () => {
    const { key } = deriveSecrets(code, 2);
    const sealed = seal(payload, key, 2);
    expect(sealed[0]).toBe(2);

    // Flipping it must fail rather than steer the key schedule. This is why the byte is AAD and
    // not a plain prefix -- as a prefix, a receiver would read the attacker's value and trust it.
    sealed[0] ^= 0xff;
    expect(() => unseal(sealed, key, 2)).toThrow();
  });

  it('leaves a v1 bundle exactly as knowl 5.1.0 wrote it', () => {
    // No prefix byte, because bundles sealed by an already-published client are what the v1 path
    // exists to open. `nonce(12) || ciphertext || tag(16)` and nothing else.
    const { key } = deriveSecrets(code, 1);
    expect(seal(payload, key, 1)).toHaveLength(12 + payload.length + 16);
    expect(seal(payload, key, 2)).toHaveLength(1 + 12 + payload.length + 16);
  });
});
