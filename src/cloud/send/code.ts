import { hkdfSync, randomInt } from 'node:crypto';
import { WORDLIST } from './wordlist.js';

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
 * Fixed, published, and not a secret.
 *
 * HKDF wants a salt and there is nothing to agree on out of band here -- the two humans exchange
 * the code and nothing else. All of the entropy lives in the code, so a constant salt costs
 * nothing; its job is domain separation from any other HKDF use in this codebase.
 */
const SALT = Buffer.from('knowl-send-v1', 'utf8');

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
export function generateCode(): string {
  return Array.from({ length: CODE_WORDS }, () => WORDLIST[randomInt(WORDLIST.length)]).join('-');
}

/**
 * Where the bundle lives, and what unlocks it -- derived from the same code, and independent.
 *
 * The id is public: it travels to the server, is stored, and appears in logs. The key never
 * leaves this machine. Both come from one secret, so they are two HKDF outputs under distinct
 * `info` labels, which is the standard construction for exactly this and states the independence
 * rather than leaving a reader to deduce it.
 *
 * PR #50 specifies `sha256(code)` for the id, which is also safe -- SHA-256 is one-way, so the id
 * does not disclose the key. The server stores whatever id it is handed, so this is a client-side
 * choice with no contract impact.
 */
export function deriveMailboxId(code: string): string {
  const derived = hkdfSync('sha256', normalizeCode(code), SALT, 'knowl-send:id:v1', 16);
  return Buffer.from(derived).toString('hex');
}

export function deriveKey(code: string): Buffer {
  return Buffer.from(hkdfSync('sha256', normalizeCode(code), SALT, 'knowl-send:key:v1', 32));
}
