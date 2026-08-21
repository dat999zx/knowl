import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, upgradeConfigDefaults } from '../core/config.js';
import type { ProjectConfig } from '../core/types.js';
import { installKnowlProjectGuidance, KnowlProjectGuidanceInstallResult } from '../core/agents-guidance.js';
import { installKnowlGitignoreEntry } from '../core/gitignore.js';
import { closeDb, initDb } from '../store/database.js';
import * as repo from '../store/repository.js';
import { runStoreRetention, type ModelCacheRetention, type RetentionReport } from '../store/retention.js';
import { resolveVectorProfile } from '../core/vector-profile.js';
import { backfillOriginRepo } from '../workspace/membership.js';
import { resolveWorkspace } from '../workspace/resolve.js';
import { knowlHome } from '../core/paths.js';
import { listKnownRepos, recordKnownRepo } from '../core/repo-registry.js';

export type UpgradeResult = {
  project: Awaited<ReturnType<typeof repo.createProject>>;
  configStatus: Awaited<ReturnType<typeof upgradeConfigDefaults>>;
  guidanceStatus: KnowlProjectGuidanceInstallResult;
  gitignoreStatus: Awaited<ReturnType<typeof installKnowlGitignoreEntry>>;
  /** Previously unowned items claimed for this repo; always 0 outside a workspace. */
  claimedItems: number;
  /** What retention removed. Reported so a repository never shrinks without saying so. */
  retention: RetentionReport;
};

/**
 * Every model any repository on this machine names, for the cache prune.
 *
 * Machine-wide because the cache is: one repo's upgrade must not remove weights another
 * repo's config depends on, and the running `serve` that would notice is not this process.
 * The current repository is included by its caller even when the registry has not caught up.
 *
 * Best-effort per repository, but the *set* is fail-closed: an empty result prunes nothing
 * (see `pruneModelCache`), so a registry that cannot be read costs disk rather than weights.
 */
async function modelsNamedOnThisMachine(projectRoot: string, config: ProjectConfig): Promise<string[]> {
  const named = new Set<string>([resolveVectorProfile(config).model]);

  for (const root of await listKnownRepos()) {
    if (path.resolve(root) === path.resolve(projectRoot)) continue;
    try {
      named.add(resolveVectorProfile(await loadConfig(root)).model);
    } catch {
      // A repository whose config will not load names nothing we can act on. It also cannot
      // be pruned *for*, which is why the horizon in pruneModelCache exists as a second guard.
    }
  }

  return [...named];
}

/**
 * Bring an existing repository up to the current release: config defaults, schema, guidance
 * files, `.gitignore`, and the skills directory.
 *
 * Lives here rather than in the CLI entry point because it is the one piece of `knowl
 * upgrade` with behavior worth testing directly; the entry point keeps only the printing.
 */
export async function upgradeExistingRepository(projectRoot: string, fallbackName: string): Promise<UpgradeResult> {
  // Recorded on every upgrade rather than only on the first: a registry file can be deleted
  // or predate this, and re-recording an already-known repo is a no-op.
  await recordKnownRepo(projectRoot);

  const configStatus = await upgradeConfigDefaults(projectRoot);
  const config = await loadConfig(projectRoot);
  const guidanceStatus = await installKnowlProjectGuidance(projectRoot);
  const gitignoreStatus = await installKnowlGitignoreEntry(projectRoot);
  await fs.mkdir(path.join(projectRoot, '.knowl', 'skills'), { recursive: true });

  await initDb(projectRoot);
  let project = await repo.getProjectByRootPath(projectRoot);
  if (!project) {
    project = await repo.createProject(projectRoot, fallbackName);
  }
  // Retention runs here because this is the command that already visits every repository on
  // the machine -- the same habit that grew `.knowl/snapshots` to 1.12 GB now pays for it.
  // Best-effort inside: housekeeping must never be why an upgrade fails.
  //
  // `src/ai/embeddings.ts` owns where the model cache *is*; this only says which two
  // directories retention may move things between, in one expression so a change there has
  // one obvious place to meet.
  const modelCache: ModelCacheRetention = {
    legacyDir: path.join(projectRoot, '.knowl', 'models'),
    sharedDir: path.join(knowlHome(), 'models'),
    keepModels: await modelsNamedOnThisMachine(projectRoot, config),
  };
  const retention = await runStoreRetention(projectRoot, modelCache);
  await closeDb();

  // The join-time backfill runs exactly once, so items written between joining a workspace
  // and the release that started stamping ownership at write time stayed unowned, and nothing
  // revisited them. An unowned item is not counted by `countOwnedItems`, which is the guard
  // that stops `workspace remove` from orphaning knowledge -- so the repo can be unlinked as
  // if it held nothing. Upgrade is the right moment to sweep them: it is the command that
  // already exists to carry a repo across releases.
  //
  // Same claim rule as the join backfill, and safe for the same reason: it only touches NULL,
  // never reassigns an existing owner, and this database is this repo's, so nothing else
  // could have written those rows. Outside a workspace NULL is the correct value and this is
  // skipped entirely.
  const workspace = await resolveWorkspace(projectRoot, config);
  const claimedItems = workspace ? await backfillOriginRepo(projectRoot, workspace.repo) : 0;

  return {
    project,
    configStatus,
    guidanceStatus,
    gitignoreStatus,
    claimedItems,
    retention,
  };
}
