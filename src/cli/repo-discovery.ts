import fs from 'node:fs/promises';
import path from 'node:path';
import { isProjectRoot } from '../core/config.js';
import { readManifest } from '../workspace/manifest.js';
import { listKnownWorkspaces, workspaceManifestPath } from '../workspace/paths.js';
import { listKnownRepos, recordKnownRepo } from './repo-registry.js';

export type RepoSource = 'workspace' | 'registry' | 'scan';
export type DiscoveredRepo = { root: string; source: RepoSource };

export type DiscoverOptions = {
  /** Directories to walk for repositories that are in no manifest and not yet recorded. */
  roots?: string[];
  /** How deep a scan root is walked. Deep enough for `code/project/repo`, shallow enough to stay quick. */
  scanDepth?: number;
  /** Remember what a scan found. Off for a dry run, which must leave no trace. */
  record?: boolean;
};

const DEFAULT_SCAN_DEPTH = 3;
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', 'target']);

/**
 * Same marker the project walk uses, for the same reason: this list drives
 * `upgrade --all` and `doctor --fix`, which act on every repository in it. A bare `.knowl`
 * directory admitted the user's home directory to a sweep that snapshots and migrates.
 */
async function isKnowlRepo(root: string): Promise<boolean> {
  return isProjectRoot(root);
}

/**
 * A repository whose directory name begins with a dot is skipped.
 *
 * Knowl's own test suite leaves `.knowl-*` scratch repositories behind, and they are
 * indistinguishable from real ones by structure -- config, database, schema and all. A sweep
 * that visited them would snapshot and upgrade throwaway databases, and on this repository
 * that is dozens of directories. Dot-named project directories are rare enough that skipping
 * them costs less than the alternative.
 */
function isScratchDirectory(root: string): boolean {
  return path.basename(root).startsWith('.');
}

async function scanRoot(root: string, depth: number, found: string[]): Promise<void> {
  if (depth < 0) return;

  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return; // unreadable or gone: a scan root is a hint, not a promise
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    if (entry.name === '.knowl') continue;

    const child = path.join(root, entry.name);
    if (!isScratchDirectory(child) && await isKnowlRepo(child)) {
      found.push(child);
      // Not descending: Knowl repositories do not nest, and `workspace add` refuses to link
      // one inside another.
      continue;
    }
    await scanRoot(child, depth - 1, found);
  }
}

async function reposFromWorkspaces(): Promise<string[]> {
  const roots: string[] = [];

  for (const name of await listKnownWorkspaces()) {
    try {
      const manifest = await readManifest(workspaceManifestPath(name));
      for (const entry of manifest.repos) {
        if (entry.path) roots.push(path.resolve(entry.path));
      }
    } catch {
      // A manifest that cannot be read names no repositories; workspace doctor reports it.
    }
  }

  return roots;
}

/**
 * Every Knowl repository on this machine that a sweep should visit.
 *
 * Three sources, in order of confidence: workspace manifests, which are authoritative about
 * linked repositories; the known-repository registry, which covers everything else the CLI
 * has visited; and an explicit `--root` walk for repositories that predate the registry or
 * were cloned without one. What a walk finds is recorded, so `--root` is an argument you pass
 * once rather than every release.
 *
 * A manifest naming a checkout that is absent here is normal -- manifests move between
 * machines -- so missing paths are skipped rather than reported.
 */
export async function discoverRepos(options: DiscoverOptions): Promise<DiscoveredRepo[]> {
  const candidates: Array<{ root: string; source: RepoSource }> = [];

  for (const root of await reposFromWorkspaces()) candidates.push({ root, source: 'workspace' });
  for (const root of await listKnownRepos()) candidates.push({ root, source: 'registry' });

  const scanned: string[] = [];
  for (const root of options.roots ?? []) {
    await scanRoot(path.resolve(root), options.scanDepth ?? DEFAULT_SCAN_DEPTH, scanned);
  }
  for (const root of scanned) candidates.push({ root, source: 'scan' });

  const byRoot = new Map<string, DiscoveredRepo>();
  for (const candidate of candidates) {
    const root = path.resolve(candidate.root);
    if (byRoot.has(root)) continue;
    if (isScratchDirectory(root)) continue;
    if (!(await isKnowlRepo(root))) continue;
    byRoot.set(root, { root, source: candidate.source });
  }

  const discovered = [...byRoot.values()].sort((a, b) => a.root.localeCompare(b.root));

  // Remembered after the fact so a scan is needed once. Recording is best-effort by design,
  // so a read-only home directory degrades to "pass --root again" rather than failing.
  if (options.record !== false) {
    for (const repo of discovered) {
      if (repo.source === 'scan') await recordKnownRepo(repo.root);
    }
  }

  return discovered;
}
