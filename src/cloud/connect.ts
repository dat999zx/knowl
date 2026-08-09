import { loadConfig, saveConfig } from '../core/config.js';
import { createCloudApi, type CloudApi, type CloudRole, type CloudWorkspace } from './api-client.js';
import { readCredential } from './credentials.js';
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

  const chosen = input.workspaceId
    ? workspaces.find(entry => entry.id === input.workspaceId)
    : workspaces.length === 1 ? workspaces[0] : undefined;

  // Guessing between several workspaces would silently publish a team's knowledge into
  // another team's store, which there is no unpublish for.
  if (!chosen) return { status: 'ambiguous', workspaces };

  const pointer: CloudPointer = {
    apiHost: input.apiHost,
    workspaceId: chosen.id,
    workspaceName: chosen.name,
    repo: identity.identity,
    remote: identity.remoteName,
  };

  const config = await loadConfig(input.projectRoot);
  await saveConfig(input.projectRoot, { ...config, cloud: pointer });

  return { status: 'connected', pointer, role: chosen.role };
}
