import { and, eq, SQL } from 'drizzle-orm';
import { KnowledgeCategory, KnowledgeItem, KnowledgeStatus } from '../core/types.js';
import { DatabaseError } from '../core/errors.js';
import { getClient, getDb } from './database.js';
import { getKnowledgeItem } from './repository.js';
import * as schema from './schema.js';

export type KnowledgeEmbeddingInput = {
  projectId?: string;
  knowledgeItemId: string;
  provider: string;
  model: string;
  dimensions: number;
  vector: number[];
};

export type VectorSearchResult = {
  item: KnowledgeItem;
  score: number;
};

/**
 * Exported so cross-repo fusion scores peer items with the same function rather than a
 * parallel implementation. Comparable across repos only because a workspace pins one
 * embedding identity -- see `sameEmbeddingIdentity`.
 */
export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) return 0;

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let i = 0; i < left.length; i++) {
    dot += left[i] * right[i];
    leftMagnitude += left[i] * left[i];
    rightMagnitude += right[i] * right[i];
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

export async function upsertKnowledgeEmbedding(input: KnowledgeEmbeddingInput): Promise<void> {
  if (input.dimensions !== input.vector.length) {
    throw new DatabaseError(`Embedding dimensions ${input.dimensions} do not match vector length ${input.vector.length}`);
  }

  const db = getDb();
  const now = new Date().toISOString();
  const row = {
    knowledgeItemId: input.knowledgeItemId,
    provider: input.provider,
    model: input.model,
    dimensions: input.dimensions,
    vector: input.vector,
    updatedAt: now,
  };

  try {
    await db
      .insert(schema.knowledgeEmbeddings)
      .values(row)
      .onConflictDoUpdate({
        target: schema.knowledgeEmbeddings.knowledgeItemId,
        set: row,
      });
  } catch (error: any) {
    throw new DatabaseError(`Failed to upsert knowledge embedding: ${error.message}`);
  }
}

export async function searchKnowledgeEmbeddings(
  projectId: string,
  options: {
    vector: number[];
    category?: KnowledgeCategory;
    status?: KnowledgeStatus;
    tags?: string[];
    provider?: string;
    model?: string;
    limit?: number;
  }
): Promise<VectorSearchResult[]> {
  const db = getDb();
  const status = options.status || 'active';
  const limit = options.limit ?? 20;

  try {
    const conditions: SQL[] = [];
    if (options.provider) {
      conditions.push(eq(schema.knowledgeEmbeddings.provider, options.provider));
    }
    if (options.model) {
      conditions.push(eq(schema.knowledgeEmbeddings.model, options.model));
    }

    const baseQuery = db
      .select()
      .from(schema.knowledgeEmbeddings);
    const rows = conditions.length > 0
      ? await baseQuery.where(and(...conditions))
      : await baseQuery;

    const results: VectorSearchResult[] = [];
    for (const row of rows) {
      const vector = row.vector as number[];
      const score = cosineSimilarity(options.vector, vector);
      if (score <= 0) continue;

      const item = await getKnowledgeItem(row.knowledgeItemId);
      if (!item) continue;
      if (item.status !== status) continue;
      if (options.category && item.category !== options.category) continue;
      if (options.tags && options.tags.length > 0) {
        if (!item.tags || !options.tags.every(tag => item.tags!.includes(tag))) continue;
      }

      results.push({ item, score });
    }

    return results
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  } catch (error: any) {
    throw new DatabaseError(`Failed to search knowledge embeddings: ${error.message}`);
  }
}

/**
 * Stored vectors for specific items, from the currently open database.
 *
 * Cross-repo fusion needs local vectors in the same shape it reads peer ones, so local and
 * foreign candidates can be scored by the same cosine rather than compared by position.
 * Items written before embeddings were enabled simply have no row, and the caller falls
 * back to positional scoring for those.
 */
export async function getEmbeddingsForItems(itemIds: string[]): Promise<Map<string, number[]>> {
  const found = new Map<string, number[]>();
  if (itemIds.length === 0) return found;

  const rows = await getClient().execute({
    sql: `SELECT knowledge_item_id, vector FROM knowledge_embeddings
          WHERE knowledge_item_id IN (${itemIds.map(() => '?').join(', ')})`,
    args: itemIds,
  });

  for (const row of rows.rows) {
    try {
      const parsed = JSON.parse(String(row.vector));
      if (Array.isArray(parsed) && parsed.length > 0) found.set(String(row.knowledge_item_id), parsed as number[]);
    } catch {
      // A malformed vector is treated as absent rather than failing the query.
    }
  }
  return found;
}
