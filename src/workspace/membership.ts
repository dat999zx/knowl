import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ProjectConfig } from '../core/types.js';
import { loadConfig, saveConfig } from '../core/config.js';
import { canonicalProjectRoot } from '../core/project-path.js';
import { assertNameAvailable, readManifest, writeManifest, WorkspaceManifest } from './manifest.js';
import { workspaceManifestPath } from './paths.js';

export type WorkspaceLink = { workspace: string; repo: string };

function contains(parent: string, child: string): boolean {
  const a = canonicalProjectRoot(parent);
  const b = canonicalProjectRoot(child);
  return b !== a && b.startsWith(`${a}${path.sep}`);
}

/**
 * `findProjectRoot` walks upward to the first `.knowl`, so a repo nested inside another
 * member silently resolves to the outer root -- wrong ownership, wrong session binding, and
 * nothing reports it. Rejecting the topology is cheaper than detecting its effects.
 */
export function assertNotNested(projectRoot: string, manifest: WorkspaceManifest): void {
  for (const repo of manifest.repos) {
    if (!repo.path) continue;
    if (contains(repo.path, projectRoot)) {
      throw new Error(`This repo is nested inside linked repo "${repo.name}". Link the outer repo instead.`);
    }
    if (contains(projectRoot, repo.path)) {
      throw new Error(`This repo contains linked repo "${repo.name}". Link the inner repos individually, or remove "${repo.name}" first.`);
    }
  }
}

/** A committed `.knowl/config.json` means the workspace pointer may have arrived with a clone. */
export function isConfigTrackedByGit(projectRoot: string): boolean {
  const result = spawnSync('git', ['ls-files', '--error-unmatch', '.knowl/config.json'], {
    cwd: projectRoot, stdio: 'ignore',
  });
  return result.status === 0;
}

/**
 * Both sides must agree. Either alone is not membership.
 *
 * This is what makes linkage un-forgeable by a cloned repository: `.knowl/` is gitignored so
 * a hostile repo normally cannot ship config at all, and even un-ignored and committed, the
 * manifest outside the repo does not list it -- so nothing is shared and nothing is read.
 */
export function isLinked(_projectRoot: string, manifest: WorkspaceManifest, config: ProjectConfig): boolean {
  const link = config.workspace;
  if (!link || link.workspace !== manifest.name) return false;
  return manifest.repos.some(repo => repo.name === link.repo);
}

export async function joinWorkspace(input: {
  projectRoot: string;
  workspaceName: string;
  repoName: string;
  force?: boolean;
}): Promise<WorkspaceManifest> {
  const manifestPath = workspaceManifestPath(input.workspaceName);
  const manifest = await readManifest(manifestPath);
  assertNameAvailable(manifest, input.repoName);
  assertNotNested(input.projectRoot, manifest);

  if (!input.force && isConfigTrackedByGit(input.projectRoot)) {
    throw new Error(
      '.knowl/config.json is tracked by git, so this workspace pointer may have arrived with a clone. Re-run with --force to link anyway.',
    );
  }

  const config = await loadConfig(input.projectRoot);

  manifest.repos.push({
    name: input.repoName,
    path: path.resolve(input.projectRoot),
    addedAt: new Date().toISOString(),
  });
  await writeManifest(manifestPath, manifest);
  await saveConfig(input.projectRoot, { ...config, workspace: { workspace: input.workspaceName, repo: input.repoName } });

  return manifest;
}

export async function leaveWorkspace(projectRoot: string): Promise<void> {
  const config = await loadConfig(projectRoot);
  const link = config.workspace;
  if (!link) return;

  try {
    const manifestPath = workspaceManifestPath(link.workspace);
    const manifest = await readManifest(manifestPath);
    manifest.repos = manifest.repos.filter(repo => repo.name !== link.repo);
    // The name stays retired even though the repo is gone: it is the ownership key on every
    // item that repo wrote, so letting a different repo claim it later would silently
    // transfer whatever it still owns.
    if (!manifest.retiredNames.includes(link.repo)) manifest.retiredNames.push(link.repo);
    await writeManifest(manifestPath, manifest);
  } catch {
    // An unreachable manifest must not strand the repo in a half-linked state; clearing the
    // local side still leaves it correctly unlinked.
  }

  const { workspace: _removed, ...rest } = config;
  await saveConfig(projectRoot, rest as ProjectConfig);
}
