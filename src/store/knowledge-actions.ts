import { ProjectConfig, CommitChange, EvidenceInput, KnowledgeItem, KnowledgeStatus } from '../core/types.js';
import * as repo from './repository.js';
import { crossRepoOverlapForWrite, findLikelyDuplicateKnowledgeItem, heldPayloadFor, resolveDuplicate } from './knowledge-writer.js';
import type { CrossRepoOverlap } from '../workspace/cross-repo-overlap.js';
import { hasAiConfigured } from '../core/config.js';
import { initAI } from '../ai/provider.js';
import { getCurrentGitCommit } from './drift.js';
import { KnowledgeWriteValidationOptions } from '../core/types.js';
import { attachEvidenceToKnowledge } from './evidence-repository.js';
import { indexKnowledgeItemsBestEffort } from './write-embedding.js';

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
      initAI(config.ai!);
      const { runDeriveTruth } = await import('../pipeline/derive.js');
      await runDeriveTruth(projectId, [item]);
    } catch {
      // Best-effort
    }
  }

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
  },
  options?: {
    projectRoot?: string | null;
    sourceCommit?: string | null;
    freshness?: 'fresh' | 'stale' | 'needs_review';
    validationOptions?: KnowledgeWriteValidationOptions;
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

  await repo.createKnowledgeCommit(projectId, `Update item: ${updated.title}`, [
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

  return updated;
}
