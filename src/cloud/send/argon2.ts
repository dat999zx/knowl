import crypto from 'node:crypto';
import { argon2id as nobleArgon2id } from '@noble/hashes/argon2.js';

/**
 * Argon2id, on whichever runtime this is.
 *
 * **Why a memory-hard KDF at all.** The send code is five words, about 2^55, and both the mailbox
 * id and the sealing key come off it. HKDF-SHA256 -- what v1 used -- is fast by design, so a
 * database snapshot could be ground against stored mailbox ids in hours-to-days on a GPU rig:
 * inside a mailbox's own 24-72 hour life. 2^55 is only expensive if each guess is expensive, and
 * at 64 MiB per guess it is.
 *
 * **Why two backends.** `crypto.argon2Sync` landed in Node 24.7 and this package declares
 * `engines: node >=22`. Bumping that floor would drop Node 22 LTS -- supported until April 2027 --
 * for every knowl user, over a feature most of them do not use. So the built-in is preferred where
 * it exists and `@noble/hashes` covers the rest: audited, no dependencies of its own, and verified
 * byte-identical to Node's before it was chosen. `tests/cloud/send-argon2.test.ts` pins that
 * equality, because two backends that disagreed by one byte would make a bundle sealed on Node 24
 * unopenable on Node 22 -- reported as "no bundle waiting on that code", indistinguishable from a
 * typo.
 *
 * This is the one dependency in this corner of the tree, in a repository that treats a package
 * added for ten lines as a supply-chain surface added for ten lines. The honest accounting is that
 * it is not for ten lines: it is what lets a memory-hard KDF ship without a major version bump.
 */

/**
 * 64 MiB, three passes, no parallelism -- about 0.6s natively and 1.4s through the fallback,
 * which is the 0.5-1s band this is supposed to sit in.
 *
 * `parallelism: 1` deliberately. Lanes help a defender with spare cores and help an attacker with
 * thousands, and a CLI deriving exactly one key has nothing to parallelise.
 */
export const ARGON2_PARAMS = { memory: 65_536, passes: 3, parallelism: 1 } as const;

/**
 * Node 24.7's addition, reached through a probe rather than a type import.
 *
 * `@types/node` is pinned at 22 to match the declared engines floor, which is the right pin: it is
 * what stops the rest of this codebase from reaching for a Node 24 API unguarded. So the signature
 * is declared here, narrowly, at the one place that has checked for it at runtime.
 */
type Argon2Sync = (algorithm: 'argon2id', options: {
  message: Uint8Array;
  nonce: Uint8Array;
  parallelism: number;
  tagLength: number;
  memory: number;
  passes: number;
}) => Uint8Array;

const builtin = (crypto as unknown as { argon2Sync?: Argon2Sync }).argon2Sync;

/** Null below Node 24.7. Exported so the equality test can tell "agreed" from "not checked". */
export const nativeArgon2id: ((secret: string, salt: string, length: number) => Buffer) | null =
  typeof builtin === 'function'
    ? (secret, salt, length) => Buffer.from(builtin('argon2id', {
        message: Buffer.from(secret, 'utf8'),
        nonce: Buffer.from(salt, 'utf8'),
        tagLength: length,
        ...ARGON2_PARAMS,
      }))
    : null;

export function fallbackArgon2id(secret: string, salt: string, length: number): Buffer {
  return Buffer.from(nobleArgon2id(Buffer.from(secret, 'utf8'), Buffer.from(salt, 'utf8'), {
    t: ARGON2_PARAMS.passes,
    m: ARGON2_PARAMS.memory,
    p: ARGON2_PARAMS.parallelism,
    dkLen: length,
  }));
}

/** The same bytes either way. Which one ran is a performance fact, never a correctness one. */
export function argon2id(secret: string, salt: string, length: number): Buffer {
  return (nativeArgon2id ?? fallbackArgon2id)(secret, salt, length);
}
