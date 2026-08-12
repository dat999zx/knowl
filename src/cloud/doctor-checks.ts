import type { ProjectConfig } from '../core/types.js';
import type { DoctorCheck } from '../cli/doctor-report.js';
import { withDbPath } from '../store/database.js';
import { resolveStorage } from '../store/storage-roles.js';
import { readCredential } from './credentials.js';
import { listStaged } from './ledger.js';
import { checkPublishGate } from './publish-gate.js';
import { readSyncState } from './sync-state.js';
import { withTeamStore } from './team-store.js';

/**
 * Cloud status, without touching the network.
 *
 * Doctor runs on every `knowl doctor` and is expected to be fast and to work offline, so a
 * reachability probe belongs behind an explicit flag rather than here. This reports only what
 * the local filesystem already knows.
 *
 * Silent when the repo has no cloud pointer: Knowl is local-first, and a repository that never
 * opted in must not be advertised to about the cloud on every run.
 */
export async function cloudDoctorChecks(
  config: ProjectConfig,
  projectRoot: string,
  now: () => number = Date.now,
): Promise<DoctorCheck[]> {
  const pointer = config.cloud;
  if (!pointer) return [];

  const credential = await readCredential(pointer.apiHost);
  if (!credential) {
    return [{
      status: 'WARN',
      message: `Connected to ${pointer.workspaceName ?? pointer.workspaceId}, but not signed in`,
      fix: `Run knowl cloud login --api ${pointer.apiHost}`,
    }];
  }

  // An expired ACCESS token is the ordinary state between refreshes -- the refresh token
  // recovers it silently. Reporting it would make doctor cry wolf an hour after every login.
  const expiresAt = Date.parse(credential.expiresAt);
  const fresh = !Number.isNaN(expiresAt) && expiresAt > now();

  // Opening the replica is the only filesystem work here and it stays offline, so doctor keeps
  // its promise to be fast and work without a network. A replica that cannot be opened at all
  // reads as "never synced" rather than failing the whole report.
  const state = await withTeamStore(pointer.workspaceId, projectRoot, () => readSyncState())
    .catch(() => null);

  // Never synced is WARN, not FAIL: the repo is correctly configured and one command away
  // from working. A failed LAST sync is also WARN and names the reason, because the replica
  // is still readable -- just older than the caller may assume.
  if (!state?.lastSyncedAt) {
    return [{
      status: 'WARN',
      message: `Cloud: ${pointer.repo} → ${pointer.workspaceName ?? pointer.workspaceId} (never synced)`,
      fix: 'Run knowl cloud pull',
    }];
  }

  return [
    {
      status: state.lastError ? 'WARN' : 'OK',
      message:
        `Cloud: ${pointer.repo} → ${pointer.workspaceName ?? pointer.workspaceId} ` +
        `(${pointer.apiHost}${fresh ? '' : ', access token will refresh on next use'}` +
        `, synced ${state.lastSyncedAt}${state.lastError ? `, last attempt failed: ${state.lastError}` : ''})`,
      ...(state.lastError ? { fix: 'Run knowl cloud pull' } : {}),
    },
    ...await stagedCheck(pointer.workspaceId, projectRoot),
  ];
}

/**
 * Staged work that the gate is currently refusing to send.
 *
 * A developer who staged on a feature branch and moved on has no other prompt -- the atoms are
 * in a table nobody reads, and the push they were waiting for is a command they have to
 * remember to run. Reported through doctor because doctor is a command they already run.
 *
 * Silent when nothing is staged, and silent when the gate would pass: a WARN that fires on the
 * happy path is furniture, and the one time it matters nobody reads it.
 */
async function stagedCheck(workspaceId: string, projectRoot: string): Promise<DoctorCheck[]> {
  const staged = await withDbPath(resolveStorage(projectRoot).knowledge, () => listStaged(workspaceId))
    .catch(() => []);
  if (staged.length === 0) return [];

  const verdict = checkPublishGate(projectRoot);
  if (verdict.ok) return [];

  return [{
    status: 'WARN',
    message: `Cloud: ${staged.length} item(s) staged but not sent. ${verdict.detail}`,
    fix: 'Run knowl cloud status',
  }];
}
