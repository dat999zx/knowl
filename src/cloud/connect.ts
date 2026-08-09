import { loadConfig, saveConfig } from '../core/config.js';
import { createCloudApi, type CloudApi, type CloudRole, type CloudWorkspace } from './api-client.js';
import { normalizeApiHost, readCredential } from './credentials.js';
import { resolveRepoIdentity } from './repo-identity.js';

export type CloudPointer = {
  apiHost: string;
  workspaceId: string;
  workspaceName: string;
  repo: string;
  remote: string;
};

export type ConnectInput = {
  projectRoot: string;
  apiHost: string;
  workspaceId?: string;
  remote?: string;
  api?: CloudApi;
};

export type ConnectResult =
  | { status: 'connected'; pointer: CloudPointer; role: CloudRole }
  | { status: 'not-logged-in' }
  | { status: 'no-workspaces' }
  | { status: 'unknown-workspace'; workspaceId: string; workspaces: CloudWorkspace[] }
  | { status: 'ambiguous'; workspaces: CloudWorkspace[] };

/**
 * Point a repository at a cloud workspace. Publishes nothing.
 *
 * Identity is resolved BEFORE the network call, so a repository with no remote is refused
 * without spending a request or half-writing config. The pointer is written last, so a
 * failure anywhere leaves the repo exactly as it was.
 */
export async function runConnect(input: ConnectInput): Promise<ConnectResult> {
  const identity = resolveRepoIdentity(input.projectRoot, { remote: input.remote });

  const credential = await readCredential(input.apiHost);
  if (!credential) return { status: 'not-logged-in' };

  const api = input.api ?? createCloudApi({ apiHost: input.apiHost });
  const workspaces = await api.listWorkspaces(credential.accessToken);

  // Belonging to none is a different situation from belonging to several, and the remedies
  // have nothing in common: ask for an invitation versus name which one you meant. Folding
  // them together would tell someone with no workspaces to pick one from an empty list.
  if (workspaces.length === 0) return { status: 'no-workspaces' };

  // A named id that matches nothing is its own answer, not ambiguity. Folding it in told a
  // user who had just typed `--workspace` to re-run with `--workspace`, and said "you belong
  // to more than one workspace" to someone who belongs to exactly one -- the same collapse
  // that `no-workspaces` was split out to avoid.
  let chosen: CloudWorkspace | undefined;
  if (input.workspaceId) {
    chosen = workspaces.find(entry => entry.id === input.workspaceId);
    if (!chosen) return { status: 'unknown-workspace', workspaceId: input.workspaceId, workspaces };
  } else if (workspaces.length === 1) {
    chosen = workspaces[0];
  }

  // Guessing between several workspaces would silently publish a team's knowledge into
  // another team's store, which there is no unpublish for.
  if (!chosen) return { status: 'ambiguous', workspaces };

  const pointer: CloudPointer = {
    // Normalized, because unlike a credential key this value is written into a committed file
    // and read by every teammate who clones. `--api https://API.knowl.dev/` would otherwise
    // travel verbatim while every lookup against it normalized, leaving config disagreeing
    // with itself about the name of the same deployment.
    apiHost: normalizeApiHost(input.apiHost),
    workspaceId: chosen.id,
    workspaceName: chosen.name,
    repo: identity.identity,
    remote: identity.remoteName,
  };

  const config = await loadConfig(input.projectRoot);
  await saveConfig(input.projectRoot, { ...config, cloud: pointer });

  return { status: 'connected', pointer, role: chosen.role };
}
