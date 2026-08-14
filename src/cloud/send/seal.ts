import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { DerivationVersion } from './code.js';

/**
 * Sealing, with `node:crypto` and no dependency.
 *
 * AES-256-GCM: authenticated, in Node's standard library, and the reason a wrong code fails loudly
 * instead of handing back plausible noise for the importer to write into somebody's store.
 *
 * A library with a nicer API would be one dependency for one encrypt and one decrypt, in a
 * repository that treats a package added for ten lines as a supply-chain surface added for ten
 * lines. `randomBytes` and `aes-256-gcm` are both already here.
 *
 * **These functions take the derived key, not the code.** Deriving is Argon2id at 64 MiB since v2,
 * so a signature that took the code would make every send pay for it twice -- once to address the
 * mailbox and once to seal it. The caller derives once and passes both halves where they go.
 *
 * **The server can open none of this.** It receives the sealed bytes and an id derived from the
 * same code under a different label; the key never leaves the sender's machine. That is the whole
 * basis of the claim that the relay stores a blob it cannot read, and it is a property only this
 * file can keep -- the server has no way to check it.
 */

/** 96 bits, the size GCM is specified for. */
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * A v2 bundle says so, in a byte the tag covers.
 *
 * The version is already known by the time anything is unsealed -- it comes from *which mailbox id
 * hit*, since the id is the lookup key and its derivation is what changed. So this byte is a
 * cross-check rather than a discriminator, and it could not have been the discriminator anyway: a
 * v1 bundle opens with a random nonce whose first byte is 0x02 once in 256.
 *
 * It is **additional authenticated data**, not merely a prefix. A prefix a receiver reads and
 * trusts is a byte an attacker can flip to steer which key schedule gets used; as AAD, flipping it
 * fails the tag.
 */
const VERSION_BYTE = 2;

/**
 * `nonce || ciphertext || tag` for v1, and `0x02 || nonce || ciphertext || tag` for v2 -- which is
 * what goes over the wire, base64'd by the caller.
 */
export function seal(payload: Buffer, key: Buffer, version: DerivationVersion): Buffer {
  // Fresh per seal. Reuse under one key is the failure GCM does not survive, and while a fresh
  // code per send already gives a fresh key, this does not depend on that staying true.
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const prefix = version === 2 ? Buffer.of(VERSION_BYTE) : Buffer.alloc(0);
  if (version === 2) cipher.setAAD(prefix);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([prefix, nonce, ciphertext, cipher.getAuthTag()]);
}

/**
 * Throws on a wrong code, a truncated blob, a flipped bit or a version that does not match what
 * the mailbox id said. Never returns partial plaintext.
 *
 * The caller is about to hand the result to `importKnowledge`, so "decrypted to something" and
 * "decrypted to the right thing" have to be the same question. GCM's tag is what makes them one.
 *
 * `version` comes from the peek that succeeded, not from the bytes -- see `VERSION_BYTE`.
 */
export function unseal(sealed: Buffer, key: Buffer, version: DerivationVersion): Buffer {
  const prefixLength = version === 2 ? 1 : 0;
  if (sealed.length < prefixLength + NONCE_BYTES + TAG_BYTES) {
    throw new Error('That bundle is too short to be a sealed payload.');
  }
  if (version === 2 && sealed[0] !== VERSION_BYTE) {
    // The mailbox id said v2 and the bundle says otherwise. Reaching this means the stored blob is
    // not the one that id addresses, so there is nothing safe to try next.
    throw new Error('That bundle does not carry the derivation its mailbox id promised.');
  }

  const nonce = sealed.subarray(prefixLength, prefixLength + NONCE_BYTES);
  const ciphertext = sealed.subarray(prefixLength + NONCE_BYTES, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);

  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  if (version === 2) decipher.setAAD(sealed.subarray(0, 1));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
