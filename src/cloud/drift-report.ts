import { spawnSync } from 'node:child_process';
import type { ProjectConfig } from '../core/types.js';
import { closeDb, initDb } from '../store/database.js';
import { createCloudApi, type CloudApi } from './api-client.js';
import { publishedVersion } from './ledger.js';
import { checkPublishGate } from './publish-gate.js';
import { ensureAccessToken } from './token.js';
import { cloudPointer } from '../core/cloud-pointer.js';

type Target = {
  api: CloudApi;
  accessToken: string;
  workspaceId: string;
  /** The version the ledger holds for this atom. Null only if it was published without one. */
  remoteVersion: number | null;
  /** HEAD of the checkout the observation was made in. */
  commit: string;
};

const headOf = (projectRoot: string): string | null => {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim() || null;
};

/**
 * A report is a claim about the team's codebase, not about this working tree.
 *
 * Both verbs pass through here because both are wrong from the same two vantages: a branch
 * whose code nobody else has, and a checkout too far behind to tell "deleted" from "not pulled
 * yet". `reviewed` is if anything the stricter of the two -- it clears a flag someone else
 * raised.
 *
 * The ledger check comes FIRST, before the gate and before the token. An atom this machine
 * never published has no server-side counterpart, so a report about it is a report about
 * nothing -- and telling the user to go and pull, or to go and log in, in order to send it
 * would send them after a remedy that cannot help.
 */
async function gatedTarget(
  projectRoot: string,
  config: ProjectConfig,
  itemId: string,
  suppliedApi?: CloudApi,
): Promise<Target | 'not-connected' | 'not-published' | 'gated' | 'not-logged-in'> {
  const pointer = cloudPointer(config);
  if (!pointer) return 'not-connected';

  await initDb(projectRoot);
  let remoteVersion: number | null;
  let known: boolean;
  try {
    remoteVersion = await publishedVersion(itemId, pointer.workspaceId);
    known = remoteVersion !== null;
  } finally {
    await closeDb();
  }
  if (!known) return 'not-published';

  if (!checkPublishGate(projectRoot).ok) return 'gated';

  const commit = headOf(projectRoot);
  // Both verbs carry a commit -- one required by the contract, one that makes a bad report
  // traceable. A checkout whose HEAD cannot be read has already failed the gate above, so this
  // is belt and braces rather than a live path.
  if (!commit) return 'gated';

  const api = suppliedApi ?? createCloudApi({ apiHost: pointer.apiHost });
  const credential = await ensureAccessToken({
    apiHost: pointer.apiHost,
    refresh: refreshToken => api.refresh(refreshToken),
  });
  if (!credential) return 'not-logged-in';

  return {
    api,
    accessToken: credential.accessToken,
    workspaceId: pointer.workspaceId,
    remoteVersion,
    commit,
  };
}

/**
 * Tell the workspace an atom looks wrong.
 *
 * `needsReview` carries no `expectedVersion` and bumps none: a drift report is an observation
 * about an atom, not a revision of it, so a report is never dropped for having arrived while
 * somebody else was editing. It is also the one verb a reader may send -- the people who notice
 * a fact has rotted are usually the ones who cannot fix it -- which is why there is no role
 * check here.
 */
export async function reportDrift(input: {
  projectRoot: string;
  config: ProjectConfig;
  itemId: string;
  reason: string;
  api?: CloudApi;
}): Promise<'reported' | 'gated' | 'not-published' | 'not-connected' | 'not-logged-in'> {
  const target = await gatedTarget(input.projectRoot, input.config, input.itemId, input.api);
  if (typeof target === 'string') return target;

  await target.api.updateItem({
    workspaceId: target.workspaceId,
    accessToken: target.accessToken,
    itemId: input.itemId,
    body: { op: 'needsReview', reason: input.reason, observedAtCommit: target.commit },
  });
  return 'reported';
}

/**
 * Vouch for an atom's current content, and clear a review someone else raised.
 *
 * The deliberate undo of `needsReview`, and the only one -- a republish that says nothing about
 * freshness leaves an open flag standing. It takes `expectedVersion` precisely because it is a
 * positive claim about specific text, and vouching for text the caller did not read is the
 * failure this asymmetry exists to prevent. A conflict is therefore surfaced, never retried:
 * the content moved, so the review no longer describes what is there.
 */
export async function reportReviewed(input: {
  projectRoot: string;
  config: ProjectConfig;
  itemId: string;
  note?: string;
  api?: CloudApi;
}): Promise<'reviewed' | 'gated' | 'not-published' | 'not-connected' | 'not-logged-in' | 'conflict'> {
  const target = await gatedTarget(input.projectRoot, input.config, input.itemId, input.api);
  if (typeof target === 'string') return target;

  // `not-published` above already proved the ledger holds a version for this atom, so this is
  // unreachable -- but the contract requires a positive integer, and defaulting to 1 would be
  // inventing a claim about which text is being vouched for.
  if (target.remoteVersion === null) return 'not-published';

  const { outcome } = await target.api.updateItem({
    workspaceId: target.workspaceId,
    accessToken: target.accessToken,
    itemId: input.itemId,
    body: {
      op: 'reviewed',
      expectedVersion: target.remoteVersion,
      sourceCommit: target.commit,
      ...(input.note === undefined ? {} : { note: input.note }),
    },
  });

  return outcome?.status === 'conflict' ? 'conflict' : 'reviewed';
}
