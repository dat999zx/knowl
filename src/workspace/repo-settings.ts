import { normalizeRepoEntry, readManifest, writeManifest, WorkspaceManifest, WorkspaceRepo } from './manifest.js';
import { workspaceManifestPath } from './paths.js';

/** The three fields `workspace set` and `workspace add` can write. */
export type RepoSettings = {
  role?: string;
  defaultVisibility?: 'workspace' | 'repo';
  kin?: string;
};

export function repoEntry(manifest: WorkspaceManifest, name: string): WorkspaceRepo | undefined {
  return manifest.repos.find(entry => entry.name === name);
}

/**
 * What new writes in this repo are stamped with.
 *
 * Absent means `'repo'`, which is what every manifest written before this feature says by
 * omission. A name that is in no entry is not a member of this workspace, and private is the
 * only safe answer for a caller whose membership cannot be confirmed.
 */
export function defaultVisibilityOf(manifest: WorkspaceManifest, name: string): 'repo' | 'workspace' {
  return repoEntry(manifest, name)?.defaultVisibility === 'workspace' ? 'workspace' : 'repo';
}

/**
 * Rewrite one repo's own entry.
 *
 * Only the entry named by `repoName` is touched, and only fields present in `settings`. That
 * is the same rule that governs promote, update and retire: a repo may publish, correct or
 * retire its own knowledge and nothing else's, and its manifest entry is the same kind of
 * property. An absent field is left alone, so setting one does not silently clear another;
 * an empty string clears, which is the only way to unset a field from the CLI.
 *
 * Values go through `normalizeRepoEntry` on the way in, so the cap on role and the charset
 * rule on kin are enforced once, at the boundary, rather than at each caller.
 */
export async function updateRepoSettings(input: {
  workspaceName: string;
  repoName: string;
  settings: RepoSettings;
}): Promise<WorkspaceRepo> {
  const manifestPath = workspaceManifestPath(input.workspaceName);
  const manifest = await readManifest(manifestPath);
  const current = repoEntry(manifest, input.repoName);
  if (!current) {
    throw new Error(
      `"${input.repoName}" is not a member of workspace "${input.workspaceName}", so this repo cannot edit its entry.`,
    );
  }

  const merged: Record<string, unknown> = { ...current };
  if (input.settings.role !== undefined) merged.role = input.settings.role;
  if (input.settings.kin !== undefined) merged.kin = input.settings.kin;
  if (input.settings.defaultVisibility !== undefined) {
    // Stored only when it is 'workspace'. Setting it back to 'repo' removes the key rather
    // than writing a value that means the same as absence.
    merged.defaultVisibility = input.settings.defaultVisibility === 'workspace' ? 'workspace' : undefined;
  }

  const updated = normalizeRepoEntry(merged);
  manifest.repos = manifest.repos.map(entry => (entry.name === input.repoName ? updated : entry));
  await writeManifest(manifestPath, manifest);
  return updated;
}
