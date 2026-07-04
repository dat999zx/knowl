import { ProjectConfig, CommitChange, KnowledgeItem, KnowledgeStatus } from '../core/types.js';
import * as repo from './repository.js';
import { findLikelyDuplicateKnowledgeItem } from './knowledge-writer.js';
import { hasAiConfigured } from '../core/config.js';
import { initAI } from '../ai/provider.js';

export type DirectDecisionInput = {
  title: string;
  content: string;
  reasoning?: string | null;
  alternatives?: string[] | null;
  tags?: string[] | null;
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
  });

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
  }
): Promise<KnowledgeItem> {
  const beforeItem = await repo.getKnowledgeItem(id);
  if (!beforeItem) {
    throw new Error(`Knowledge item not found with ID ${id}`);
  }

  const updated = await repo.updateKnowledgeItem(id, updates);
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
