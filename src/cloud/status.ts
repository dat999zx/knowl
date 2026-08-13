import type { ProjectConfig } from '../core/types.js';
import { closeDb, initDb } from '../store/database.js';
import { AUTO_SYNC_INTERVAL_MS } from './auto-sync.js';
import { listCredentialHosts, normalizeApiHost, readCredential } from './credentials.js';
import { defaultApiHost } from './login.js';
import { listStaged } from './ledger.js';
import { checkPublishGate, type GateVerdict } from './publish-gate.js';
import { readSyncState } from './sync-state.js';
import { withTeamStore } from './team-store.js';
import { cloudPointer } from '../core/cloud-pointer.js';

/** Who the stored credential belongs to, cached at login. Null when 4.x wrote it. */
export type StatusIdentity = { email: string; displayName: string } | null;

export type CloudStatus =
  | {
      connected: false;
      /**
       * Which host the auth half of this report is about.
       *
       * A disconnected repo has no `config.cloud` and so no host, while credentials are keyed by
       * one -- so this resolves it the way `login` and `logout` already do rather than guessing.
       * Without it, "I ran knowl cloud login and status still says nothing" is unanswerable in
       * exactly the situation where the user most needs an answer.
       */
      apiHost: string;
      signedIn: boolean;
      identity: StatusIdentity;
      /** Credentials stored for hosts other than `apiHost`. Named, never silently chosen between. */
      otherCredentialHosts: number;
    }
  | {
      connected: true;
      workspace: string;
      role: string | null;
      lastSyncedAt: string | null;
      lastError: string | null;
      staged: number;
      /** Never pushed from this machine. */
      stagedNew: number;
      /** Pushed before, staged again: an update to something the team already has. */
      stagedCorrections: number;
      /** The branch the staged atoms were staged on, when they all agree. */
      stagedOnBranch: string | null;
      gate: GateVerdict;
      signedIn: boolean;
      identity: StatusIdentity;
      tokenExpiresAt: string | null;
      /** When the background pull will next be due. Never null: absent means due now. */
      nextSyncDueAt: string | null;
    };

/**
 * Everything the local filesystem already knows, and nothing else.
 *
 * No network call, deliberately, and pinned by a test. This is the command a developer runs to
 * find out why a push has not happened, and it must work on a plane, offline, and instantly --
 * every fact it reports is already on this disk.
 */
export async function cloudStatus(projectRoot: string, config: ProjectConfig): Promise<CloudStatus> {
  const pointer = cloudPointer(config);
  if (!pointer) return await composeDisconnected();

  await initDb(projectRoot);
  let staged;
  try {
    staged = await listStaged(pointer.workspaceId);
  } finally {
    await closeDb();
  }

  return composeStatus(pointer, projectRoot, staged);
}

/**
 * The same report, for a caller that already holds a database context -- an MCP request.
 *
 * `cloudStatus` above owns the process-wide context and must never be reached from one: its
 * `closeDb` would leave every LATER tool call in that server with no database, surfacing in a
 * different request from the one that caused it. See constraint `defde27f6f234535`.
 */
export async function cloudStatusInRequest(projectRoot: string, config: ProjectConfig): Promise<CloudStatus> {
  const pointer = cloudPointer(config);
  if (!pointer) return await composeDisconnected();

  // The caller's context answers this; nothing is opened and nothing is closed.
  return composeStatus(pointer, projectRoot, await listStaged(pointer.workspaceId));
}

/**
 * The auth half of the report for a repo with no cloud pointer.
 *
 * Reads only the credential file, so it stays as offline as the connected path.
 */
async function composeDisconnected(): Promise<CloudStatus> {
  const apiHost = normalizeApiHost(defaultApiHost());
  const credential = await readCredential(apiHost).catch(() => null);
  const hosts = await listCredentialHosts().catch(() => [] as string[]);

  return {
    connected: false,
    apiHost,
    signedIn: Boolean(credential),
    identity: credential?.identity ?? null,
    otherCredentialHosts: hosts.filter(host => host !== apiHost).length,
  };
}

async function composeStatus(
  pointer: NonNullable<ProjectConfig['cloud']>,
  projectRoot: string,
  staged: Awaited<ReturnType<typeof listStaged>>,
): Promise<CloudStatus> {
  // A replica that cannot be opened at all reads as "never synced" rather than failing the
  // whole report -- the same choice `cloudDoctorChecks` makes, for the same reason.
  const state = await withTeamStore(pointer.workspaceId, projectRoot, () => readSyncState())
    .catch(() => null);

  const branches = new Set(staged.map(row => row.stagedOnBranch));

  // Read, never fetched. The MCP path calls this and is forbidden from touching the network.
  const credential = await readCredential(pointer.apiHost).catch(() => null);

  // A staged row that already carries a server version has been pushed before, so this is an
  // update to something the team already has. Plan A's `stage_state` is what made that
  // distinguishable: before it, a pushed-then-restaged row looked identical to a fresh one.
  const corrections = staged.filter(row => row.remoteVersion !== null).length;

  const lastSynced = state?.lastSyncedAt ? Date.parse(state.lastSyncedAt) : null;

  return {
    connected: true,
    workspace: pointer.workspaceName ?? pointer.workspaceId,
    role: state?.role ?? null,
    lastSyncedAt: state?.lastSyncedAt ?? null,
    lastError: state?.lastError ?? null,
    staged: staged.length,
    stagedNew: staged.length - corrections,
    stagedCorrections: corrections,
    signedIn: Boolean(credential),
    identity: credential?.identity ?? null,
    tokenExpiresAt: credential?.expiresAt ?? null,
    // Null or unparseable last-sync means due now rather than unknown, matching `shouldAutoSync`,
    // which treats both as due for the same reason: "I cannot tell" must never read as "no need",
    // or a replica silently stops syncing forever.
    nextSyncDueAt: lastSynced === null || Number.isNaN(lastSynced)
      ? new Date().toISOString()
      : new Date(lastSynced + AUTO_SYNC_INTERVAL_MS).toISOString(),
    // Named only when every staged atom agrees. Two branches make "waiting on X" a false
    // statement about the others, and the gate's own detail already names the branch the
    // checkout is on, which is the one that actually decides.
    stagedOnBranch: branches.size === 1 ? [...branches][0] : null,
    gate: checkPublishGate(projectRoot),
  };
}

/** "Signed in: ..." — the one line both the connected and disconnected reports share. */
function signedInLine(status: CloudStatus): string {
  if (!status.signedIn) return 'Signed in: no. Run knowl cloud login.';
  return status.identity
    ? `Signed in: ${status.identity.displayName} <${status.identity.email}>`
    // A credential written before 5.0 cached one. Saying so beats inventing a name, and beats
    // fetching one on a path that must stay offline.
    : 'Signed in: yes, identity unknown — run knowl cloud login to record it.';
}

export function formatCloudStatus(status: CloudStatus): string {
  if (!status.connected) {
    const lines = [
      signedInLine(status),
      `Host:      ${status.apiHost}`,
      'Not connected to a cloud workspace. Run knowl cloud connect.',
    ];
    if (status.otherCredentialHosts > 0) {
      lines.push(`           Signed in to ${status.otherCredentialHosts} other host(s). Use --api to reach one.`);
    }
    return lines.join('\n');
  }

  const lines = [
    signedInLine(status),
    `Workspace: ${status.workspace}${status.role ? ` (you are ${status.role})` : ''}`,
    status.lastSyncedAt
      ? `Replica:   synced ${status.lastSyncedAt}${status.lastError ? `, last attempt failed: ${status.lastError}` : ''}`
      : 'Replica:   never synced. Run knowl cloud pull.',
  ];

  if (status.staged === 0) {
    lines.push('Staged:    nothing.');
    return lines.join('\n');
  }

  // The split is named because the two carry different risk: a new atom adds something, a
  // correction overwrites something the team is already reading.
  lines.push(
    `Staged:    ${status.staged} staged` +
    ` (${status.stagedNew} new, ${status.stagedCorrections} correction(s))` +
    `${status.stagedOnBranch ? ` on ${status.stagedOnBranch}` : ''}, not yet sent.`,
  );
  // What is holding it, named. A developer who staged on a branch and moved on has no other
  // prompt: the atoms sit in a table nobody reads, and a status line that reported the count
  // without the reason would leave them there.
  lines.push(status.gate.ok
    ? '           Ready to send. Run knowl cloud push.'
    : `           ${status.gate.detail}`);
  // Only while something is staged, so the warning still means something when it appears. It no
  // longer says publishing cannot be undone -- `knowl cloud retract` wires the server's delete
  // verb -- but undoing is a hard delete plus a tombstone that bars the id forever, which is a
  // different thing from a mistake being cheap.
  lines.push('           Sending is irreversible: knowl cloud retract removes an atom for good.');

  return lines.join('\n');
}
