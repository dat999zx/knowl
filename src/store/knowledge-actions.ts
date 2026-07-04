import { CommitChange, KnowledgeItem, KnowledgeStatus } from '../core/types.js';
import * as repo from './repository.js';

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
  commitMessage = `Record decision: ${input.title}`
): Promise<KnowledgeItem> {
  const item = await repo.createKnowledgeItem(projectId, {
    category: 'decision',
    title: input.title,
    content: input.content,
    reasoning: input.reasoning,
    alternatives: input.alternatives,
    tags: input.tags,
  });

  await repo.createKnowledgeCommit(projectId, commitMessage, [
    { itemId: item.id, action: 'insert', after: item },
  ]);

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
    action = updates.status === 'active' ? 'restore' : updates.status;
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
