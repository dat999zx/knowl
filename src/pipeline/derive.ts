import { eq, and } from 'drizzle-orm';
import { getDb, DbConnection } from '../store/database.js';
import * as schema from '../store/schema.js';
import * as repo from '../store/repository.js';
import { deriveTruth } from '../ai/provider.js';
import { KnowledgeItem, CommitChange, KnowledgeCategory, KnowledgeStatus } from '../core/types.js';

export interface DeriveResult {
  derivedTruthsCount: number;
  stateChangesCount: number;
  commitId?: string;
}

/**
 * Derives key=value active state truths from newly added or updated project decisions, facts, or architecture.
 * This runs at write-time after a successful merge, adhering to the "expensive write, cheap read" model.
 */
export async function runDeriveTruth(
  projectId: string,
  items: KnowledgeItem[],
  dbConnection?: DbConnection
): Promise<DeriveResult> {
  // Only extract truths from decisions, facts, and architecture specifications
  const relevantItems = items.filter(
    item =>
      item.status === 'active' &&
      (item.category === 'decision' || item.category === 'fact' || item.category === 'architecture')
  );

  if (relevantItems.length === 0) {
    return { derivedTruthsCount: 0, stateChangesCount: 0 };
  }

  // Derive truths from the relevant items
  const allDerivedTruths: { key: string; value: string }[] = [];
  for (const item of relevantItems) {
    try {
      const truths = await deriveTruth(item);
      if (Array.isArray(truths)) {
        allDerivedTruths.push(...truths);
      }
    } catch (error) {
      // Log error but proceed without failing the whole process
      console.warn(`[Derive] Failed to derive truth from item "${item.title}":`, error);
    }
  }

  if (allDerivedTruths.length === 0) {
    return { derivedTruthsCount: 0, stateChangesCount: 0 };
  }

  const conn = dbConnection || getDb();
  let stateChangesCount = 0;
  let commitId: string | undefined;

  // Run in a transaction to guarantee consistency
  await conn.transaction(async (tx) => {
    // 1. Fetch current active state items
    const existingRows = await tx
      .select()
      .from(schema.knowledgeItems)
      .where(
        and(
          eq(schema.knowledgeItems.category, 'state'),
          eq(schema.knowledgeItems.status, 'active')
        )
      );

    const existingStateItems = existingRows.map(row => ({
      ...row,
      category: row.category as KnowledgeCategory,
      status: row.status as KnowledgeStatus,
      alternatives: row.alternatives as string[] | null,
      tags: row.tags as string[] | null,
    }));

    const changes: CommitChange[] = [];

    // 2. Process each derived truth
    for (const truth of allDerivedTruths) {
      const existing = existingStateItems.find(
        x => x.title.toLowerCase() === truth.key.toLowerCase()
      );

      if (existing) {
        // If value has changed, update it
        if (existing.content !== truth.value) {
          const updated = await repo.updateKnowledgeItem(
            existing.id,
            { content: truth.value },
            undefined, // steps
            tx
          );
          changes.push({
            itemId: existing.id,
            action: 'update',
            before: existing,
            after: updated,
          });
          stateChangesCount++;
        }
      } else {
        // Create new state item
        const newItem = await repo.createKnowledgeItem(
          projectId,
          {
            category: 'state',
            title: truth.key.toLowerCase(),
            content: truth.value,
            tags: ['derived'],
          },
          undefined, // steps
          tx
        );
        changes.push({
          itemId: newItem.id,
          action: 'insert',
          after: newItem,
        });
        stateChangesCount++;
      }
    }

    // 3. Create a commit if any changes were made
    if (changes.length > 0) {
      const commit = await repo.createKnowledgeCommit(
        projectId,
        `Derive active state truths (${stateChangesCount} change(s))`,
        changes,
        tx
      );
      commitId = commit.id;
    }
  });

  return {
    derivedTruthsCount: allDerivedTruths.length,
    stateChangesCount,
    commitId,
  };
}
