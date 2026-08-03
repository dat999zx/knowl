import { randomInt } from 'node:crypto';

/**
 * Letters a person will not mis-transcribe.
 *
 * Omits `l` and `i` (confusable with `1`), `o` (with `0`), `s` (with `5`) and `z` (with `2`).
 * Vowels are omitted too: without them the alternating pattern below cannot spell a word even
 * by accident.
 */
const LETTERS = 'bcdfghjkmnpqrtvwxy';

/** Digits with the same treatment: no `0`, `1`, `2` or `5`. */
const DIGITS = '346789';

const KEY_LENGTH = 6;

const pick = (alphabet: string) => alphabet[randomInt(alphabet.length)];

/**
 * A key the user keeps.
 *
 * Letter-digit alternating, six characters. The shape is not cosmetic: a key is pasted back
 * into a prompt, and a six-character key from a full alphabet can legitimately spell `budget`
 * or `delete`. A key that reads as an instruction is one a model may act on instead of look up.
 * Alternating positions makes a pronounceable word structurally impossible.
 *
 * 18 letters x 6 digits per pair, three pairs: about 1.26 million keys. Collisions are handled
 * by the caller retrying on a unique-constraint violation, not by making the key longer.
 */
export function mintResumeKey(): string {
  let key = '';
  for (let i = 0; i < KEY_LENGTH; i += 2) key += pick(LETTERS) + pick(DIGITS);
  return key;
}

const KEY_SHAPE = new RegExp(`^([${LETTERS}][${DIGITS}]){${KEY_LENGTH / 2}}$`);

/**
 * The key inside whatever the user pasted, or null.
 *
 * People paste keys with quotes, backticks, stray whitespace, and often the whole instruction
 * line they were given. Rejecting those would mean the feature works only for people who
 * hand-extract the key, which is exactly the friction the short key exists to avoid.
 *
 * Null rather than a nearest match: resuming the wrong workstream silently is worse than saying
 * the key is unknown.
 */
export function normalizeResumeKey(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .trim()
    .replace(/^knowl\s+resume\s+/i, '')
    .replace(/^[`'"]+|[`'"]+$/g, '')
    .trim()
    .toLowerCase();

  return KEY_SHAPE.test(cleaned) ? cleaned : null;
}

/**
 * The line to hand the user verbatim.
 *
 * Returned instead of the bare key because a key reworded is a key lost: told only "your key is
 * k3t9m4", people write it into a note and later paste something the next session does not
 * recognise as a resume request. One pasteable line removes that step.
 */
export function resumeInstruction(key: string): string {
  return `To pick this up later, paste this into any Knowl session: knowl resume ${key}`;
}
