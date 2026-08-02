import { getClient } from './database.js';
import { normalizeProjectDir } from './transcript-index.js';

// Semantic retrieval over the WHOLE transcript archive, not just what keyword
// search already found.
//
// Re-ranking a lexical shortlist can only reorder what BM25 surfaced, so the
// case it cannot serve is the one that matters most: the words you remember are
// not the words that were used. That message is never in the shortlist, so no
// amount of re-ranking reaches it. Fixing that means every message must carry a
// vector, and every query must be able to score all of them.
//
// The cost of that is storage and scan time, which is why the vectors are
// quantized rather than stored as float32 - see quantize().

/** Supplied by the caller, so this module never depends on how embeddings are configured. */
export interface TranscriptEmbedder {
  model: string;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Components of an L2-normalised vector are small - energy is spread over every
 * dimension, so RMS is 1/sqrt(dims) - and int8 spends its resolution on the
 * range it is told to expect. Clipping at ~6 sigma keeps almost everything and
 * quantizes the rest finely.
 *
 * Checked against the real thing: for 384-dim bge-small this gives 0.306, while
 * the corpus measured a largest component of 0.327 and a 99.9th percentile of
 * 0.262. So a handful of components clip, which measurement says is the good
 * trade - on our own eval corpus int8 at this scale scored MRR 0.668 against
 * float32's 0.662, i.e. no loss at 4x smaller.
 */
function scaleFor(dims: number): number {
  return 6 / Math.sqrt(dims);
}

/**
 * float32 -> int8, one byte per dimension.
 *
 * Measured on 350 project atoms with 17 recall queries, against the float32
 * reference (MRR 0.662):
 *   int8    MRR 0.668  - 27 MB for our 69k messages, 36 ms to scan all of them
 *   binary  MRR 0.310  - 3.3 MB and 5 ms, but the ranking falls apart
 * The published binary-quantization results are far kinder than that, but they
 * are measured on 1024-dim models; at 384 dims one sign bit per dimension is
 * not enough information. Binary is only usable with a float32 rescoring pass,
 * which means storing the float32 vectors too - 4x the disk to make up for the
 * loss of quality it caused. int8 needs no rescoring stage at all.
 */
export function quantize(vector: number[]): Uint8Array {
  const scale = scaleFor(vector.length);
  const out = new Int8Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    const scaled = Math.round((vector[i] / scale) * 127);
    out[i] = scaled > 127 ? 127 : scaled < -127 ? -127 : scaled;
  }
  return new Uint8Array(out.buffer);
}

/**
 * Dot product of two quantized vectors. Both sides carry the same constant
 * scale factor, and every candidate is scored against the same query, so the
 * factor is never divided out: it is a ranking, not a similarity anyone reads.
 */
function score(query: Int8Array, doc: Int8Array): number {
  let dot = 0;
  const n = query.length < doc.length ? query.length : doc.length;
  for (let i = 0; i < n; i++) dot += query[i] * doc[i];
  return dot;
}

function asInt8(value: unknown): Int8Array | null {
  if (value instanceof Uint8Array) return new Int8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Int8Array(value);
  return null;
}

/** Clip per message. Matches what the model can read anyway: 512 word-pieces is roughly this. */
const EMBED_TEXT_CHARS = 2_000;

/**
 * Rows claimed per pass, and the size of one write transaction. NOT the embed
 * batch size — see below for why those are deliberately different.
 */
const EMBED_BATCH = 16;

/** Vectors held in memory at once while scanning. */
const SCAN_PAGE = 5_000;

/**
 * Embed messages that have no vector for this model yet.
 *
 * Newest first: a cold archive becomes useful for recent history immediately,
 * which is what questions are usually about. Resumable by construction - the
 * work left is "rows with no row in transcript_embeddings", so an interrupted
 * pass leaves no state to repair.
 */
export async function embedTranscripts(
  rawProjectDir: string,
  embedder: TranscriptEmbedder,
  options: { budgetMs?: number; onProgress?: (done: number, remaining: number) => void } = {},
): Promise<{ embedded: number; remaining: number; ms: number; complete: boolean }> {
  const projectDir = normalizeProjectDir(rawProjectDir);
  const { budgetMs = 60_000, onProgress } = options;
  const client = getClient();
  const started = Date.now();
  const deadline = started + budgetMs;
  let embedded = 0;
  // Counted once and then tracked, not re-counted per batch. The count is a
  // LEFT JOIN over every message in the project; running it after each batch of
  // 16 meant thousands of full scans across a backfill, interleaved with the
  // writes they were reporting on - which is how the first long run died on
  // "cannot commit transaction - SQL statements in progress".
  let remaining = await countPending(projectDir, embedder.model);

  // Vectors from a model no longer in use are unreachable - every read filters
  // on the active model - and there is now one per message rather than one per
  // re-ranked candidate, so leaving them behind means carrying a full dead copy
  // of the archive for every model ever configured.
  await client.execute({ sql: 'DELETE FROM transcript_embeddings WHERE model <> ?', args: [embedder.model] });

  for (;;) {
    const rows = (await client.execute({
      sql: `SELECT m.id, m.text FROM transcript_messages m
            LEFT JOIN transcript_embeddings e ON e.message_id = m.id AND e.model = ?
            WHERE m.project_dir = ? AND e.message_id IS NULL
            ORDER BY m.id DESC
            LIMIT ?`,
      args: [embedder.model, projectDir, EMBED_BATCH],
    })).rows;
    if (rows.length === 0) break;

    // Read and written in batches; the embedder handles them one forward pass
    // at a time, because batching variable-length text costs more than it saves
    // (see createLocalEmbeddingProvider). Database round trips still batch,
    // because those genuinely do amortize.
    const vectors = await embedder.embed(rows.map(row => String(row.text).slice(0, EMBED_TEXT_CHARS)));
    const statements = [];
    for (let i = 0; i < rows.length; i++) {
      const vector = vectors[i];
      if (!vector || vector.length === 0) continue;
      statements.push({
        sql: 'INSERT OR REPLACE INTO transcript_embeddings (message_id, model, vector) VALUES (?, ?, ?)',
        args: [Number(rows[i].id), embedder.model, quantize(vector)],
      });
    }
    // Retried on BUSY for the same reason indexing is: a backfill runs for
    // tens of minutes beside live sessions writing to the same database, and
    // losing the whole pass to one transient lock is the difference between a
    // job that finishes and one that has to be babysat.
    for (let attempt = 0; statements.length > 0; attempt++) {
      try {
        await client.batch(statements, 'write');
        break;
      } catch (error) {
        const busy = /SQLITE_BUSY|statements in progress/i.test(String((error as Error).message));
        if (!busy || attempt >= 5) throw error;
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    embedded += statements.length;
    remaining -= statements.length;
    onProgress?.(embedded, remaining);
    // Checked after a batch, never before one. A pass that returns having done
    // nothing is indistinguishable from a broken one, and on a slow machine a
    // small budget would starve forever - so the floor is one batch, and the
    // budget bounds how many more.
    if (Date.now() > deadline) break;
  }

  const left = await countPending(projectDir, embedder.model);
  return { embedded, remaining: left, ms: Date.now() - started, complete: left === 0 };
}

async function countPending(projectDir: string, model: string): Promise<number> {
  // Callers inside this module already normalized; kept as a plain parameter.
  const row = (await getClient().execute({
    sql: `SELECT COUNT(*) AS n FROM transcript_messages m
          LEFT JOIN transcript_embeddings e ON e.message_id = m.id AND e.model = ?
          WHERE m.project_dir = ? AND e.message_id IS NULL`,
    args: [model, projectDir],
  })).rows[0];
  return Number(row.n);
}

export async function transcriptVectorStats(rawProjectDir: string, model: string): Promise<{ embedded: number; total: number }> {
  const projectDir = normalizeProjectDir(rawProjectDir);
  const client = getClient();
  const row = (await client.execute({
    sql: `SELECT COUNT(*) AS total,
                 COUNT(e.message_id) AS embedded
          FROM transcript_messages m
          LEFT JOIN transcript_embeddings e ON e.message_id = m.id AND e.model = ?
          WHERE m.project_dir = ?`,
    args: [model, projectDir],
  })).rows[0];
  return { embedded: Number(row.embedded), total: Number(row.total) };
}

/**
 * Rank every embedded message in the project against the query vector.
 *
 * A brute-force scan, deliberately. An approximate index (HNSW, IVF) buys speed
 * this does not need: 27 MB of int8 scores in tens of milliseconds, which is
 * noise next to the model call that produced the query vector. It also costs
 * nothing to keep correct - no rebuilds, no recall knobs, no native extension
 * that has to load inside whatever SQLite build the host happens to have.
 */
export async function semanticCandidates(
  rawProjectDir: string,
  queryVector: number[],
  model: string,
  depth: number,
  sessionId?: string,
): Promise<Array<{ messageId: number; score: number }>> {
  const projectDir = normalizeProjectDir(rawProjectDir);
  const client = getClient();
  const query = new Int8Array(quantize(queryVector).buffer);
  const scored: Array<{ messageId: number; score: number }> = [];

  // Paged by id rather than read in one go. The vectors themselves are tens of
  // megabytes, but the row objects wrapping them are the larger cost, and
  // materialising all of them at once is a spike inside a process that also has
  // to serve a live session. Keyset paging, not OFFSET, so each page is a seek.
  let after = 0;
  for (;;) {
    const rows = (await client.execute({
      sql: `SELECT e.message_id AS id, e.vector AS vector
            FROM transcript_embeddings e
            JOIN transcript_messages m ON m.id = e.message_id
            WHERE e.model = ? AND m.project_dir = ? AND e.message_id > ?${sessionId ? ' AND m.session_id LIKE ?' : ''}
            ORDER BY e.message_id
            LIMIT ${SCAN_PAGE}`,
      args: sessionId ? [model, projectDir, after, `${sessionId}%`] : [model, projectDir, after],
    })).rows;
    if (rows.length === 0) break;

    for (const row of rows) {
      after = Number(row.id);
      const vector = asInt8(row.vector);
      // Rows written by an older build stored JSON text under the same column.
      // They are a cache, so an unreadable one is skipped, not repaired.
      if (!vector || vector.length !== query.length) continue;
      scored.push({ messageId: after, score: score(query, vector) });
    }
    if (rows.length < SCAN_PAGE) break;
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, depth);
}
