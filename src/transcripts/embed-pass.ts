import type { Client } from '@libsql/client';
import type { KnowledgeEmbedder } from '../store/vector-index.js';
import { withWriteRetry } from './database.js';
import { quantizeVector } from './quantize.js';
import { readMessagesAt } from './read.js';

/** Messages per embedding call. The provider re-batches by text length underneath. */
const EMBED_BATCH = 32;

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

    for (let start = 0; start < targets.length; start += EMBED_BATCH) {
      const slice = targets.slice(start, start + EMBED_BATCH);
      embedded += await embedBatch(dbPath, embedder, slice);
      if (input.deadline !== undefined && Date.now() >= input.deadline) {
        return { embedded, complete: false };
      }
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
  const vectors = await embedder.embed(targets.map(target => target.text));

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
