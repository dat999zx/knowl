import { and, eq, SQL } from 'drizzle-orm';
import { KnowledgeCategory, KnowledgeItem, KnowledgeStatus } from '../core/types.js';
import { DatabaseError } from '../core/errors.js';
import { getClient, getDb } from './database.js';
import { getKnowledgeItems } from './repository.js';
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
  const leftMagnitude = magnitude(left);
  if (leftMagnitude === 0) return 0;
  return cosineWithKnownMagnitude(left, leftMagnitude, right);
}

function magnitude(vector: number[]): number {
  let total = 0;
  for (let i = 0; i < vector.length; i++) total += vector[i] * vector[i];
  return Math.sqrt(total);
}

/**
 * Cosine where the first vector's magnitude is already known.
 *
 * A search compares one query vector against every stored vector, and recomputing the query's
 * magnitude inside that loop is pure waste. Kept as an exact cosine rather than assuming unit
 * vectors: the local embedder normalises, but a future provider might not, and silently
 * returning a plain dot product would then mis-rank rather than fail loudly.
 */
function cosineWithKnownMagnitude(left: number[], leftMagnitude: number, right: number[]): number {
  if (left.length !== right.length || left.length === 0) return 0;

  let dot = 0;
  let rightMagnitude = 0;
  for (let i = 0; i < left.length; i++) {
    dot += left[i] * right[i];
    rightMagnitude += right[i] * right[i];
  }

  if (rightMagnitude === 0) return 0;
  return dot / (leftMagnitude * Math.sqrt(rightMagnitude));
}

/**
 * Vectors are written as a packed float32 BLOB and read back as either that or the legacy
 * JSON-text encoding.
 *
 * SQLite columns hold values of any storage class, so both encodings coexist in the same column
 * and no migration is needed: rows written before this change keep working, and each is upgraded
 * the next time it is reindexed. JSON cost real time on every search, because a scan parsed one
 * array of several hundred numbers per stored atom.
 *
 * float32 is the precision the embedding model itself produces, so packing loses nothing that
 * was ever there -- the previous JSON encoding widened those values to float64 on the way in.
 */
function encodeVector(vector: number[]): Uint8Array {
  const floats = Float32Array.from(vector);
  return new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
}

export function decodeVector(value: unknown): number[] | null {
  if (Array.isArray(value)) return value as number[];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) && parsed.length > 0 ? (parsed as number[]) : null;
    } catch {
      return null;
    }
  }
  if (value instanceof ArrayBuffer) return Array.from(new Float32Array(value));
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return Array.from(new Float32Array(view.buffer, view.byteOffset, view.byteLength / 4));
  }
  return null;
}

export async function upsertKnowledgeEmbedding(input: KnowledgeEmbeddingInput): Promise<void> {
  if (input.dimensions !== input.vector.length) {
    throw new DatabaseError(`Embedding dimensions ${input.dimensions} do not match vector length ${input.vector.length}`);
  }

  const now = new Date().toISOString();
  try {
    await getClient().execute({
      sql: `INSERT INTO knowledge_embeddings (knowledge_item_id, provider, model, dimensions, vector, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(knowledge_item_id) DO UPDATE SET
              provider = excluded.provider, model = excluded.model,
              dimensions = excluded.dimensions, vector = excluded.vector,
              updated_at = excluded.updated_at`,
      args: [
        input.knowledgeItemId,
        input.provider,
        input.model,
        input.dimensions,
        encodeVector(input.vector),
        now,
      ],
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
  const status = options.status || 'active';
  const limit = options.limit ?? 20;

  try {
    // Status and category are filtered in SQL by joining the items table, so rows that could
    // never be returned are never scanned, decoded or scored. Only `tags` is left to JavaScript,
    // because it is stored as a JSON array rather than a column.
    const where: string[] = ['i.status = ?'];
    const args: unknown[] = [status];
    if (options.category) {
      where.push('i.category = ?');
      args.push(options.category);
    }
    if (options.provider) {
      where.push('e.provider = ?');
      args.push(options.provider);
    }
    if (options.model) {
      where.push('e.model = ?');
      args.push(options.model);
    }

    const rows = await getClient().execute({
      sql: `SELECT e.knowledge_item_id AS id, e.vector AS vector
            FROM knowledge_embeddings e
            JOIN knowledge_items i ON i.id = e.knowledge_item_id
            WHERE ${where.join(' AND ')}`,
      args: args as any[],
    });

    // Score first, cheaply, without touching the database again. An earlier shape fetched the
    // knowledge item inside this loop, costing roughly one query per stored atom because cosine
    // is positive for nearly any pair of text embeddings, so `score <= 0` almost never skipped.
    const queryMagnitude = magnitude(options.vector);
    if (queryMagnitude === 0) return [];

    const scored: Array<{ id: string; score: number }> = [];
    for (const row of rows.rows) {
      const vector = decodeVector((row as any).vector);
      if (!vector) continue;
      const score = cosineWithKnownMagnitude(options.vector, queryMagnitude, vector);
      if (score <= 0) continue;
      scored.push({ id: String((row as any).id), score });
    }
    scored.sort((left, right) => right.score - left.score);

    // Walk the ranking in batches and stop as soon as enough survive the filters. Only the
    // highest-scoring candidates are ever materialised, instead of every row in the table.
    const results: VectorSearchResult[] = [];
    const batchSize = Math.max(limit * 4, 32);
    for (let start = 0; start < scored.length && results.length < limit; start += batchSize) {
      const batch = scored.slice(start, start + batchSize);
      const items = await getKnowledgeItems(batch.map(candidate => candidate.id));
      for (const candidate of batch) {
        const item = items.get(candidate.id);
        if (!item) continue;
        // Status and category were already applied in SQL; only the JSON-array tag filter remains.
        if (options.tags && options.tags.length > 0) {
          if (!item.tags || !options.tags.every(tag => item.tags!.includes(tag))) continue;
        }
        results.push({ item, score: candidate.score });
        if (results.length >= limit) break;
      }
    }

    return results;
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
    // Handles both the packed float32 BLOB and the legacy JSON text; a malformed vector is
    // treated as absent rather than failing the query.
    const vector = decodeVector(row.vector);
    if (vector && vector.length > 0) found.set(String(row.knowledge_item_id), vector);
  }
  return found;
}
