import type { ProjectConfig } from '../core/types.js';
import type { DoctorCheck } from '../cli/doctor-report.js';
import { readCredential } from './credentials.js';

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

  return [{
    status: 'OK',
    message:
      `Cloud: ${pointer.repo} → ${pointer.workspaceName ?? pointer.workspaceId} ` +
      `(${pointer.apiHost}${fresh ? '' : ', access token will refresh on next use'})`,
  }];
}
