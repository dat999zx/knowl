import { ProjectConfig, CommitChange, EvidenceInput, KnowledgeItem, KnowledgeStatus } from '../core/types.js';
import * as repo from './repository.js';
import { crossRepoOverlapForWrite, findLikelyDuplicateKnowledgeItem, heldPayloadFor, resolveDuplicate } from './knowledge-writer.js';
import type { CrossRepoOverlap } from '../workspace/cross-repo-overlap.js';
import { hasAiConfigured } from '../core/config.js';
import { getCurrentGitCommit } from './drift.js';
import { KnowledgeWriteValidationOptions } from '../core/types.js';
import { attachEvidenceToKnowledge } from './evidence-repository.js';
import { indexKnowledgeItemsBestEffort } from './write-embedding.js';

/**
 * Queue a committed write for the team, if this repo is connected.
 *
 * Deferred for the same reason the AI import below is: `cloud` sits above `store` in the layer
 * rule (`tests/architecture/module-boundaries.test.ts`), so a static edge here would be upward
 * and forbidden. This is optional behaviour that does nothing in a repo with no cloud pointer.
 */
async function stageWrittenItems(itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) return;
  try {
    const { autoStageAfterWrite } = await import('../cloud/auto-stage.js');
    await autoStageAfterWrite(itemIds);
  } catch { /* the write already committed; a ledger row must not fail it */ }
}

export type DirectDecisionInput = {
  title: string;
  content: string;
  reasoning?: string | null;
  alternatives?: string[] | null;
  tags?: string[] | null;
  evidence?: EvidenceInput[];
  /** Explicitly mark this active item id superseded by the new decision. */
  supersedes?: string;
};

export type DirectDecisionResult = {
  /** 'duplicate' means nothing was written because the decision was already held verbatim. */
  action: 'inserted' | 'duplicate';
  item: KnowledgeItem;
  /** The active decision this one retired, when it replaced one. */
  superseded?: KnowledgeItem;
  /** An overlapping active decision deliberately left active beside this one. */
  nearDuplicate?: KnowledgeItem;
  /**
   * Overlaps with linked repos. Advisory: those decisions belong to another repo and cannot be
   * retired from here.
   */
  crossRepo?: CrossRepoOverlap[];
};

export async function recordDecisionDirect(
  projectId: string,
  input: DirectDecisionInput,
  commitMessage = `Record decision: ${input.title}`,
  config?: ProjectConfig
): Promise<DirectDecisionResult> {
  const existing = await findLikelyDuplicateKnowledgeItem(projectId, {
    category: 'decision',
    title: input.title,
    content: input.content,
    reasoning: input.reasoning,
    tags: input.tags,
  });

  // Reconciled by the same rule as every other write path. This used to retire any
  // fuzzy match unconditionally, which silently clobbered decisions that merely shared
  // vocabulary with the new one.
  //
  // The held payload is what lets `resolveDuplicate` compare evidence and skill steps at all:
  // omit it and those two fields are not compared, so a decision arriving with new evidence
  // read as "already held verbatim" and was dropped -- with the evidence being the only thing
  // the write was for. Every other write path already passes it.
  const resolution = existing
    ? resolveDuplicate({ category: 'decision', ...input }, existing, await heldPayloadFor(input, existing))
    : null;
  if (existing && resolution === 'no-op' && !input.supersedes) {
    return { action: 'duplicate', item: existing };
  }

  const item = await repo.createKnowledgeItem(projectId, {
    category: 'decision',
    title: input.title,
    content: input.content,
    reasoning: input.reasoning,
    alternatives: input.alternatives,
    tags: input.tags,
  }, undefined, undefined, config?.security);
  await attachEvidenceToKnowledge(item.id, input.evidence);

  let superseded: KnowledgeItem | null = resolution === 'supersede' ? existing : null;
  if (!superseded && input.supersedes) {
    const explicit = await repo.getKnowledgeItem(input.supersedes);
    if (explicit && explicit.status === 'active') superseded = explicit;
  }

  const changes: CommitChange[] = [];
  if (superseded && superseded.id !== item.id) {
    await repo.updateKnowledgeItem(superseded.id, {
      status: 'superseded',
      supersededById: item.id,
    });
    changes.push({ itemId: superseded.id, action: 'supersede', before: superseded });
  }
  changes.push({ itemId: item.id, action: 'insert', after: item });

  await repo.createKnowledgeCommit(projectId, commitMessage, changes);
  await indexKnowledgeItemsBestEffort(projectId, [item]);

  if (config && hasAiConfigured(config)) {
    try {
      // Both imports are deferred. `runDeriveTruth` already was, because derivation is
      // optional and its dependency tree is large; `initAI` sat statically beside it and was
      // the one edge that made `store` depend on `ai` while `ai` depends on `store`. Loading
      // it here instead costs nothing — this branch only runs when AI is configured, and it
      // is already inside a best-effort try.
      const [{ initAI }, { runDeriveTruth }] = await Promise.all([
        import('../ai/provider.js'),
        import('../pipeline/derive.js'),
      ]);
      initAI(config.ai!);
      await runDeriveTruth(projectId, [item]);
    } catch {
      // Best-effort
    }
  }

  // The fourth seam site, confirmed by reading rather than assumed: this path writes through
  // `repo.createKnowledgeItem` with `dbConnection` undefined, so each write commits on its own
  // and there is no enclosing transaction to be inside. Without this, `knowl decide` and the
  // `knowl_decide` tool would be the one write that silently never staged.
  await stageWrittenItems([item.id]);

  return {
    action: 'inserted',
    item,
    superseded: superseded || undefined,
    nearDuplicate: resolution === 'coexist' && existing ? existing : undefined,
    // This path writes through the repository rather than through knowledge-writer, so the
    // overlap check has to be requested explicitly. Omitting it left the cross-repo advisory
    // off for every decision, from both the CLI and the knowl_decide tool.
    crossRepo: await crossRepoOverlapForWrite({ category: 'decision', ...input }),
  };
}

export async function updateKnowledgeItemWithCommit(
  projectId: string,
  id: string,
  updates: {
    title?: string;
    content?: string;
    status?: KnowledgeStatus;
    reasoning?: string;
    source?: string | null;
    sourceCommit?: string | null;
    affectedPaths?: string[] | null;
    /** The replacement, when this update is a retirement. See `supersedeKnowledgeItemWithCommit`. */
    supersededById?: string | null;
  },
  options?: {
    projectRoot?: string | null;
    sourceCommit?: string | null;
    freshness?: 'fresh' | 'stale' | 'needs_review';
    validationOptions?: KnowledgeWriteValidationOptions;
    /** Overrides the default `Update item: <title>`, so a retirement does not read as an edit. */
    commitMessage?: string;
  }
): Promise<KnowledgeItem> {
  const beforeItem = await repo.getKnowledgeItem(id);
  if (!beforeItem) {
    throw new Error(`Knowledge item not found with ID ${id}`);
  }

  const shouldRefreshFreshness = updates.title !== undefined ||
    updates.content !== undefined ||
    updates.reasoning !== undefined ||
    updates.source !== undefined ||
    updates.sourceCommit !== undefined ||
    updates.affectedPaths !== undefined;
  const autoSourceCommit = shouldRefreshFreshness
    ? getCurrentGitCommit(options?.projectRoot || process.cwd()) ?? undefined
    : undefined;
  const resolvedSourceCommit = updates.sourceCommit !== undefined
    ? updates.sourceCommit
    : (options?.sourceCommit !== undefined ? options.sourceCommit
    : autoSourceCommit);

  const updated = await repo.updateKnowledgeItem(id, {
    ...updates,
    ...(resolvedSourceCommit !== undefined ? { sourceCommit: resolvedSourceCommit } : {}),
    ...(shouldRefreshFreshness || options?.freshness ? { freshness: options?.freshness || 'fresh' } : {}),
  }, undefined, undefined, options?.validationOptions);
  let action: CommitChange['action'] = 'update';
  if (updates.status && updates.status !== beforeItem.status) {
    if (updates.status === 'active') {
      action = 'restore';
    } else if (updates.status === 'archived') {
      action = 'archive';
    } else if (updates.status === 'deprecated') {
      action = 'deprecate';
    } else if (updates.status === 'rejected') {
      action = 'reject';
    } else if (updates.status === 'superseded') {
      action = 'supersede';
    }
  }

  await repo.createKnowledgeCommit(projectId, options?.commitMessage ?? `Update item: ${updated.title}`, [
    {
      itemId: id,
      action,
      before: beforeItem,
      after: updated,
    },
  ]);

  // Demotion to deprecated/rejected says "this was wrong", which implicates the batch
  // that produced it — unlike a supersede, which as often means "this is outdated" and
  // must not flag siblings on every routine state refresh.
  if ((updates.status === 'deprecated' || updates.status === 'rejected') && beforeItem.status === 'active') {
    const { flagCorrectionSiblingsBestEffort } = await import('./blast-radius.js');
    await flagCorrectionSiblingsBestEffort(projectId, id, `"${beforeItem.title}" (${updates.status})`);
  }

  // Re-embed when the embedded text changed. Every insert path already does this; update did
  // not, and the FTS row is refreshed by trigger, so the two indexes silently disagreed: the
  // stored vector still described the OLD wording. Semantic score outweighs the lexical term
  // by more than an order of magnitude, so a corrected item stayed retrievable for the claim
  // it no longer makes and was effectively invisible for the one it now makes -- until
  // somebody happened to run `knowl reindex --vectors`. Correcting a fact in place is the
  // workflow the guidance asks for over storing a duplicate, which is exactly why it has to
  // leave retrieval consistent.
  if (updates.title !== undefined || updates.content !== undefined || updates.reasoning !== undefined) {
    await indexKnowledgeItemsBestEffort(projectId, [updated]);
  }

  // `repo.updateKnowledgeItem` above is called with no `dbConnection`, so it committed on its
  // own connection before this line -- this is genuinely post-commit rather than merely late.
  //
  // A published atom re-stages here, which is how a correction reaches the team at all: an atom
  // edited in place would otherwise stay at the version the workspace already holds.
  await stageWrittenItems([id]);

  return updated;
}

/**
 * Retire `id` in favour of `supersededById`, AND record it.
 *
 * The whole point is the second half. `repo.supersedeKnowledgeItem` writes the item row and
 * nothing else — it is the bare update, so it never reaches `createKnowledgeCommit`. That was
 * survivable-looking because the row it writes is correct: retrieval honours the retirement,
 * queries stop returning the retired atom, and nothing about asking questions looks wrong.
 *
 * What it lost is everything that reads the change LOG rather than the row:
 *
 * - the workspace change notice (`loadForeignChanges`), so a teammate was never told the atom
 *   was retired and went on reading it as current
 * - blast radius, which uses `knowledge_commit_items` to decide what to re-check when
 *   something turns out to be wrong
 * - `mcp_call_commits` attribution, which decides whose write a change was
 *
 * The store path (`storeKnowledgeItemDeduped` with `supersedes:`) always recorded both halves
 * in one commit. This closes the gap for the other three callers rather than at each of them:
 * `knowl_update --supersedeId`, the CLI supersede command, and duplicate repair in
 * `integrity.ts` all routed through the same bare function.
 *
 * Note it also stages the retired item, because `updateKnowledgeItemWithCommit` does — which is
 * the same fix in the sync dimension: a published atom that was retired has to reach the team
 * as retired, or they keep the version that is still active on their side.
 */
export async function supersedeKnowledgeItemWithCommit(
  projectId: string,
  id: string,
  supersededById: string,
): Promise<KnowledgeItem> {
  const item = await repo.getKnowledgeItem(id);
  return updateKnowledgeItemWithCommit(
    projectId,
    id,
    { status: 'superseded', supersededById },
    { commitMessage: `Supersede item: ${item?.title ?? id}` },
  );
}
