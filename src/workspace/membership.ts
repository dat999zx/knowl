import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ProjectConfig } from '../core/types.js';
import { loadConfig, saveConfig } from '../core/config.js';
import { canonicalProjectRoot } from '../core/project-path.js';
import { closeDb, getClient, initDb } from '../store/database.js';
import {
  embeddingIdentityFromConfig, formatEmbeddingIdentity, sameEmbeddingIdentity,
} from '../store/embedding-identity.js';
import type { EmbeddingIdentity } from '../store/embedding-identity.js';
import { assertNameAvailable, normalizeRepoEntry, readManifest, writeManifest, WorkspaceManifest } from './manifest.js';
import { workspaceManifestPath } from './paths.js';
import type { RepoSettings } from './repo-settings.js';

// Defined where readManifest lives so the migration cannot be bypassed by reading a
// manifest directly; re-exported here because membership is what acts on the result.
export { migrateLegacyManifestPooling } from './manifest.js';

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

/**
 * Refuse a repo whose vectors are not comparable with the workspace's.
 *
 * THIS IS A POLICY CHOICE, NOT AN INVISIBILITY CLAIM -- and it used to say otherwise. The
 * refusal was written when a mismatched peer really did return nothing: one fingerprint was
 * applied to every store, so the two sides were disjoint search spaces with no error to
 * explain it. #191 ended that. Each peer is embedded and scored under its own profile now, so
 * a mixed workspace searches correctly.
 *
 * What a second profile still costs is the shared semantic range. Same-profile repos produce
 * comparable cosines and share one min-max; a second model earns its own range and its own
 * relevance floor, which is more machinery and one more model resident per query. One profile
 * per workspace keeps the simple path, and that -- not invisibility -- is why this still
 * refuses. Absolute on purpose: `--force` covers the git-tracked-config check only, so there is
 * no escape hatch here to keep in sync. Deleting the refusal is a live option (#216) and would
 * be a policy change, not a bug fix.
 *
 * Shared by both routes in. `workspace add` enforced this from the start; `workspace join`
 * -- adopting a manifest copied off another machine -- did not, so a second machine could
 * link the same workspace under a different model and find out only through silence.
 */
export function assertEmbeddingCompatible(manifest: WorkspaceManifest, identity: EmbeddingIdentity | null): void {
  if (sameEmbeddingIdentity(manifest.embedding, identity)) return;
  throw new Error(
    `This repo embeds with ${formatEmbeddingIdentity(identity)} but workspace "${manifest.name}" uses ` +
    `${formatEmbeddingIdentity(manifest.embedding)}. A workspace holds one embedding profile so that ` +
    'every repo shares one semantic range; a second profile is searchable but costs that. Align this ' +
    'repo\'s search.vector config first, unless it publishes to a cloud workspace -- that profile is ' +
    'fixed by the server and must not be changed to satisfy this.',
  );
}

/**
 * Every check that must pass before a repo is written into a workspace, in one place so the
 * two entry points cannot drift apart. Name availability is deliberately not here: `add`
 * claims a new name, while `join` adopts one the manifest already lists.
 */
export function assertSafeToLink(input: {
  projectRoot: string;
  manifest: WorkspaceManifest;
  config: ProjectConfig;
  force?: boolean;
}): void {
  assertNotNested(input.projectRoot, input.manifest);
  if (!input.force && isConfigTrackedByGit(input.projectRoot)) {
    throw new Error(
      '.knowl/config.json is tracked by git, so this workspace pointer may have arrived with a clone. Re-run with --force to link anyway.',
    );
  }
  assertEmbeddingCompatible(input.manifest, embeddingIdentityFromConfig(input.config));
}

export async function joinWorkspace(input: {
  projectRoot: string;
  workspaceName: string;
  repoName: string;
  force?: boolean;
  /** What this repo is, and whether its writes are shared. Absent leaves every field unset. */
  settings?: RepoSettings;
}): Promise<WorkspaceManifest> {
  const manifestPath = workspaceManifestPath(input.workspaceName);
  const manifest = await readManifest(manifestPath);

  // A retired name is normally gone for good, because handing it to a different repo would
  // silently transfer ownership of everything the old one wrote. Items in *this* repo's
  // database owned by that name are proof it is the same repo coming back, which is the one
  // case where reuse transfers nothing. Only consulted when the name is actually retired.
  const reclaiming = manifest.retiredNames.includes(input.repoName)
    && (await countOwnedItems(input.projectRoot, input.repoName)) > 0;
  assertNameAvailable(manifest, input.repoName, { allowRetired: reclaiming });

  const config = await loadConfig(input.projectRoot);
  // The first repo defines the workspace's embedding identity; every later one must match.
  if (manifest.repos.length === 0) manifest.embedding = embeddingIdentityFromConfig(config);
  // Checked before anything is written, so a refusal leaves no half-joined state.
  assertSafeToLink({ projectRoot: input.projectRoot, manifest, config, force: input.force });

  if (reclaiming) manifest.retiredNames = manifest.retiredNames.filter(name => name !== input.repoName);

  // Normalized on the way in, so the cap on role and the charset rule on kin are enforced at
  // the one boundary rather than trusted from the caller.
  manifest.repos.push(normalizeRepoEntry({
    name: input.repoName,
    path: path.resolve(input.projectRoot),
    addedAt: new Date().toISOString(),
    role: input.settings?.role,
    kin: input.settings?.kin,
    defaultVisibility: input.settings?.defaultVisibility,
  }));
  await writeManifest(manifestPath, manifest);
  await saveConfig(input.projectRoot, { ...config, workspace: { workspace: input.workspaceName, repo: input.repoName } });
  await backfillOriginRepo(input.projectRoot, input.repoName);

  return manifest;
}

/**
 * Claim every unowned item for the joining repo.
 *
 * `origin_repo` is nullable, and an unowned item is unfilterable, unlabelled and outside
 * every ownership rule. Joining is the one moment when the answer is unambiguous: everything
 * already in this database was written by this repo.
 *
 * Ownership only. Visibility stays 'repo' -- claiming is not publishing, and sharing existing
 * knowledge is an explicit `knowl workspace promote`. Rows that already carry an owner are
 * left alone, since overwriting one would be a silent ownership transfer.
 */
export async function backfillOriginRepo(projectRoot: string, repoName: string): Promise<number> {
  await initDb(projectRoot);
  try {
    const result = await getClient().execute({
      sql: 'UPDATE knowledge_items SET origin_repo = ? WHERE origin_repo IS NULL',
      args: [repoName],
    });
    return Number(result.rowsAffected ?? 0);
  } finally {
    await closeDb();
  }
}

/**
 * How many active items in this repo's database it still owns.
 *
 * `remove` refuses while this is non-zero. A repo name is the ownership key on every item
 * that repo wrote, so removing it without deciding what happens to those items orphans
 * them -- they stay in the database, owned by a name nothing resolves.
 */
export async function countOwnedItems(projectRoot: string, repoName: string): Promise<number> {
  await initDb(projectRoot);
  try {
    const rows = await getClient().execute({
      sql: "SELECT COUNT(*) AS n FROM knowledge_items WHERE origin_repo = ? AND status = 'active'",
      args: [repoName],
    });
    return Number(rows.rows[0]?.n ?? 0);
  } finally {
    await closeDb();
  }
}

/**
 * Unlink, reporting whether the name was retired.
 *
 * A name is retired because it is the ownership key on the items its repo wrote: give it to
 * another repo and that repo silently inherits the authorship. That reasoning only holds
 * while there are items. A repo that owns nothing -- linked by mistake, or unlinked before
 * recording anything -- attached its name to no knowledge at all, so burning the name buys
 * no safety and costs the obvious name forever.
 */
export async function leaveWorkspace(projectRoot: string): Promise<{ retired: boolean }> {
  const config = await loadConfig(projectRoot);
  const link = config.workspace;
  if (!link) return { retired: false };

  let retired = false;
  try {
    // Unreadable database means unknown ownership, and the safe answer to unknown is to
    // retire: an unusable name is recoverable, a silent ownership transfer is not.
    const owned = await countOwnedItems(projectRoot, link.repo).catch(() => 1);
    const manifestPath = workspaceManifestPath(link.workspace);
    const manifest = await readManifest(manifestPath);
    manifest.repos = manifest.repos.filter(repo => repo.name !== link.repo);
    if (owned > 0 && !manifest.retiredNames.includes(link.repo)) {
      manifest.retiredNames.push(link.repo);
      retired = true;
    }
    await writeManifest(manifestPath, manifest);
  } catch {
    // An unreachable manifest must not strand the repo in a half-linked state; clearing the
    // local side still leaves it correctly unlinked.
  }

  const { workspace: _removed, ...rest } = config;
  await saveConfig(projectRoot, rest as ProjectConfig);
  return { retired };
}
