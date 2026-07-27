import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '../core/types.js';
import { loadConfig } from '../core/config.js';
import { resolveStorage } from '../store/storage-roles.js';
import { readManifest, WorkspaceManifest } from './manifest.js';
import { workspaceManifestPath } from './paths.js';
import { isLinked } from './membership.js';

export type PeerRepo = { name: string; root: string; databasePath: string; present: boolean };
export type ActiveWorkspace = { name: string; repo: string; manifest: WorkspaceManifest; peers: PeerRepo[] };

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
  if (!link) return null;

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
      };
    });

  return { name: manifest.name, repo: link.repo, manifest, peers };
}
