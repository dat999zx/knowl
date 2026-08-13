import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { deriveKey } from './code.js';

/**
 * Sealing, with `node:crypto` and no dependency.
 *
 * AES-256-GCM: authenticated, in Node's standard library, and the reason a wrong code fails loudly
 * instead of handing back plausible noise for the importer to write into somebody's store.
 *
 * A library with a nicer API would be one dependency for one encrypt and one decrypt, in a
 * repository that treats a package added for ten lines as a supply-chain surface added for ten
 * lines. `hkdfSync`, `randomBytes` and `aes-256-gcm` are all already here.
 *
 * **The server can open none of this.** It receives the sealed bytes and an id derived from the
 * same code under a different label; the key never leaves the sender's machine. That is the whole
 * basis of the claim that the relay stores a blob it cannot read, and it is a property only this
 * file can keep -- the server has no way to check it.
 */

/** 96 bits, the size GCM is specified for. */
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** `nonce || ciphertext || tag`, which is what goes over the wire, base64'd by the caller. */
export function seal(payload: Buffer, code: string): Buffer {
  // Fresh per seal. Reuse under one key is the failure GCM does not survive, and while a fresh
  // code per send already gives a fresh key, this does not depend on that staying true.
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(code), nonce);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
}

/**
 * Throws on a wrong code, a truncated blob or a flipped bit. Never returns partial plaintext.
 *
 * The caller is about to hand the result to `importKnowledge`, so "decrypted to something" and
 * "decrypted to the right thing" have to be the same question. GCM's tag is what makes them one.
 */
export function unseal(sealed: Buffer, code: string): Buffer {
  if (sealed.length < NONCE_BYTES + TAG_BYTES) {
    throw new Error('That bundle is too short to be a sealed payload.');
  }
  const nonce = sealed.subarray(0, NONCE_BYTES);
  const ciphertext = sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);

  const decipher = createDecipheriv('aes-256-gcm', deriveKey(code), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
