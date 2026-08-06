import { Client } from '@libsql/client';
import { and, SQL } from 'drizzle-orm';
import { KnowledgeCategory, KnowledgeItem, KnowledgeStatus } from '../core/types.js';
import { DatabaseError } from '../core/errors.js';
import { getClient, withClientTransaction } from './database.js';
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

/** Validates, then renders one row. Separate so a batch can be checked before anything is written. */
function embeddingUpsert(input: KnowledgeEmbeddingInput, now: string) {
  if (input.dimensions !== input.vector.length) {
    throw new DatabaseError(`Embedding dimensions ${input.dimensions} do not match vector length ${input.vector.length}`);
  }

  return {
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
    ] as any[],
  };
}

export async function upsertKnowledgeEmbedding(input: KnowledgeEmbeddingInput): Promise<void> {
  const statement = embeddingUpsert(input, new Date().toISOString());
  try {
    await getClient().execute(statement);
  } catch (error: any) {
    throw new DatabaseError(`Failed to upsert knowledge embedding: ${error.message}`);
  }
}

/**
 * Write several vectors as one transaction.
 *
 * A bare `execute` is its own implicit transaction, and this schema runs `journal_mode=wal`
 * with `synchronous=FULL`, so every row written on its own costs a WAL fsync. Measured on this
 * table, same connection, 2,000 rows: 23,139 ms one at a time against 175 ms inside a single
 * `BEGIN`/`COMMIT` -- 11.57 ms per row against 0.088, **132x**. That is the whole gap; the
 * statement itself is not slow.
 *
 * It is also why `tests/store/reindex-scope.test.ts > pages past the old 10,000 ceiling` looked
 * flaky: 10,050 rows at 11.57 ms is ~116 s against its own 120 s timeout, so whether it passed
 * was decided by a few seconds of machine noise. It was never a race. Measured on an idle
 * machine: 88,549 ms before, 2,220 ms after.
 *
 * `withClientTransaction` rather than `db.transaction()` deliberately: the drizzle wrapper is
 * the one with the documented ~800-1000 call ceiling, and it is the *count of calls* that
 * matters, not the statements inside one (see `database.ts`). A reindex makes one call per
 * 500-item page.
 *
 * A single input skips the transaction: one statement is already atomic and already one fsync,
 * so wrapping it would only add two round trips and a wait on the transaction queue -- and this
 * is the path every ordinary knowledge write takes.
 */
export async function upsertKnowledgeEmbeddings(inputs: KnowledgeEmbeddingInput[]): Promise<void> {
  if (inputs.length === 0) return;
  if (inputs.length === 1) return upsertKnowledgeEmbedding(inputs[0]);

  // Every row is rendered and validated before the transaction opens, so a bad dimension
  // cannot leave half a batch committed.
  const now = new Date().toISOString();
  const statements = inputs.map(input => embeddingUpsert(input, now));

  try {
    await withClientTransaction(async () => {
      const client = getClient();
      for (const statement of statements) await client.execute(statement);
    });
  } catch (error: any) {
    throw new DatabaseError(`Failed to upsert knowledge embeddings: ${error.message}`);
  }
}

/**
 * Connections whose stored vectors SQLite could not score, so they use the JavaScript scan.
 *
 * Learned from a failure rather than predicted. An earlier version of this file probed each
 * connection once for the legacy encoding and trusted the answer for the life of the process,
 * on the reasoning that a row's encoding only changes when it is rewritten and every rewrite
 * writes a blob. That reasoning is wrong in the one direction that matters: a row this process
 * did not write can appear at any time -- another process on an older build, an import, a
 * restore -- and a stale "all blobs" answer would then hide it from semantic search entirely
 * while `findEmbeddedItemIds` still called its item embedded. That is K-60's shape, and a
 * cached prediction is exactly how you get it.
 *
 * A connection lands here only when the SQL scan raised AND the JavaScript scan then succeeded
 * on the same query, so it records a fact about the data rather than a guess about it.
 */
const jsScanOnly = new WeakSet<Client>();

/** One page of the ranking: the highest-scoring candidates after `offset`, already ordered. */
type RankedPage = (offset: number, size: number) => Promise<Array<{ id: string; score: number }>>;

/**
 * Cosine computed by SQLite, ordered and paged by SQLite.
 *
 * `vector_distance_cos` is a libSQL built-in over the same packed float32 layout `encodeVector`
 * writes -- byte for byte, which is why no migration is involved -- so the scan never sends a
 * vector across the client boundary at all. Measured against the JavaScript scan on 768-dim
 * stores: the whole vector column stops being transferred (30 MB at 10,000 rows), and what a
 * search reads back is one page of ids and floats.
 *
 * BOTH encodings are scored here. The function parses the legacy JSON-text form as readily as
 * the blob and returns the same number for it, so old rows are not merely tolerated by a
 * side path -- they are ranked by the same statement, which is what stops them from going
 * quietly missing. `dimensions` is the width predicate because it is the one column that
 * describes both encodings; the blob length check catches a blob that disagrees with it, which
 * is precisely the row the JavaScript scan used to score as 0 and drop.
 *
 * `score <= 0` is filtered here rather than in SQL so the distance is computed once per row: a
 * `WHERE` on the same expression would double the arithmetic this path exists to move. A zero
 * vector yields NULL, which `ORDER BY ... DESC` puts last and `Number(null)` fails the test.
 *
 * The id tiebreak is what makes `OFFSET` safe: SQL leaves the order of equal keys undefined, so
 * without it two pages of the same ranking could omit a row or return it twice.
 */
function sqlScoredPages(store: StoreHandle, where: string[], args: unknown[], vector: number[]): RankedPage {
  const encoded = encodeVector(vector);
  const guarded = [
    ...where,
    'e.dimensions = ?',
    `(typeof(e.vector) = 'text' OR length(e.vector) = ?)`,
  ];
  return async (offset, size) => {
    const rows = await store.client.execute({
      sql: `SELECT e.knowledge_item_id AS id, 1 - vector_distance_cos(e.vector, ?) AS score
            FROM knowledge_embeddings e
            JOIN knowledge_items i ON i.id = e.knowledge_item_id
            WHERE ${guarded.join(' AND ')}
            ORDER BY score DESC, e.knowledge_item_id
            LIMIT ? OFFSET ?`,
      args: [encoded, ...args, vector.length, vector.length * 4, size, offset] as any[],
    });
    const page: Array<{ id: string; score: number }> = [];
    for (const row of rows.rows) {
      const score = Number((row as any).score);
      if (!(score > 0)) continue;
      page.push({ id: String((row as any).id), score });
    }
    return page;
  };
}

/**
 * The safety net: fetch every vector, decode and score in JavaScript, exactly as this module
 * did before SQLite could do it.
 *
 * Reached only when the SQL scan raises, which it does for a stored value libSQL cannot parse
 * as a vector -- a truncated write, a hand-edited row. `decodeVector` returns null for those
 * and the row is skipped, so one unreadable row costs its own visibility instead of every
 * search on the store.
 *
 * Scored once, then served as slices, so paging costs nothing extra.
 */
async function decodedPages(
  store: StoreHandle,
  where: string[],
  args: unknown[],
  vector: number[],
  queryMagnitude: number,
): Promise<RankedPage> {
  const rows = await store.client.execute({
    sql: `SELECT e.knowledge_item_id AS id, e.vector AS vector
          FROM knowledge_embeddings e
          JOIN knowledge_items i ON i.id = e.knowledge_item_id
          WHERE ${where.join(' AND ')}`,
    args: args as any[],
  });

  const scored: Array<{ id: string; score: number }> = [];
  for (const row of rows.rows) {
    const stored = decodeVector((row as any).vector);
    if (!stored) continue;
    const score = cosineWithKnownMagnitude(vector, queryMagnitude, stored);
    if (score <= 0) continue;
    scored.push({ id: String((row as any).id), score });
  }
  scored.sort((left, right) => right.score - left.score);
  return async (offset, size) => scored.slice(offset, offset + size);
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
    // never be returned are never scanned, decoded or scored.
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
    // A superset of the tag filter, in SQL, so the page the database ranks is nearly the page
    // that survives. Same predicate and same reasoning as the lexical path's `tagPredicates`:
    // the surrounding quotes make `"a"` unable to match `["ab"]`, it matches the double-encoded
    // legacy rows too, and the exact check against the parsed array still runs below -- this
    // narrows, it never decides. Without it, `ORDER BY ... LIMIT` in SQL would hand back a page
    // that the tag filter could empty, and the walk below would keep asking for another.
    for (const tag of options.tags ?? []) {
      where.push('i.tags LIKE ?');
      args.push(`%"${tag}"%`);
    }
    // Provider and model are not sufficient: dtype and pooling change the numbers a
    // model emits, so a row written under a different one is not comparable even
    // though its provider and model match. Applied unconditionally -- an empty
    // fingerprint matches the rows that have none rather than matching everything.
    where.push('e.profile_fingerprint = ?');
    args.push(options.profileFingerprint);

    const queryMagnitude = magnitude(options.vector);
    if (queryMagnitude === 0) return [];

    // Walk the ranking in pages and stop as soon as enough survive the filters. Only the
    // highest-scoring candidates are ever materialised, instead of every row in the table.
    const walk = async (nextPage: RankedPage): Promise<VectorSearchResult[]> => {
      const results: VectorSearchResult[] = [];
      const pageSize = Math.max(limit * 4, 32);
      for (let start = 0; results.length < limit; start += pageSize) {
        const page = await nextPage(start, pageSize);
        if (page.length === 0) break;
        // Hydrated from the store the ids came from -- same reason as the FTS path. The
        // ambient handle would return nothing for a peer, or the wrong row on a collision.
        const items = await getKnowledgeItems(page.map(candidate => candidate.id), store.db);
        for (const candidate of page) {
          const item = items.get(candidate.id);
          if (!item) continue;
          // Status, category and visibility were applied in SQL, and the tag predicate above is
          // a superset -- this is the exact check against the parsed array.
          if (options.tags && options.tags.length > 0) {
            if (!item.tags || !options.tags.every(tag => item.tags!.includes(tag))) continue;
          }
          results.push({ item, score: candidate.score });
          if (results.length >= limit) break;
        }
        if (page.length < pageSize) break;
      }
      return results;
    };

    const decoded = () => decodedPages(store, where, args, options.vector, queryMagnitude);
    if (jsScanOnly.has(store.client)) return await walk(await decoded());

    try {
      return await walk(sqlScoredPages(store, where, args, options.vector));
    } catch (scoringError) {
      // Retry once through the decoder. Every error is retried rather than only the ones whose
      // message names a vector, because matching on message text is a guess; if the cause was
      // not the scoring, the JavaScript scan raises too and that error is the one reported.
      const results = await walk(await decoded()).catch(() => { throw scoringError; });
      // Only now is it a fact about the data: SQL could not score these rows and JavaScript
      // could. Remembered so the next search on this connection does not repeat the failure.
      jsScanOnly.add(store.client);
      return results;
    }
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

