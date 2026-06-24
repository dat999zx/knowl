import { getDb } from '../store/database.js';
import * as repo from '../store/repository.js';
import { VerifiedAtomAction } from './verify.js';
import { CommitChange, KnowledgeItem } from '../core/types.js';
import { DatabaseError } from '../core/errors.js';

export interface MergeOptions {
  autoResolveContradictions?: boolean;
  commitMessage?: string;
}

export interface MergeResult {
  commitId?: string;
  mergedCount: number;
  insertedIds: string[];
  updatedIds: string[];
  supersededIds: string[];
  unresolvedContradictions: VerifiedAtomAction[];
}

export async function runMerge(
  projectId: string,
  actions: VerifiedAtomAction[],
  options: MergeOptions = {}
): Promise<MergeResult> {
  const db = getDb();
  const commitMessage = options.commitMessage || 'Merge knowledge updates';
  const autoResolve = options.autoResolveContradictions ?? false;

  const result: MergeResult = {
    mergedCount: 0,
    insertedIds: [],
    updatedIds: [],
    supersededIds: [],
    unresolvedContradictions: [],
  };

  const dbChanges: CommitChange[] = [];
  const actionsToApply: VerifiedAtomAction[] = [];

  // Separate actions into unresolved contradictions vs actual operations to run
  for (const action of actions) {
    if (action.action === 'contradiction' && !autoResolve) {
      result.unresolvedContradictions.push(action);
    } else {
      actionsToApply.push(action);
    }
  }

  if (actionsToApply.length === 0) {
    return result;
  }

  try {
    // Run the merge in a single transaction
    await db.transaction(async (tx) => {
      for (const action of actionsToApply) {
        if (action.action === 'insert') {
          const newItem = await repo.createKnowledgeItem(
            projectId,
            {
              category: action.atom.category,
              title: action.atom.title,
              content: action.atom.content,
              reasoning: action.atom.reasoning,
              alternatives: action.atom.alternatives,
              tags: action.atom.tags,
              confidence: action.atom.confidence,
            },
            action.atom.steps,
            tx // Pass transaction
          );

          result.insertedIds.push(newItem.id);
          dbChanges.push({
            itemId: newItem.id,
            action: 'insert',
            after: newItem,
          });
        } 
        
        else if (action.action === 'update' && action.existingItemId) {
          const beforeItem = await repo.getKnowledgeItem(action.existingItemId, tx);
          if (!beforeItem) continue;

          const updateData = action.compareResult!;
          const updatedItem = await repo.updateKnowledgeItem(
            action.existingItemId,
            {
              title: updateData.updatedTitle || action.atom.title,
              content: updateData.updatedContent || action.atom.content,
              reasoning: updateData.updatedReasoning || action.atom.reasoning,
              alternatives: updateData.updatedAlternatives || action.atom.alternatives,
              tags: updateData.updatedTags || action.atom.tags,
            },
            updateData.updatedSteps || action.atom.steps,
            tx // Pass transaction
          );

          result.updatedIds.push(updatedItem.id);
          dbChanges.push({
            itemId: updatedItem.id,
            action: 'update',
            before: beforeItem,
            after: updatedItem,
          });
        } 
        
        else if (action.action === 'contradiction' && action.existingItemId && autoResolve) {
          // 1. Supersede existing item
          const beforeItem = await repo.getKnowledgeItem(action.existingItemId, tx);
          if (!beforeItem) continue;

          // 2. Create the new item
          const newItem = await repo.createKnowledgeItem(
            projectId,
            {
              category: action.atom.category,
              title: action.atom.title,
              content: action.atom.content,
              reasoning: action.atom.reasoning,
              alternatives: action.atom.alternatives,
              tags: action.atom.tags,
              confidence: action.atom.confidence,
            },
            action.atom.steps,
            tx // Pass transaction
          );

          // 3. Mark old item as superseded by new item
          const supersededItem = await repo.updateKnowledgeItem(
            action.existingItemId,
            {
              status: 'superseded',
              supersededById: newItem.id,
            },
            undefined,
            tx // Pass transaction
          );

          result.supersededIds.push(action.existingItemId);
          result.insertedIds.push(newItem.id);

          dbChanges.push({
            itemId: action.existingItemId,
            action: 'supersede',
            before: beforeItem,
            after: supersededItem,
          });

          dbChanges.push({
            itemId: newItem.id,
            action: 'insert',
            after: newItem,
          });
        }
      }

      // If we made changes, create a knowledge commit
      if (dbChanges.length > 0) {
        const commit = await repo.createKnowledgeCommit(projectId, commitMessage, dbChanges, tx);
        result.commitId = commit.id;
        result.mergedCount = dbChanges.length;
      }
    });

    return result;
  } catch (error: any) {
    throw new DatabaseError(`Failed to merge pipeline actions: ${error.message}`);
  }
}
