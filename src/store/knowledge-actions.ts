import { ProjectConfig, CommitChange, EvidenceInput, KnowledgeItem, KnowledgeStatus } from '../core/types.js';
import * as repo from './repository.js';
import { findLikelyDuplicateKnowledgeItem } from './knowledge-writer.js';
import { hasAiConfigured } from '../core/config.js';
import { initAI } from '../ai/provider.js';
import { getCurrentGitCommit } from './drift.js';
import { KnowledgeWriteValidationOptions } from '../core/types.js';
import { attachEvidenceToKnowledge } from './evidence-repository.js';

export type DirectDecisionInput = {
  title: string;
  content: string;
  reasoning?: string | null;
  alternatives?: string[] | null;
  tags?: string[] | null;
  evidence?: EvidenceInput[];
};

export async function recordDecisionDirect(
  projectId: string,
  input: DirectDecisionInput,
  commitMessage = `Record decision: ${input.title}`,
  config?: ProjectConfig
): Promise<KnowledgeItem> {
  const existing = await findLikelyDuplicateKnowledgeItem(projectId, {
    category: 'decision',
    title: input.title,
    content: input.content,
    reasoning: input.reasoning,
    tags: input.tags,
  });

  const item = await repo.createKnowledgeItem(projectId, {
    category: 'decision',
    title: input.title,
    content: input.content,
    reasoning: input.reasoning,
    alternatives: input.alternatives,
    tags: input.tags,
  }, undefined, undefined, config?.security);
  await attachEvidenceToKnowledge(item.id, input.evidence);

  if (existing) {
    await repo.updateKnowledgeItem(existing.id, {
      status: 'superseded',
      supersededById: item.id,
    });
  }

  const changes: CommitChange[] = [];
  if (existing) {
    changes.push({ itemId: existing.id, action: 'supersede', before: existing });
  }
  changes.push({ itemId: item.id, action: 'insert', after: item });

  await repo.createKnowledgeCommit(projectId, commitMessage, changes);

  if (config && hasAiConfigured(config)) {
    try {
      initAI(config.ai!);
      const { runDeriveTruth } = await import('../pipeline/derive.js');
      await runDeriveTruth(projectId, [item]);
    } catch {
      // Best-effort
    }
  }

  return item;
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

  return updated;
}
