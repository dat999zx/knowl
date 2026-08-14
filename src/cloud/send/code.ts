import { hkdfSync, randomInt } from 'node:crypto';
import { WORDLIST } from './wordlist.js';
import { argon2id } from './argon2.js';

/**
 * Words in a code. Five of 2048 is about 2^55.
 *
 * Sized for an anonymous distributed guesser, which decision `8b24a27615914365` then removed by
 * requiring the receiver to hold an account -- guessing is now rate-limited per caller and
 * attributable. So this is stronger than it currently needs to be, deliberately: entropy is cheap
 * to keep and expensive to add back, and it holds the property if auth is ever relaxed.
 */
export const CODE_WORDS = 5;

/**
 * A sixth word, on request: 2048^6, about 2^66.
 *
 * Cheap alongside the v2 derivation and pointless instead of it. What made 2^55 reachable was the
 * cost per guess, not the exponent -- 11 more bits against a fast KDF buys hours, while 64 MiB per
 * guess takes the whole codespace out of reach. Offered because a sender who wants both can have
 * both, and the server never learns how long a code was: the derivation's output width is fixed.
 */
export const MAX_CODE_WORDS = 6;

/**
 * Which derivation produced a mailbox id and a sealing key.
 *
 * v1 is HKDF-SHA256 straight off the code, which is what knowl 5.1.0 shipped and what every
 * bundle already in flight was sealed under. v2 is Argon2id. Both stay, because a 5.1.0 sender
 * outlives the last v1 bundle by however long it takes that install to be upgraded.
 */
export type DerivationVersion = 1 | 2;

/** What a fresh send uses. */
export const CURRENT_DERIVATION: DerivationVersion = 2;

/**
 * The order a receiver tries, newest first.
 *
 * **The id is the lookup key, so a receiver has to pick a derivation before it can read
 * anything.** Nothing inside the bundle can tell it which, because the bundle is only reachable
 * once the id is known -- so the only way to stay compatible is to derive both and ask twice. One
 * round trip for a v2 bundle, two for a v1 bundle or a mistyped code.
 */
export const DERIVATION_VERSIONS: readonly DerivationVersion[] = [2, 1];

/**
 * Fixed, published, and not a secret.
 *
 * There is nothing to agree on out of band here -- the two humans exchange the code and nothing
 * else -- and all of the entropy lives in the code, so a constant salt costs nothing. Its job is
 * domain separation, and the version in it is what stops a v2 derivation from ever colliding with
 * a v3 one over the same code.
 */
const SALT_V1 = Buffer.from('knowl-send-v1', 'utf8');
const SALT_V2 = 'knowl-send:v2';

/**
 * The code, as a human will actually give it back.
 *
 * It travels by voice, chat and copy-paste, so it comes back hyphenated or spaced, in whatever
 * case the sender's client used, wrapped in whatever whitespace the paste carried. Deriving from
 * the raw string would make a correct code miss its own mailbox.
 */
export function normalizeCode(code: string): string {
  return code.trim().toLowerCase().split(/[\s-]+/).filter(Boolean).join('-');
}

/**
 * A fresh code.
 *
 * `randomInt` rather than `Math.random`: this is the entire secret. `randomInt` is also rejection-
 * sampled by Node, so the distribution over 2048 is uniform rather than biased by a modulo.
 */
export function generateCode(words: number = CODE_WORDS): string {
  if (!Number.isInteger(words) || words < CODE_WORDS || words > MAX_CODE_WORDS) {
    throw new Error(`A code is ${CODE_WORDS} or ${MAX_CODE_WORDS} words, not ${words}.`);
  }
  return Array.from({ length: words }, () => WORDLIST[randomInt(WORDLIST.length)]).join('-');
}

/** Where the bundle lives, and what unlocks it. */
export type SendSecrets = { mailboxId: string; key: Buffer };

/**
 * One memory-hard pass, split by HKDF into the public id and the secret key.
 *
 * **Why one Argon2id call and not two.** The issue this implements reads as one derivation per
 * domain string. An attacker grinding the codespace against stored mailbox ids only ever needs the
 * *id*, so they pay for exactly one Argon2id per guess either way -- a second call costs the
 * honest client double and the attacker nothing. The versioned domain strings survive as the HKDF
 * labels, which is where they do their work.
 *
 * The id is public: it travels to the server, is stored, and appears in logs. It still cannot
 * disclose the key, for the same reason it could not in v1 -- it is a 16-byte HKDF output over a
 * 256-bit master, and running that backwards is the infeasible step.
 *
 * 16 bytes, so the id is 32 lowercase hex. That is not an arbitrary width: the server's contract
 * pins `^[a-f0-9]{32}$|^[a-f0-9]{64}$`, which is why a v2 derivation needs no server change at
 * all.
 */
function deriveV2(code: string): SendSecrets {
  const master = argon2id(normalizeCode(code), SALT_V2, 32);
  return {
    mailboxId: Buffer.from(hkdfSync('sha256', master, SALT_V2, 'knowl-send:id:v2', 16)).toString('hex'),
    key: Buffer.from(hkdfSync('sha256', master, SALT_V2, 'knowl-send:key:v2', 32)),
  };
}

/**
 * knowl 5.1.0's derivation, kept verbatim.
 *
 * Two HKDF-SHA256 outputs under distinct `info` labels -- safe against the id disclosing the key,
 * and fast, which is the whole problem. Nothing here may change: every byte of it is what a
 * bundle already sitting in the drop box was addressed and sealed under.
 */
function deriveV1(code: string): SendSecrets {
  const normalized = normalizeCode(code);
  return {
    mailboxId: Buffer.from(hkdfSync('sha256', normalized, SALT_V1, 'knowl-send:id:v1', 16)).toString('hex'),
    key: Buffer.from(hkdfSync('sha256', normalized, SALT_V1, 'knowl-send:key:v1', 32)),
  };
}

export function deriveSecrets(code: string, version: DerivationVersion): SendSecrets {
  return version === 2 ? deriveV2(code) : deriveV1(code);
}

/** Where the bundle lives, for callers that need the address and not the key. */
export function deriveMailboxId(code: string, version: DerivationVersion): string {
  return deriveSecrets(code, version).mailboxId;
}
