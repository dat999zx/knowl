import { withClientTransaction } from '../store/database.js';
import * as repo from '../store/repository.js';
import { VerifiedAtomAction } from './verify.js';
import { KnowledgeAtom, CommitChange } from '../core/types.js';
import { DatabaseError } from '../core/errors.js';
import { isVerifiedProvenance, type WriteChannel } from '../store/knowledge-writer.js';

export interface MergeOptions {
  autoResolveContradictions?: boolean;
  commitMessage?: string;
  /** See `WriteChannel`. `runPipeline` (raw ingest) is automatic; `runDecisionPipeline` is direct. */
  channel?: WriteChannel;
}

export interface MergeResult {
  commitId?: string;
  mergedCount: number;
  insertedIds: string[];
  updatedIds: string[];
  supersededIds: string[];
  /** Verified items an automatic atom, or exclusive items any atom, would have rewritten or retired, left untouched. */
  keptBesideIds: string[];
  unresolvedContradictions: VerifiedAtomAction[];
}

export async function runMerge(
  projectId: string,
  actions: VerifiedAtomAction[],
  options: MergeOptions = {}
): Promise<MergeResult> {
  const commitMessage = options.commitMessage || 'Merge knowledge updates';
  const autoResolve = options.autoResolveContradictions ?? false;
  const channel = options.channel ?? 'direct';

  const result: MergeResult = {
    mergedCount: 0,
    insertedIds: [],
    updatedIds: [],
    supersededIds: [],
    keptBesideIds: [],
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
    // Run the merge in a single transaction. Client-level, not db.transaction: see
    // withClientTransaction for the measurement.
    await withClientTransaction(async (tx) => {
      const insertAtom = async (atom: KnowledgeAtom) => {
        const newItem = await repo.createKnowledgeItem(
          projectId,
          {
            category: atom.category,
            title: atom.title,
            content: atom.content,
            reasoning: atom.reasoning,
            alternatives: atom.alternatives,
            tags: atom.tags,
            source: atom.source,
            sourceCommit: atom.sourceCommit,
            affectedPaths: atom.affectedPaths,
            confidence: atom.confidence,
          },
          atom.steps,
          tx,
        );
        result.insertedIds.push(newItem.id);
        dbChanges.push({ itemId: newItem.id, action: 'insert', after: newItem });
        return newItem;
      };

      for (const action of actionsToApply) {
        if (action.action === 'insert') {
          await insertAtom(action.atom);
        }

        else if (action.action === 'update' && action.existingItemId) {
          const beforeItem = await repo.getKnowledgeItem(action.existingItemId, tx);
          if (!beforeItem) continue;

          // The in-place update is the worst of the three outcomes for a verified item: unlike a
          // supersession it keeps no copy of what was there. Raw ingest is a model over arbitrary
          // text, so it may add beside a verified item but never rewrite one. An exclusive item is
          // held on every channel: `knowl decide` with AI configured reaches here as direct, and a
          // model's "update" verdict rewrote the one answer its author said nothing replaces.
          if ((channel === 'automatic' && isVerifiedProvenance(beforeItem)) || beforeItem.conflictExclusive) {
            await insertAtom(action.atom);
            result.keptBesideIds.push(beforeItem.id);
            continue;
          }

          const updateData = action.compareResult!;
          const updatedItem = await repo.updateKnowledgeItem(
            action.existingItemId,
            {
              title: updateData.updatedTitle || action.atom.title,
              content: updateData.updatedContent || action.atom.content,
              reasoning: updateData.updatedReasoning || action.atom.reasoning,
              alternatives: updateData.updatedAlternatives || action.atom.alternatives,
              tags: updateData.updatedTags || action.atom.tags,
              source: action.atom.source,
              sourceCommit: action.atom.sourceCommit,
              affectedPaths: action.atom.affectedPaths,
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

          if ((channel === 'automatic' && isVerifiedProvenance(beforeItem)) || beforeItem.conflictExclusive) {
            await insertAtom(action.atom);
            result.keptBesideIds.push(beforeItem.id);
            continue;
          }

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
              source: action.atom.source,
              sourceCommit: action.atom.sourceCommit,
              affectedPaths: action.atom.affectedPaths,
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
