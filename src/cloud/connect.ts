import { loadConfig, saveConfig } from '../core/config.js';
import {
  createCloudApi, type CloudApi, type CloudRole, type CloudWorkspace, type WorkspaceProfile,
} from './api-client.js';
import { EMBED_RECIPE_VERSION } from '../core/embed-recipe.js';
import { resolveVectorProfile } from '../core/vector-profile.js';
import { ensureAccessToken } from './token.js';
import { getClient } from '../store/database.js';
import type { ProjectConfig } from '../core/types.js';
import { normalizeApiHost } from './credentials.js';
import { resolveRepoIdentity } from './repo-identity.js';

export type CloudPointer = {
  apiHost: string;
  workspaceId: string;
  workspaceName: string;
  repo: string;
  /** Absent when the identity did not come from a remote, matching how config stores it. */
  remote?: string;
};

export type ConnectInput = {
  projectRoot: string;
  apiHost: string;
  workspaceId?: string;
  remote?: string;
  /** Names the project outright: one with no remote, or one that wants a different label. */
  repo?: string;
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
  }
  | { status: 'identity-changed'; current: string; next: string };

/**
 * Point a project at a cloud workspace. Publishes nothing.
 *
 * Identity is resolved BEFORE the network call, so a project that cannot be named at all is
 * refused without spending a request or half-writing config. The pointer is written last, so a
 * failure anywhere leaves the project exactly as it was.
 */
export async function runConnect(input: ConnectInput): Promise<ConnectResult> {
  const identity = resolveRepoIdentity(input.projectRoot, {
    remote: input.remote,
    repo: input.repo,
  });

  /*
   * Re-connecting must not silently re-key what this project publishes under.
   *
   * Identity is DERIVED, so it can move without anyone deciding to move it: add a remote to a
   * project that had none and the answer goes from the folder name to the remote URL. Everything
   * already pushed stays filed under the old name, and the server refuses a write carrying a
   * different origin as `foreign_origin` -- so the next push half-fails on atoms this machine still
   * believes it owns, with an error about ownership rather than about renaming.
   *
   * Changing workspace is the ordinary reason to re-run connect and does not trip this, because the
   * identity does not change. `--repo <old-name>` is the way through when the rename is intended.
   */
  const existing = await loadConfig(input.projectRoot);
  if (existing.cloud?.repo && existing.cloud.repo !== identity.identity) {
    return { status: 'identity-changed', current: existing.cloud.repo, next: identity.identity };
  }

  const api = input.api ?? createCloudApi({ apiHost: input.apiHost });

  // Refreshed, not merely read. `readCredential` hands back whatever is stored, including an
  // access token that expired an hour ago -- and connect then sent it and reported "The
  // credential is not valid", which reads as "log in again" to someone who is signed in. Every
  // other network path (`pull`, `push`, `retract`, drift reporting) already goes through this.
  const credential = await ensureAccessToken({
    apiHost: input.apiHost,
    refresh: refreshToken => api.refresh(refreshToken),
  });
  if (!credential) return { status: 'not-logged-in' };

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
  //
  // A second read rather than reusing the copy taken for the identity check above: the network
  // calls between them are the slowest part of this function, and config is a file another
  // process can have written meanwhile.
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
    // Omitted rather than nulled when there is no remote, so the committed file carries no field
    // claiming the identity came from one.
    remote: identity.remoteName ?? undefined,
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
