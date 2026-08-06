import type { Client } from '@libsql/client';
import type { KnowledgeEmbedder } from '../store/vector-index.js';
import { withWriteRetry } from './database.js';
import { quantizeVector } from './quantize.js';
import { readMessagesAt } from './read.js';

/**
 * Ceiling on messages per embedding call.
 *
 * A work unit, not a batch shape. Each message gets a forward pass of its own (see
 * `embedBatch`), so this bounds how much work one deadline check covers and how many rows one
 * write transaction carries -- it no longer decides which messages are embedded together,
 * because nothing does.
 */
const EMBED_BATCH = 32;

/**
 * Starting estimate of how many characters the model gets through per millisecond.
 *
 * Deliberately pessimistic, and measured rather than guessed: one real 8,000-character message
 * costs 7,843 ms in a single forward pass on this machine's local model, so about one character
 * per millisecond. A short-lived hook process gets exactly one chance to be wrong about this,
 * so being wrong in the direction of doing less work is the safe side.
 */
const INITIAL_CHARS_PER_MS = 1;

/**
 * How much of the new observation replaces the old estimate, per batch.
 *
 * The rate is learned within a pass because it varies by an order of magnitude between machines
 * and models, and the first batch of a backfill would otherwise hold the whole run to a
 * pessimistic default.
 */
const RATE_SMOOTHING = 0.5;

/**
 * The next batch, sized to what the remaining budget can pay for.
 *
 * Returns an empty slice when not even one message fits, which is the deadline being enforced
 * rather than observed. A batch of 32 arbitrary-length messages is unbounded work, and checking
 * the clock after it is not a budget -- it is a record of how far past the budget the call went.
 * Nothing is refused when there is no deadline, so the backfill still does the long messages.
 */
function affordableSlice(
  targets: Array<{ id: number; text: string }>,
  start: number,
  budgetChars: number,
): Array<{ id: number; text: string }> {
  const slice: Array<{ id: number; text: string }> = [];
  let chars = 0;

  for (let i = start; i < targets.length && slice.length < EMBED_BATCH; i++) {
    const next = targets[i];
    // The first message is what decides whether any work happens at all: if even it is
    // unaffordable the pass stops, and a bigger budget (the backfill's) picks it up.
    if (chars + next.text.length > budgetChars && slice.length > 0) break;
    if (chars + next.text.length > budgetChars && slice.length === 0) return [];
    slice.push(next);
    chars += next.text.length;
  }

  return slice;
}

/**
 * Give every indexed message a vector under the embedder's current profile.
 *
 * Resumable by construction: "messages with no vector for this fingerprint" *is* the resume
 * state, so an interrupted pass leaves no bookkeeping to repair.
 *
 * **Grouped by source file, not newest-first.** Reading each message individually re-reads its
 * whole transcript: at ~3 MB per file and 3,717 messages that is roughly 11 GB of I/O for one
 * backfill, and it makes the deadline unenforceable because a single batch can take seconds.
 * Selecting a file's pending messages together turns that into one streaming pass per file.
 * Files are taken newest-message-first so the session you are in is covered before the tail.
 *
 * **The deadline is enforced before the work, not after it.** Embedding cost is driven by text
 * length, and a fixed batch count is therefore unbounded work: 32 messages of 8,000 characters
 * is minutes on the local model, against a hook budget of 1,500 ms. Each slice is sized to the
 * remaining budget at a learned characters-per-millisecond rate, and a slice that cannot be
 * afforded is not started -- the rows stay pending for a run that has the time.
 *
 * **What that budget may decide, and what it may not.** It decides how much work a pass takes
 * on. It does not decide what a vector is: every message is embedded in a forward pass of its
 * own, so the same message gets the same vector on a busy pass and a quiet one, and a reindex
 * reproduces what the hook wrote rather than quietly replacing it. See `embedBatch`.
 */
export async function embedPendingMessages(input: {
  /**
   * The database path, not a client. `withWriteRetry` reopens the cached connection on
   * SQLITE_BUSY_SNAPSHOT, so a handle captured for the length of a backfill would be a closed
   * one after the first recovery.
   */
  dbPath: string;
  embedder: KnowledgeEmbedder;
  /** `Date.now()` value after which the pass stops between batches. */
  deadline?: number;
}): Promise<{ embedded: number; complete: boolean }> {
  const { dbPath, embedder } = input;
  const read = <T>(run: (client: Client) => Promise<T>) => withWriteRetry(dbPath, run);

  // Vectors from a superseded model are a full dead duplicate of the archive, not a few stale
  // rows -- there is one vector per message, not per re-ranked candidate.
  await read(client => client.execute({
    sql: 'DELETE FROM transcript_vectors WHERE fingerprint <> ?',
    args: [embedder.profileFingerprint],
  }));

  let embedded = 0;
  /** Learned within the pass; see `INITIAL_CHARS_PER_MS`. */
  let charsPerMs = INITIAL_CHARS_PER_MS;
  /**
   * Files whose pending rows turned out to be unreadable. Without this the loop re-selects the
   * same file forever: its rows stay pending because there is nothing to embed them from.
   */
  const unreadable = new Set<string>();

  for (;;) {
    if (input.deadline !== undefined && Date.now() >= input.deadline) {
      return { embedded, complete: false };
    }

    // The file holding the newest unembedded message, and every pending message in it. One
    // file per round keeps the read to a single pass while still making progress newest-first.
    const skip = [...unreadable];
    const exclude = skip.length ? ` AND m.path NOT IN (${skip.map(() => '?').join(', ')})` : '';
    const nextFile = await read(async client => (await client.execute({
      sql: `SELECT m.path
            FROM transcript_messages m
            LEFT JOIN transcript_vectors v ON v.message_id = m.id
            WHERE v.message_id IS NULL${exclude}
            ORDER BY m.id DESC
            LIMIT 1`,
      args: skip as never[],
    })).rows[0]);

    // Nothing left that can be embedded. Incomplete when rows were skipped as unreadable: their
    // transcripts vanished since indexing, and the next index pass is what removes them.
    if (!nextFile) return { embedded, complete: unreadable.size === 0 };

    const filePath = String(nextFile.path);
    const pending = await read(async client => (await client.execute({
      sql: `SELECT m.id, m.line
            FROM transcript_messages m
            LEFT JOIN transcript_vectors v ON v.message_id = m.id
            WHERE v.message_id IS NULL AND m.path = ?
            ORDER BY m.line ASC`,
      args: [filePath],
    })).rows);

    const bodies = await readMessagesAt(filePath, pending.map(row => Number(row.line)));

    const targets: Array<{ id: number; text: string }> = [];
    for (const row of pending) {
      const excerpt = bodies.get(Number(row.line));
      // A pointer whose file vanished cannot be embedded. Leave it; the next index pass
      // removes the row entirely.
      if (excerpt) targets.push({ id: Number(row.id), text: excerpt.text });
    }

    if (targets.length === 0) {
      // Nothing readable in this file -- its rows are dead pointers. Marking them with a
      // zero-length vector would corrupt ranking, so skip the file and keep going: other files
      // may still have work, and one dead transcript must not strand the rest of the archive.
      unreadable.add(filePath);
      continue;
    }

    for (let start = 0; start < targets.length;) {
      const remainingMs = input.deadline === undefined ? Infinity : input.deadline - Date.now();
      if (remainingMs <= 0) return { embedded, complete: false };

      const slice = affordableSlice(targets, start, remainingMs * charsPerMs);
      // Nothing the budget can pay for. Stopping here is what makes the budget real; the rows
      // stay pending and `knowl reindex --transcripts` has minutes rather than milliseconds.
      if (slice.length === 0) return { embedded, complete: false };

      const chars = slice.reduce((total, target) => total + target.text.length, 0);
      const startedAt = Date.now();
      embedded += await embedBatch(dbPath, embedder, slice);
      const elapsed = Date.now() - startedAt;
      // Learned from what actually happened, so a fast machine is not held to the pessimistic
      // default for a whole backfill and a slow one stops overrunning after the first batch.
      if (elapsed > 0) {
        charsPerMs = charsPerMs * (1 - RATE_SMOOTHING) + (chars / elapsed) * RATE_SMOOTHING;
      }

      start += slice.length;
    }
  }
}

async function embedBatch(
  dbPath: string,
  embedder: KnowledgeEmbedder,
  targets: Array<{ id: number; text: string }>,
): Promise<number> {
  // Embedding happens outside the retry: it is the expensive part and it touches no database,
  // so a contended write must not pay for a second forward pass.
  //
  // One message per forward pass. The q8 graph quantises activations per PASS -- arctic's
  // `model_quantized.onnx` holds 48 `DynamicQuantizeLinear` nodes, and that operator derives a
  // single scalar scale from `max(x)`/`min(x)` over the whole tensor, batch dimension included
  // -- so without this a message's vector depends on which other messages shared its pass, and
  // that was decided by whatever was left of the catch-up deadline. The same archive embedded
  // by an unbudgeted `reindex --transcripts` and by a 1,500 ms hook disagreed on 651 of 956
  // real messages, and the shipped ranker then returned a different top-5 MEMBERSHIP for 83 of
  // 194 real queries (42.8%), a different top hit for 19 (9.8%). Store A ranked against itself
  // over the same queries differed for none.
  //
  // Measured free on this path, contrary to the ~2.7x this file used to be excused by -- that
  // figure came from synthetic items of ~45 tokens. Real messages are p50 169 characters but
  // p90 1,980 and p99 10,005, and attention cost is superlinear in length, so the long tail is
  // most of the wall clock and is already alone in its batch either way: 400 representative
  // messages cost 575.1 s batched against 535.6 s one at a time (0.93x). Even on a queue of
  // nothing but short messages -- where batching is designed to win -- the two are inside each
  // other's spread: one 1,500 ms hook gets a mean 13.5 messages through one at a time against
  // 16.0 batched, and one 1,000 ms search top-up 17.3 against 15.2, the other way round. A turn
  // does not append thirteen messages, so K-65's budget is not what this trades against.
  //
  // See `EmbedOptions`. The atom path takes the same option for the same reason (K-71).
  const vectors = await embedder.embed(targets.map(target => target.text), { maxBatch: 1 });

  return withWriteRetry(dbPath, async client => embedVectorBatch(client, embedder, targets, vectors));
}

async function embedVectorBatch(
  client: Client,
  embedder: KnowledgeEmbedder,
  targets: Array<{ id: number; text: string }>,
  vectors: number[][],
): Promise<number> {
  let embedded = 0;

  await client.execute('BEGIN IMMEDIATE');
  try {
    for (let i = 0; i < targets.length; i++) {
      const vector = vectors[i];
      if (!vector || vector.length === 0) continue;
      const { scale, bytes } = quantizeVector(vector);
      await client.execute({
        sql: `INSERT INTO transcript_vectors (message_id, fingerprint, dims, scale, vec)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(message_id) DO UPDATE SET
                fingerprint = excluded.fingerprint, dims = excluded.dims,
                scale = excluded.scale, vec = excluded.vec`,
        args: [targets[i].id, embedder.profileFingerprint, vector.length, scale, bytes],
      });
      embedded++;
    }
    await client.execute('COMMIT');
  } catch (error) {
    await client.execute('ROLLBACK').catch(() => {});
    throw error;
  }

  return embedded;
}
