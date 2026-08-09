import type { ProjectConfig } from '../core/types.js';
import type { DoctorCheck } from '../cli/doctor-report.js';
import { readCredential } from './credentials.js';
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
      fix: `Run knowl login --api ${pointer.apiHost}`,
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

  return [{
    status: state.lastError ? 'WARN' : 'OK',
    message:
      `Cloud: ${pointer.repo} → ${pointer.workspaceName ?? pointer.workspaceId} ` +
      `(${pointer.apiHost}${fresh ? '' : ', access token will refresh on next use'}` +
      `, synced ${state.lastSyncedAt}${state.lastError ? `, last attempt failed: ${state.lastError}` : ''})`,
    ...(state.lastError ? { fix: 'Run knowl cloud pull' } : {}),
  }];
}
