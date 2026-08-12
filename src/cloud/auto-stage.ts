import { loadConfig } from '../core/config.js';
import { getProjectRoot } from '../store/database.js';
import type { ProjectConfig } from '../core/types.js';
import { filterExcluded } from './exclusions.js';
import { publishedVersion, restageForPublish, stageForPublish } from './ledger.js';
import { currentBranchOf } from './publish-gate.js';

/**
 * Queue an atom for the team, if this repo is connected and nothing says otherwise.
 *
 * Runs AFTER the item's own write has committed. A crash between the two leaves an atom that is
 * not staged, which `knowl cloud stage` repairs; staging first and crashing would leave a ledger
 * row pointing at an item that does not exist, which a push would send as a phantom.
 *
 * Never throws. The write that triggered this already succeeded and is durable, so reporting a
 * failure here would tell the caller to retry something that worked. `knowl doctor` reports the
 * drift instead -- the same trade `maybeAutoSync` makes, for the same reason.
 */
export async function maybeAutoStage(input: {
  projectRoot: string;
  config: ProjectConfig;
  itemId: string;
  namespace?: string;
  alreadyPublished: boolean;
}): Promise<void> {
  try {
    const pointer = input.config.cloud;
    if (!pointer) return;
    // Absent means on. Only an explicit false turns it off, so a repo connected before this
    // setting existed behaves like one connected after.
    if (pointer.autoStage === false) return;
    // Session knowledge is transient by construction and expires on its own.
    if (input.namespace === 'session') return;

    const allowed = await filterExcluded([input.itemId]);
    if (allowed.length === 0) return;

    // Swallowed the way `stagePublish` swallows it: the branch is what a later push quotes back,
    // not what it decides on, and failing to record an intent because git is unavailable would
    // refuse the one half of publishing that is safe from every vantage.
    let branch: string | null;
    try { branch = currentBranchOf(input.projectRoot); } catch { branch = null; }

    // A published atom takes the re-stage path deliberately: it is the only route a correction
    // has (`ba85bbbc98964d68`), and the plain path would treat the row as already handled.
    if (input.alreadyPublished) {
      await restageForPublish(allowed, pointer.workspaceId, branch);
    } else {
      await stageForPublish(allowed, pointer.workspaceId, branch);
    }
  } catch {
    // Deliberately swallowed. See the docblock.
  }
}

/**
 * The seam's entry point, for a caller that has just committed a write.
 *
 * Resolves the project root and config **itself** rather than being handed them. The three write
 * paths that own their transactions -- `storeKnowledgeItemDeduped`, `storeKnowledgeAtomsDeduped`
 * and `updateKnowledgeItemWithCommit` -- take neither, and threading both through them would mean
 * changing every caller of each, which is how a store layer acquires a dependency on project
 * configuration.
 *
 * `getProjectRoot()` reads the active database context, which is scoped-aware: a write performed
 * inside a `withDbPath` scope resolves that scope's root rather than the process-wide one, so a
 * replica write cannot stage against the wrong repository.
 *
 * `alreadyPublished` is asked here rather than by the caller, because only the ledger knows.
 *
 * Never throws, for the reason `maybeAutoStage` never throws.
 */
export async function autoStageAfterWrite(itemIds: string[], namespace?: string): Promise<void> {
  if (itemIds.length === 0) return;
  try {
    const projectRoot = getProjectRoot();
    const config = await loadConfig(projectRoot);
    if (!config.cloud) return;

    for (const itemId of itemIds) {
      const alreadyPublished = await publishedVersion(itemId, config.cloud.workspaceId) !== null;
      await maybeAutoStage({ projectRoot, config, itemId, namespace, alreadyPublished });
    }
  } catch {
    // Swallowed for the same reason. A committed write must not fail over its ledger row.
  }
}
