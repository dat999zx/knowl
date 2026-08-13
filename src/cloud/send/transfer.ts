import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProjectConfig } from '../../core/types.js';
import { closeDb, initDb } from '../../store/database.js';
import { exportKnowledge, importKnowledge } from '../../store/portability.js';
import { createCloudApi, type CloudApi, type SendPreview, type SendRefusal } from '../api-client.js';
import { cloudPointer } from '../../core/cloud-pointer.js';
import { ensureAccessToken } from '../token.js';
import { deriveMailboxId, generateCode } from './code.js';
import { seal, unseal } from './seal.js';

/**
 * `knowl send` and `knowl receive`, above the crypto and below the CLI.
 *
 * The payload is an export file and the merge is an import, deliberately. Both already exist,
 * both are versioned by `EXPORT_FORMAT_VERSION`, and `importKnowledge` already stamps arriving
 * rows `import:<workspace>/<repo>` — a value no repo name can equal, which `promoteItems` and
 * `assertOwnedItem` already treat as foreign. So knowledge received from a stranger cannot be
 * promoted or published as this repo's own, and this module needed to design none of that.
 */

export type SendResult =
  | { status: 'not-connected' }
  | { status: 'not-logged-in' }
  | { status: 'nothing-selected' }
  | { status: 'sent'; code: string; itemCount: number; expiresAt: string };

export type ReceiveResult =
  | { status: 'not-connected' }
  | { status: 'not-logged-in' }
  | { status: 'refused'; reason: SendRefusal }
  | { status: 'received'; preview: SendPreview; imported: Awaited<ReturnType<typeof importKnowledge>> };

/** A temp path that cannot collide with a concurrent send in the same process or another one. */
const scratchFile = (suffix: string) => path.join(tmpdir(), `knowl-send-${randomUUID()}.${suffix}`);

export async function sendKnowledge(input: {
  projectRoot: string;
  projectId: string;
  config: ProjectConfig;
  itemIds: readonly string[];
  senderLabel: string;
  expiresInHours: number;
  api?: CloudApi;
}): Promise<SendResult> {
  const pointer = cloudPointer(input.config);
  if (!pointer) return { status: 'not-connected' };
  if (input.itemIds.length === 0) return { status: 'nothing-selected' };

  const api = input.api ?? createCloudApi({ apiHost: pointer.apiHost });
  const credential = await ensureAccessToken({
    apiHost: pointer.apiHost,
    refresh: refreshToken => api.refresh(refreshToken),
  });
  if (!credential) return { status: 'not-logged-in' };

  // The code exists only in this function and in whatever the human pastes into chat. It is never
  // written to disk, never logged, and never sent — the server receives an id derived from it
  // under a different HKDF label, which cannot be walked back to the key.
  const code = generateCode();
  const file = scratchFile('jsonl');

  await initDb(input.projectRoot);
  let sealed: Buffer;
  try {
    await exportKnowledge(input.projectId, file, input.projectRoot, input.itemIds);
    sealed = seal(await readFile(file), code);
  } finally {
    await closeDb();
    // The plaintext export is the one artefact worth cleaning up even on failure: it is the
    // bundle unsealed, sitting in a world-readable temp directory.
    await rm(file, { force: true }).catch(() => {});
  }

  const { expiresAt } = await api.createSend({
    accessToken: credential.accessToken,
    mailboxId: deriveMailboxId(code),
    ciphertext: sealed.toString('base64'),
    senderLabel: input.senderLabel,
    itemCount: input.itemIds.length,
    expiresInHours: input.expiresInHours,
  });

  return { status: 'sent', code, itemCount: input.itemIds.length, expiresAt };
}

/** Reads the label without spending the single claim, so a receiver can decline knowingly. */
export async function previewSend(input: {
  config: ProjectConfig;
  code: string;
  api?: CloudApi;
}): Promise<SendPreview | null | 'not-connected' | 'not-logged-in'> {
  const pointer = cloudPointer(input.config);
  if (!pointer) return 'not-connected';
  const api = input.api ?? createCloudApi({ apiHost: pointer.apiHost });
  const credential = await ensureAccessToken({
    apiHost: pointer.apiHost,
    refresh: refreshToken => api.refresh(refreshToken),
  });
  if (!credential) return 'not-logged-in';
  return api.peekSend({ accessToken: credential.accessToken, mailboxId: deriveMailboxId(input.code) });
}

export async function receiveKnowledge(input: {
  projectRoot: string;
  config: ProjectConfig;
  code: string;
  api?: CloudApi;
}): Promise<ReceiveResult> {
  const pointer = cloudPointer(input.config);
  if (!pointer) return { status: 'not-connected' };

  const api = input.api ?? createCloudApi({ apiHost: pointer.apiHost });
  const credential = await ensureAccessToken({
    apiHost: pointer.apiHost,
    refresh: refreshToken => api.refresh(refreshToken),
  });
  if (!credential) return { status: 'not-logged-in' };

  const claimed = await api.claimSend({
    accessToken: credential.accessToken,
    mailboxId: deriveMailboxId(input.code),
  });
  if ('refused' in claimed) return { status: 'refused', reason: claimed.refused };

  // Unsealing throws on a wrong code, a truncated blob or a flipped bit, and that throw happens
  // BEFORE the database is opened. A bundle that cannot be authenticated must never reach
  // `importKnowledge`, because "decrypted to something" and "decrypted to the right thing" have
  // to be the same question when the answer is written into somebody's store.
  const plaintext = unseal(Buffer.from(claimed.ciphertext, 'base64'), input.code);

  const file = scratchFile('jsonl');
  await writeFile(file, plaintext);
  await initDb(input.projectRoot);
  try {
    const imported = await importKnowledge(file, { projectRoot: input.projectRoot });
    return { status: 'received', preview: claimed.preview, imported };
  } finally {
    await closeDb();
    await rm(file, { force: true }).catch(() => {});
  }
}
