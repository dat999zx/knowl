import type { ProjectConfig } from '../core/types.js';
import { filterExcluded } from './exclusions.js';
import { restageForPublish, stageForPublish } from './ledger.js';
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
