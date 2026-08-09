import type { ProjectConfig } from '../core/types.js';
import { closeDb, initDb } from '../store/database.js';
import { listStaged } from './ledger.js';
import { checkPublishGate, type GateVerdict } from './publish-gate.js';
import { readSyncState } from './sync-state.js';
import { withTeamStore } from './team-store.js';

export type CloudStatus =
  | { connected: false }
  | {
      connected: true;
      workspace: string;
      role: string | null;
      lastSyncedAt: string | null;
      lastError: string | null;
      staged: number;
      /** The branch the staged atoms were staged on, when they all agree. */
      stagedOnBranch: string | null;
      gate: GateVerdict;
    };

/**
 * Everything the local filesystem already knows, and nothing else.
 *
 * No network call, deliberately, and pinned by a test. This is the command a developer runs to
 * find out why a push has not happened, and it must work on a plane, offline, and instantly --
 * every fact it reports is already on this disk.
 */
export async function cloudStatus(projectRoot: string, config: ProjectConfig): Promise<CloudStatus> {
  const pointer = config.cloud;
  if (!pointer) return { connected: false };

  await initDb(projectRoot);
  let staged;
  try {
    staged = await listStaged(pointer.workspaceId);
  } finally {
    await closeDb();
  }

  // A replica that cannot be opened at all reads as "never synced" rather than failing the
  // whole report -- the same choice `cloudDoctorChecks` makes, for the same reason.
  const state = await withTeamStore(pointer.workspaceId, projectRoot, () => readSyncState())
    .catch(() => null);

  const branches = new Set(staged.map(row => row.stagedOnBranch));

  return {
    connected: true,
    workspace: pointer.workspaceName ?? pointer.workspaceId,
    role: state?.role ?? null,
    lastSyncedAt: state?.lastSyncedAt ?? null,
    lastError: state?.lastError ?? null,
    staged: staged.length,
    // Named only when every staged atom agrees. Two branches make "waiting on X" a false
    // statement about the others, and the gate's own detail already names the branch the
    // checkout is on, which is the one that actually decides.
    stagedOnBranch: branches.size === 1 ? [...branches][0] : null,
    gate: checkPublishGate(projectRoot),
  };
}

export function formatCloudStatus(status: CloudStatus): string {
  if (!status.connected) {
    return 'Not connected to a cloud workspace. Run knowl cloud connect.';
  }

  const lines = [
    `Workspace: ${status.workspace}${status.role ? ` (you are ${status.role})` : ''}`,
    status.lastSyncedAt
      ? `Replica:   synced ${status.lastSyncedAt}${status.lastError ? `, last attempt failed: ${status.lastError}` : ''}`
      : 'Replica:   never synced. Run knowl cloud pull.',
  ];

  if (status.staged === 0) {
    lines.push('Staged:    nothing.');
    return lines.join('\n');
  }

  lines.push(
    `Staged:    ${status.staged} staged${status.stagedOnBranch ? ` on ${status.stagedOnBranch}` : ''}, not yet sent.`,
  );
  // What is holding it, named. A developer who staged on a branch and moved on has no other
  // prompt: the atoms sit in a table nobody reads, and a status line that reported the count
  // without the reason would leave them there.
  lines.push(status.gate.ok
    ? '           Ready to send. Run knowl cloud push.'
    : `           ${status.gate.detail}`);
  // Only while something is staged, so the warning still means something when it appears. The
  // server has a retire verb and no client path wires it, so a confirmation that omits this is
  // a confirmation that misleads.
  lines.push('           Publishing cannot be undone from here yet.');

  return lines.join('\n');
}
