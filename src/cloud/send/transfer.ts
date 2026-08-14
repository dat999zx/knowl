import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProjectConfig } from '../../core/types.js';
import { closeDb, initDb } from '../../store/database.js';
import { exportKnowledge, importKnowledge } from '../../store/portability.js';
import {
  createCloudApi,
  type CloudApi, type SendMailbox, type SendPreview, type SendRefusal,
} from '../api-client.js';
import { cloudPointer } from '../../core/cloud-pointer.js';
import { ensureAccessToken } from '../token.js';
import {
  CODE_WORDS, CURRENT_DERIVATION, DERIVATION_VERSIONS,
  deriveSecrets, generateCode, type DerivationVersion,
} from './code.js';
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
  | { status: 'refused'; reason: SendRefusal; message?: string }
  | { status: 'sent'; code: string; itemCount: number; expiresAt: string };

export type ReceiveResult =
  | { status: 'not-connected' }
  | { status: 'not-logged-in' }
  | { status: 'refused'; reason: SendRefusal; message?: string }
  | { status: 'received'; preview: SendPreview; imported: Awaited<ReturnType<typeof importKnowledge>> };

/**
 * A bundle located, with everything needed to open it and nothing derived twice.
 *
 * Argon2id at 64 MiB costs 0.6-1.4s a call, so `knowl cloud receive` re-deriving between the peek
 * and the claim would pay for it four times over -- peek v2, peek v1, claim v2, claim v1 -- where
 * one will do. Threaded explicitly rather than memoised in a module-level cache: a process-
 * lifetime map keyed by code, holding sealing keys, is a worse artefact than a parameter.
 */
export type ResolvedSend = {
  preview: SendPreview;
  mailboxId: string;
  key: Buffer;
  version: DerivationVersion;
};

/**
 * What to tell the human, for a reason this build knows — and the server's own words for one it
 * does not.
 *
 * The fallback is the point. knowl-cloud's `reason` enum grows independently of this client, and
 * before this existed an unrecognised value fell through a lookup to `undefined` and the CLI
 * printed the `not_found` line: a sender at their in-flight quota was told the bundle they had
 * just minted did not exist. Showing the server's `message` is worse writing than a line tuned
 * here and infinitely better than a confident wrong answer.
 */
export function refusalMessage(reason: SendRefusal, message?: string): string {
  const known: Record<string, string> = {
    not_found: 'No bundle waiting on that code. Check what you typed, or ask for a re-send.',
    expired: 'That bundle expired. Ask for a new one.',
    already_claimed: 'That bundle was already collected. Ask for a new one.',
    conflict: 'That code collided with one already in flight. Run the send again for a fresh code.',
    rate_limited: 'You have too many bundles in flight. Wait for one to be collected or to expire.',
  };
  return known[reason] ?? message ?? `The server refused that: ${reason}.`;
}

/** A temp path that cannot collide with a concurrent send in the same process or another one. */
const scratchFile = (suffix: string) => path.join(tmpdir(), `knowl-send-${randomUUID()}.${suffix}`);

/** Everything a cloud verb needs before it can make a call, or the reason it cannot. */
async function connect(
  config: ProjectConfig,
  api?: CloudApi,
): Promise<{ api: CloudApi; accessToken: string } | 'not-connected' | 'not-logged-in'> {
  const pointer = cloudPointer(config);
  if (!pointer) return 'not-connected';
  const resolved = api ?? createCloudApi({ apiHost: pointer.apiHost });
  const credential = await ensureAccessToken({
    apiHost: pointer.apiHost,
    refresh: refreshToken => resolved.refresh(refreshToken),
  });
  if (!credential) return 'not-logged-in';
  return { api: resolved, accessToken: credential.accessToken };
}

export async function sendKnowledge(input: {
  projectRoot: string;
  projectId: string;
  config: ProjectConfig;
  itemIds: readonly string[];
  senderLabel: string;
  expiresInHours: number;
  words?: number;
  api?: CloudApi;
}): Promise<SendResult> {
  if (input.itemIds.length === 0) return { status: 'nothing-selected' };
  const session = await connect(input.config, input.api);
  if (typeof session === 'string') return { status: session };

  // The code exists only in this function and in whatever the human pastes into chat. It is never
  // written to disk, never logged, and never sent — the server receives an id derived from it
  // through a memory-hard KDF under a different label, which cannot be walked back to the key.
  const code = generateCode(input.words ?? CODE_WORDS);
  const { mailboxId, key } = deriveSecrets(code, CURRENT_DERIVATION);
  const file = scratchFile('jsonl');

  await initDb(input.projectRoot);
  let sealed: Buffer;
  try {
    await exportKnowledge(input.projectId, file, input.projectRoot, input.itemIds);
    sealed = seal(await readFile(file), key, CURRENT_DERIVATION);
  } finally {
    await closeDb();
    // The plaintext export is the one artefact worth cleaning up even on failure: it is the
    // bundle unsealed, sitting in a world-readable temp directory.
    await rm(file, { force: true }).catch(() => {});
  }

  const created = await session.api.createSend({
    accessToken: session.accessToken,
    mailboxId,
    ciphertext: sealed.toString('base64'),
    senderLabel: input.senderLabel,
    itemCount: input.itemIds.length,
    expiresInHours: input.expiresInHours,
  });
  if ('refused' in created) {
    return { status: 'refused', reason: created.refused, message: created.message };
  }

  return { status: 'sent', code, itemCount: input.itemIds.length, expiresAt: created.expiresAt };
}

/**
 * Finds the bundle, and learns which derivation addressed it, without spending the single claim.
 *
 * **The id is the lookup key, so the derivation has to be chosen before anything can be read.**
 * Nothing inside a bundle can say which one, because the bundle is only reachable once the id is
 * known — so the walk is the compatibility mechanism, not a fallback bolted on beside one. Newest
 * first: a v2 bundle costs one round trip, a v1 bundle or a mistyped code two.
 *
 * A v1 bundle stays claimable for as long as any 5.1.0 install is still sending, which outlives
 * the 72-hour ceiling on a mailbox by however long that install goes un-upgraded.
 */
export async function previewSend(input: {
  config: ProjectConfig;
  code: string;
  api?: CloudApi;
}): Promise<ResolvedSend | null | 'not-connected' | 'not-logged-in'> {
  const session = await connect(input.config, input.api);
  if (typeof session === 'string') return session;

  for (const version of DERIVATION_VERSIONS) {
    const { mailboxId, key } = deriveSecrets(input.code, version);
    const preview = await session.api.peekSend({ accessToken: session.accessToken, mailboxId });
    if (preview) return { preview, mailboxId, key, version };
  }
  return null;
}

export async function receiveKnowledge(input: {
  projectRoot: string;
  config: ProjectConfig;
  resolved: ResolvedSend;
  api?: CloudApi;
}): Promise<ReceiveResult> {
  const session = await connect(input.config, input.api);
  if (typeof session === 'string') return { status: session };

  const claimed = await session.api.claimSend({
    accessToken: session.accessToken,
    mailboxId: input.resolved.mailboxId,
  });
  if ('refused' in claimed) {
    return { status: 'refused', reason: claimed.refused, message: claimed.message };
  }

  // Unsealing throws on a wrong code, a truncated blob or a flipped bit, and that throw happens
  // BEFORE the database is opened. A bundle that cannot be authenticated must never reach
  // `importKnowledge`, because "decrypted to something" and "decrypted to the right thing" have
  // to be the same question when the answer is written into somebody's store.
  const plaintext = unseal(
    Buffer.from(claimed.ciphertext, 'base64'),
    input.resolved.key,
    input.resolved.version,
  );

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

/**
 * The caller's own in-flight bundles.
 *
 * Read this as a detection surface first: a bundle nobody was ever given, showing `claimedAt`, is
 * how a leaked or guessed code announces itself. The ids are opaque to the sender — codes are
 * never stored, which is deliberate and stays that way — so this answers "was anything taken",
 * not "which one of mine was it".
 */
export async function listSends(input: {
  config: ProjectConfig;
  api?: CloudApi;
}): Promise<SendMailbox[] | 'not-connected' | 'not-logged-in'> {
  const session = await connect(input.config, input.api);
  if (typeof session === 'string') return session;
  return session.api.listSends(session.accessToken);
}

/**
 * Destroys a bundle before anyone collects it, addressed by a mailbox id or by the code itself.
 *
 * A code goes through the same v2-then-v1 walk a receiver uses, because a sender revoking one they
 * minted on an older client has a v1 id whether they know it or not. A raw id is tried as given
 * and nothing is derived — that is the path for an id copied out of `--list`, where no code exists
 * to derive from.
 */
export async function revokeSend(input: {
  config: ProjectConfig;
  target: string;
  api?: CloudApi;
}): Promise<boolean | 'not-connected' | 'not-logged-in'> {
  const session = await connect(input.config, input.api);
  if (typeof session === 'string') return session;

  const candidates = /^[a-f0-9]{32}$|^[a-f0-9]{64}$/.test(input.target.trim().toLowerCase())
    ? [input.target.trim().toLowerCase()]
    : DERIVATION_VERSIONS.map(version => deriveSecrets(input.target, version).mailboxId);

  for (const mailboxId of candidates) {
    if (await session.api.revokeSend({ accessToken: session.accessToken, mailboxId })) return true;
  }
  return false;
}
