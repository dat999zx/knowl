import type { ProjectConfig } from '../core/types.js';
import { closeDb, initDb } from '../store/database.js';
import { createCloudApi, type CloudApi } from './api-client.js';
import { publishedVersion, recordRetracted } from './ledger.js';
import { readSyncState } from './sync-state.js';
import { withTeamStore } from './team-store.js';
import { ensureAccessToken } from './token.js';
import { cloudPointer } from '../core/cloud-pointer.js';

export type RetractResult =
  | { status: 'retracted' }
  | { status: 'not-connected' }
  | { status: 'not-published' }
  | { status: 'not-logged-in' }
  | { status: 'forbidden'; role: string }
  | { status: 'conflict'; currentVersion: number };

/**
 * Take a published atom back out of the workspace.
 *
 * The server hard-deletes the row and writes a tombstone in one transaction, then refuses every
 * later publish of that id. Teammates lose it on their next sync, because the feed carries the
 * deletion as a row of its own. This is the only path that removes something from the team, and
 * it cannot be undone from either side.
 *
 * **Deliberately NOT behind the publish gate, and that is the whole point of the command.**
 * `checkPublishGate` exists because publishing from a feature branch asserts something about code
 * only you have, which is false for everyone else. Removal is the opposite act: it is true from
 * every vantage, and the case that brings someone here is a leaked name or a secret sitting in a
 * shared workspace right now. Answering that with "switch to the default branch and pull first"
 * would hold the leak open for the length of a rebase. Staging is ungated for the mirror-image
 * reason -- an intent is safe to record from anywhere -- and this is safe to *send* from anywhere.
 *
 * The ledger check still comes first: an atom this machine never pushed has no server-side row,
 * so there is nothing to retract and sending the user to log in could not help.
 *
 * `expectedVersion` comes from the ledger rather than from a fetch. It is what this machine last
 * put there, so a mismatch means someone edited the atom after this machine published it -- and
 * deleting an edit you never read is exactly what the version is for. That surfaces as `conflict`
 * and is never retried: re-reading is the caller's job, and a retry loop here would delete the
 * correction on the second pass.
 */
export async function retractItem(input: {
  projectRoot: string;
  config: ProjectConfig;
  itemId: string;
  reason: string;
  api?: CloudApi;
}): Promise<RetractResult> {
  const pointer = cloudPointer(input.config);
  if (!pointer) return { status: 'not-connected' };

  await initDb(input.projectRoot);
  try {
    const remoteVersion = await publishedVersion(input.itemId, pointer.workspaceId);
    // Null covers both "never staged" and "staged but never pushed". Neither has a server-side
    // row, and a retraction for one would be a request about nothing.
    if (remoteVersion === null) return { status: 'not-published' };

    // The same cheap local refusal `pushStaged` makes: the role rides on every sync response, so
    // a reader is refused without a round trip that could only end in 403. A replica with no role
    // recorded is unknown rather than denied, and the server decides.
    const role = await withTeamStore(pointer.workspaceId, input.projectRoot, () => readSyncState())
      .then(state => state?.role ?? null)
      .catch(() => null);
    if (role === 'reader') return { status: 'forbidden', role };

    const api = input.api ?? createCloudApi({ apiHost: pointer.apiHost });
    const credential = await ensureAccessToken({
      apiHost: pointer.apiHost,
      refresh: refreshToken => api.refresh(refreshToken),
    });
    if (!credential) return { status: 'not-logged-in' };

    const { outcome } = await api.updateItem({
      workspaceId: pointer.workspaceId,
      accessToken: credential.accessToken,
      itemId: input.itemId,
      body: { op: 'delete', expectedVersion: remoteVersion, reason: input.reason },
    });

    // A missing atom and a moved one both come back as `conflict` (the server sends
    // `currentVersion: 0` for the first), and both mean the same thing here: re-read before
    // writing. The ledger is left alone, so `knowl cloud status` keeps saying this machine
    // published it -- which is still true.
    if (outcome?.status === 'conflict') {
      return { status: 'conflict', currentVersion: outcome.currentVersion };
    }

    // Only a confirmed removal updates the ledger. Anything else leaves the local record matching
    // what is actually on the server.
    await recordRetracted(input.itemId, pointer.workspaceId);
    return { status: 'retracted' };
  } finally {
    await closeDb();
  }
}
