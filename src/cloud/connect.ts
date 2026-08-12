import { loadConfig, saveConfig } from '../core/config.js';
import {
  createCloudApi, type CloudApi, type CloudRole, type CloudWorkspace, type WorkspaceProfile,
} from './api-client.js';
import { EMBED_RECIPE_VERSION } from '../core/embed-recipe.js';
import { resolveVectorProfile } from '../core/vector-profile.js';
import { getClient } from '../store/database.js';
import type { ProjectConfig } from '../core/types.js';
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
  | { status: 'ambiguous'; workspaces: CloudWorkspace[] }
  /**
   * This repository cannot produce vectors this workspace would accept.
   *
   * Refused BEFORE the pointer is written, deliberately. A repo pointed at a workspace it cannot
   * publish to is worse than one pointed nowhere: every later command looks connected and every
   * push fails.
   */
  | {
    status: 'profile-mismatch';
    workspace: WorkspaceProfile;
    repo: { provider: string; model: string; dtype: string; pooling: string; recipeVersion: number };
    differing: string[];
    itemCount: number;
  };

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

  // Before the pointer is written. Vectors are shared with the team, so a repo that embeds
  // differently would either be refused on every push or -- worse, if anything ever stopped
  // checking -- quietly poison the workspace's index.
  const config = await loadConfig(input.projectRoot);
  const mismatch = await profileMismatch(chosen.id, credential.accessToken, api, config);
  if (mismatch) return mismatch;

  const pointer: CloudPointer = {
    // Normalized, because unlike a credential key this value is written into a committed file
    // and read by every teammate who clones. `--api https://API.knowl.cloud/` would otherwise
    // travel verbatim while every lookup against it normalized, leaving config disagreeing
    // with itself about the name of the same deployment.
    apiHost: normalizeApiHost(input.apiHost),
    workspaceId: chosen.id,
    workspaceName: chosen.name,
    repo: identity.identity,
    remote: identity.remoteName,
  };

  await saveConfig(input.projectRoot, { ...config, cloud: pointer });

  return { status: 'connected', pointer, role: chosen.role };
}

/**
 * Compares this repository's embedding profile against the workspace's, or null when they match.
 *
 * All five fields, because four of them describe the model and the fifth describes the text fed
 * to it -- two clients on an identical model that build different text produce incomparable
 * vectors and differ in none of the first four.
 *
 * A server too old to serve the profile is treated as a match rather than a refusal: it cannot
 * be running the validation either, so refusing here would break connecting to it for a rule it
 * does not enforce.
 */
async function profileMismatch(
  workspaceId: string,
  accessToken: string,
  api: CloudApi,
  config: ProjectConfig,
): Promise<Extract<ConnectResult, { status: 'profile-mismatch' }> | null> {
  // Guarded rather than just caught: an api object without the method throws a TypeError
  // synchronously, before a `.catch` can attach. Reachable from a stub and from any caller
  // holding an older client object.
  if (typeof api.workspaceProfile !== 'function') return null;
  const workspace = await api.workspaceProfile({ workspaceId, accessToken }).catch(() => null);
  if (!workspace) return null;

  const profile = resolveVectorProfile(config);
  const repo = { ...profile, recipeVersion: EMBED_RECIPE_VERSION };

  const differing = (['provider', 'model', 'dtype', 'pooling', 'recipeVersion'] as const)
    .filter(field => workspace[field] !== repo[field]);
  if (differing.length === 0) return null;

  // Reported so the offer can price the switch: re-embedding is the cost the user is agreeing to.
  const counted = await countKnowledgeItems().catch(() => 0);
  return { status: 'profile-mismatch', workspace, repo, differing: [...differing], itemCount: counted };
}

async function countKnowledgeItems(): Promise<number> {
  const rows = await getClient().execute('SELECT COUNT(*) AS n FROM knowledge_items');
  return Number(rows.rows[0]?.n ?? 0);
}
