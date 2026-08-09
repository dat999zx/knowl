import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '../core/types.js';
import { loadConfig } from '../core/config.js';
import { resolveStorage } from '../store/storage-roles.js';
import { embeddingIdentityFromConfig } from '../store/embedding-identity.js';
import { teamStorePath } from '../cloud/team-store.js';
import { createManifest, readManifest, WorkspaceManifest } from './manifest.js';
import { workspaceManifestPath } from './paths.js';
import { isLinked } from './membership.js';

export type PeerRepo = {
  name: string;
  root: string;
  databasePath: string;
  present: boolean;
  /** Recorded nature, carried through so callers need not re-read the manifest per peer. */
  role?: string;
  kin?: string;
  defaultVisibility?: 'workspace';
};
/**
 * The cloud replica, as a store rather than as a repo.
 *
 * It has no `root` because there is no checkout, and no single `name` because unlike a local
 * peer it holds rows owned by MANY repos -- every member's. Grouping therefore keys on each
 * row's own `originRepo`, not on one peer name. See `queryFederated`.
 */
export type CloudPeer = {
  workspaceId: string;
  workspaceName: string;
  databasePath: string;
  /** Connected but never pulled is ordinary, not an error. */
  present: boolean;
};

export type ActiveWorkspace = {
  name: string;
  repo: string;
  manifest: WorkspaceManifest;
  peers: PeerRepo[];
  cloud: CloudPeer | null;
};

/**
 * A manifest for a workspace that has no manifest file.
 *
 * A cloud-only repo is in no OSS workspace, but `ActiveWorkspace.manifest` is not optional and
 * `queryFederated` reads `manifest.repos` to decide which peers are kin. One entry naming this
 * repo yields no kin, which is the correct answer: a cloud workspace is a team, not a fork
 * lineage, and calling colleagues' repos kin would attach a divergence warning to every row.
 *
 * The embedding identity is this repo's own, and that is a statement of fact rather than a
 * convenience: `openTeamStore` embeds the replica under the project's config root, so the
 * replica genuinely does share this repo's vector space. Leaving it null would make
 * `workspaceDoctorChecks` compare null against a configured local identity and warn that the
 * two are invisible to each other -- advice to realign with a workspace that does not exist.
 */
function synthesizedManifest(workspaceId: string, repo: string, config: ProjectConfig): WorkspaceManifest {
  return {
    ...createManifest(workspaceId, embeddingIdentityFromConfig(config)),
    repos: [{ name: repo }],
  };
}

/**
 * The single entry point for "am I in a workspace, and who else is".
 *
 * Returns null for an unlinked repo -- every caller treats that as "behave exactly as
 * before", which is how the no-workspace guarantee stays cheap to hold.
 *
 * Peers are returned here and nowhere else. They are deliberately absent from
 * `configuredNamespaces`: because each repo's database holds only its own items, keeping
 * peers out of the namespace list is what makes every implicit read -- recent context,
 * pinned constraints, work-loop bootstrap, synthesis -- scoped for free. Federation is
 * reachable only through `queryFederated`.
 */
export async function resolveWorkspace(projectRoot: string, config?: ProjectConfig): Promise<ActiveWorkspace | null> {
  const effective = config ?? await loadConfig(projectRoot).catch(() => null);
  const link = effective?.workspace;
  const pointer = effective?.cloud;

  // Either reason is enough to be active, and neither implies the other: a repo can be linked
  // locally, connected to the cloud, both, or neither. Only "neither" keeps the null that
  // every caller reads as "behave exactly as before".
  if (!link && !pointer) return null;

  const cloud: CloudPeer | null = pointer
    ? {
      workspaceId: pointer.workspaceId,
      workspaceName: pointer.workspaceName ?? pointer.workspaceId,
      databasePath: teamStorePath(pointer.workspaceId),
      present: existsSync(teamStorePath(pointer.workspaceId)),
    }
    : null;

  if (!link) {
    // Cloud-only. The manifest is synthesized rather than absent so every existing consumer
    // keeps working unchanged -- `queryFederated` reads `manifest.repos` for kin, and a repo
    // that names only itself has no kin, which is the right answer for a cloud workspace.
    const repo = pointer!.repo;
    return {
      name: pointer!.workspaceName ?? pointer!.workspaceId,
      repo,
      manifest: synthesizedManifest(pointer!.workspaceId, repo, effective!),
      peers: [],
      cloud,
    };
  }

  let manifest: WorkspaceManifest;
  try {
    manifest = await readManifest(workspaceManifestPath(link.workspace));
  } catch {
    return null; // manifest gone or unreadable: degrade to single-repo behavior
  }
  if (!isLinked(projectRoot, manifest, effective!)) return null;

  const peers = manifest.repos
    .filter(repo => repo.name !== link.repo && repo.path)
    .map(repo => {
      const root = path.resolve(repo.path!);
      return {
        name: repo.name,
        root,
        databasePath: resolveStorage(root).knowledge,
        // A partial checkout is normal, not an error: two of five repos on a laptop works.
        present: existsSync(root),
        role: repo.role,
        kin: repo.kin,
        defaultVisibility: repo.defaultVisibility,
      };
    });

  return { name: manifest.name, repo: link.repo, manifest, peers, cloud };
}
