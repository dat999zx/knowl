import type { KnowledgeCategory, ProjectConfig } from '../core/types.js';
import { closeDb, initDb } from '../store/database.js';
import { selectOwnedItems, type PromoteTarget } from '../workspace/promote.js';
import { stageForPublish } from './ledger.js';
import { currentBranchOf } from './publish-gate.js';

export type StageResult =
  | { status: 'not-connected' }
  | { status: 'staged'; items: PromoteTarget[]; applied: boolean; skippedForeign: number };

/**
 * Record the intent to publish. Sends nothing.
 *
 * Staging is deliberately ungated: an intent can be formed on any branch at any time, and
 * refusing to record one would mean a developer has to remember it themselves until the merge
 * lands. The branch is stored beside it so the push can explain what it is waiting for.
 *
 * `visibility` is not touched, at all. Publication state lives in the ledger (decision
 * `ee191dd7db024bec`), and `repo`/`workspace` keep meaning exactly what they meant: who may read
 * this item on this machine.
 *
 * `initDb`/`closeDb` are correct **here** and only here: this runs from a CLI command, which owns
 * its process. Constraint `defde27f6f234535` forbids them from anything reachable by an MCP tool
 * call, and nothing in this module is.
 */
export async function stagePublish(input: {
  projectRoot: string;
  config: ProjectConfig;
  ids?: string[];
  categories?: KnowledgeCategory[];
  apply?: boolean;
}): Promise<StageResult> {
  const pointer = input.config.cloud;
  if (!pointer) return { status: 'not-connected' };

  await initDb(input.projectRoot);
  try {
    const { items, skippedForeign } = await selectOwnedItems({
      repoName: pointer.repo,
      categories: input.categories,
      ids: input.ids,
    });

    if (input.apply && items.length > 0) {
      // Swallowed on purpose, and only here. The branch is what the push's refusal quotes back,
      // not what it decides on -- `checkPublishGate` re-reads git itself and reports being
      // unable to run it as its own verdict. Failing to record an intent because git is missing
      // would refuse the one half of publishing that is safe from every vantage.
      let branch: string | null = null;
      try { branch = currentBranchOf(input.projectRoot); } catch { branch = null; }
      await stageForPublish(items.map(item => item.id), pointer.workspaceId, branch);
    }

    return { status: 'staged', items, applied: Boolean(input.apply) && items.length > 0, skippedForeign };
  } finally {
    await closeDb();
  }
}
