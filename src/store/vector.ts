import { and, eq, SQL } from 'drizzle-orm';
import { KnowledgeCategory, KnowledgeItem, KnowledgeStatus } from '../core/types.js';
import { DatabaseError } from '../core/errors.js';
import { getClient, getDb } from './database.js';
import { getKnowledgeItems } from './repository.js';
import { localStore, type StoreHandle } from './store-handle.js';
import * as schema from './schema.js';

export type KnowledgeEmbeddingInput = {
  projectId?: string;
  knowledgeItemId: string;
  provider: string;
  model: string;
  /** Identifies the exact profile that produced this vector. See fingerprintProfile. */
  profileFingerprint: string;
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
export function cosineSimilarity(left: NumericVector, right: NumericVector): number {
  if (left.length !== right.length || left.length === 0) return 0;
  const leftMagnitude = magnitude(left);
  if (leftMagnitude === 0) return 0;
  return cosineWithKnownMagnitude(left, leftMagnitude, right);
}

function magnitude(vector: NumericVector): number {
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
function cosineWithKnownMagnitude(left: NumericVector, leftMagnitude: number, right: NumericVector): number {
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

export type NumericVector = number[] | Float32Array;

export function decodeVector(value: unknown): NumericVector | null {
  if (Array.isArray(value)) return value as number[];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) && parsed.length > 0 ? (parsed as number[]) : null;
    } catch {
      return null;
    }
  }
  // A VIEW, not a copy. `Array.from` here allocated a 768-element boxed-float64 JS array for
  // every row in the scan, and measurement put that single call at roughly 700ms of a
  // ~1,100ms search over 10,000 vectors -- while the cosine arithmetic it feeds was 32ms.
  // The scan was never the expensive part; converting the rows for it was. A Float32Array
  // indexes identically for the arithmetic below, so nothing downstream changes.
  if (value instanceof ArrayBuffer) return new Float32Array(value);
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Float32Array(view.buffer, view.byteOffset, view.byteLength / 4);
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
      sql: `INSERT INTO knowledge_embeddings (knowledge_item_id, provider, model, profile_fingerprint, dimensions, vector, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(knowledge_item_id) DO UPDATE SET
              provider = excluded.provider, model = excluded.model,
              profile_fingerprint = excluded.profile_fingerprint,
              dimensions = excluded.dimensions, vector = excluded.vector,
              updated_at = excluded.updated_at`,
      args: [
        input.knowledgeItemId,
        input.provider,
        input.model,
        input.profileFingerprint ?? null,
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
    /**
     * Required, not optional: omitting it would drop the predicate and score every stored
     * vector regardless of the model, dtype or pooling that produced it -- the exact
     * mis-ranking the fingerprint exists to prevent, and silent when it happens.
     */
    profileFingerprint: string;
    limit?: number;
    /** Restricts to shared items; required for a peer store. See searchKnowledgeItems. */
    visibility?: 'repo' | 'workspace';
  },
  store: StoreHandle = localStore(),
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
    // Same rule as the FTS path: a peer's private row must not be read into this process, so
    // the predicate goes in the query rather than filtering what came back.
    if (options.visibility) {
      where.push('i.visibility = ?');
      args.push(options.visibility);
    }
    // Provider and model are not sufficient: dtype and pooling change the numbers a
    // model emits, so a row written under a different one is not comparable even
    // though its provider and model match. Applied unconditionally -- an empty
    // fingerprint matches the rows that have none rather than matching everything.
    where.push('e.profile_fingerprint = ?');
    args.push(options.profileFingerprint);

    const rows = await store.client.execute({
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
      // Hydrated from the store the ids came from -- same reason as the FTS path. The
      // ambient handle would return nothing for a peer, or the wrong row on a collision.
      const items = await getKnowledgeItems(batch.map(candidate => candidate.id), store.db);
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
 * Which of these items vector search was actually able to consider.
 *
 * The relevance floor needs this to tell two identical-looking candidates apart: one that
 * vector ranked outside its top N (semantically distant -- drop it) and one vector could never
 * have returned at all because it has no embedding (invisible, not distant -- keep it). Both
 * arrive as BM25-only candidates scoring around 0.034, so nothing in the fused score
 * distinguishes them.
 *
 * The profile fingerprint decides eligibility, not a detail: `searchKnowledgeEmbeddings`
 * filters on it, so a row written under a different model, dtype or pooling is unreachable
 * by the current search and its item is no more eligible than one with no row at all.
 */
export async function findEmbeddedItemIds(
  itemIds: string[],
  /** Required for the same reason as in `searchKnowledgeEmbeddings`: eligibility means
   *  reachable by *this* profile, and a looser answer feeds the relevance floor items
   *  vector search could never return. */
  options: { profileFingerprint: string },
  store: StoreHandle = localStore(),
): Promise<Set<string>> {
  const found = new Set<string>();
  if (itemIds.length === 0) return found;

  const where = [
    `knowledge_item_id IN (${itemIds.map(() => '?').join(', ')})`,
    'profile_fingerprint = ?',
  ];
  const args: unknown[] = [...itemIds, options.profileFingerprint];

  const rows = await store.client.execute({
    sql: `SELECT knowledge_item_id FROM knowledge_embeddings WHERE ${where.join(' AND ')}`,
    args: args as any[],
  });

  for (const row of rows.rows) found.add(String(row.knowledge_item_id));
  return found;
}

/** How many embedding rows exist, regardless of profile. Used to size the switch warning. */
export async function countStoredEmbeddings(): Promise<number> {
  const rows = await getClient().execute('SELECT COUNT(*) AS total FROM knowledge_embeddings');
  return Number((rows.rows[0] as any)?.total ?? 0);
}

/**
 * Drops rows left behind by a previous profile, including those for deleted items.
 *
 * With no fingerprint to keep, nothing is provably stale, so this does nothing rather
 * than treating every row as unmatched -- the same predicate would otherwise delete
 * the entire table.
 *
 * Database-wide, and `projectId` is deliberately not a predicate -- it cannot be one.
 * `knowledge_items` has no `project_id`; that column exists only in the legacy schema
 * `migrateLegacyProjectSchema` strips. And `getProjectByRootPath` returns the constant
 * `LOCAL_PROJECT_ID` for every root, so one database holds exactly one project and a
 * "neighbouring project" here has no meaning. Scoping the DELETE through
 * `knowledge_items.project_id` fails at runtime with `no such column`. Should a shared
 * store ever hold several repos' items, the discriminator is `origin_repo`.
 */
export async function purgeEmbeddingsNotMatching(projectId: string, fingerprint: string): Promise<number> {
  if (!fingerprint) return 0;
  const result = await getClient().execute({
    sql: `DELETE FROM knowledge_embeddings
          WHERE profile_fingerprint IS NULL OR profile_fingerprint != ?`,
    args: [fingerprint],
  });
  return Number(result.rowsAffected ?? 0);
}

