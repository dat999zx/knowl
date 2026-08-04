import type { Client } from '@libsql/client';
import { withWriteRetry } from './database.js';
import { describesSameMessage, streamProseFrom } from './parse.js';

/**
 * Fill in `byte_offset` for rows indexed before that column existed.
 *
 * K-47 made reading a hit a seek instead of a scan -- 218 ms and 15.8 MB of I/O down to 3.8 ms
 * and at most a page -- by storing where each message begins. Every row already in an index was
 * left without one, and nothing would ever go back for them: a file that is already up to date is
 * skipped by the pass, so its rows keep a null offset and every hit on them takes the old
 * streaming scan for ever. Two of the three indexes on the machine this was written on are in
 * exactly that state. A shipped speedup that only reaches new rows is a speedup nobody gets.
 *
 * Enrichment, not repair, and the difference is what makes this safe to do a little at a time:
 * a null offset is already correct (the reader falls back to a scan), so a partial, interrupted
 * or abandoned backfill costs time and never truth. It only ever UPDATEs one column -- no row is
 * inserted, deleted or re-embedded, because where a message sits in a file says nothing about
 * what the message is.
 */

/** Rows per write transaction, and the granularity at which a deadline is honoured. */
const WRITE_BATCH = 200;

const expired = (deadline?: number) => deadline !== undefined && Date.now() >= deadline;

/**
 * Where to start reading a file to fill in its missing offsets, or null when none are missing.
 *
 * The resume state is the data: the first line with no offset is what is left to do, and the
 * nearest filled line before it says where that work starts. Nothing extra is recorded, and an
 * interrupted backfill resumes where it stopped rather than re-reading from byte zero -- which
 * for a 205 MB transcript is the difference between a backfill and an archive re-read.
 *
 * The line numbering is one *behind* the anchor row, because `streamProseFrom` continues
 * numbering from what it is given: starting at line 4's first byte with `startLine: 3` makes the
 * first line it completes line 4 again. That row is re-parsed and skipped, which is the price of
 * not storing a separate cursor.
 */
export async function offsetResumePoint(
  client: Client,
  filePath: string,
): Promise<{ startByte: number; startLine: number } | null> {
  const missing = (await client.execute({
    sql: 'SELECT MIN(line) AS line FROM transcript_messages WHERE path = ? AND byte_offset IS NULL',
    args: [filePath],
  })).rows[0]?.line;
  if (missing === null || missing === undefined) return null;

  const anchor = (await client.execute({
    sql: `SELECT line, byte_offset FROM transcript_messages
          WHERE path = ? AND line < ? AND byte_offset IS NOT NULL
          ORDER BY line DESC LIMIT 1`,
    args: [filePath, Number(missing)],
  })).rows[0];

  if (!anchor) return { startByte: 0, startLine: 0 };
  return { startByte: Number(anchor.byte_offset), startLine: Number(anchor.line) - 1 };
}

/** The next transcript with un-filled rows, in path order from `after`. */
async function nextPathNeedingOffsets(dbPath: string, after: string): Promise<string | null> {
  const row = await withWriteRetry(dbPath, async client => (await client.execute({
    // Ordered so the cursor can advance past a file this pass could not fill, which is also what
    // stops an unfillable one being retried forever inside a single pass.
    sql: `SELECT path FROM transcript_messages
          WHERE byte_offset IS NULL AND path > ?
          ORDER BY path LIMIT 1`,
    args: [after],
  })).rows[0]);
  return row ? String(row.path) : null;
}

/** Write one batch of offsets. */
async function commitOffsets(
  dbPath: string,
  filePath: string,
  batch: { line: number; byteOffset: number }[],
): Promise<number> {
  return withWriteRetry(dbPath, async client => {
    let filled = 0;
    await client.execute('BEGIN IMMEDIATE');
    try {
      for (const { line, byteOffset } of batch) {
        // `IS NULL` guarded, so a row another writer has since filled -- or replaced, offset and
        // all, by a rebuild -- is left as it is rather than overwritten from this older read.
        const result = await client.execute({
          sql: 'UPDATE transcript_messages SET byte_offset = ? WHERE path = ? AND line = ? AND byte_offset IS NULL',
          args: [byteOffset, filePath, line],
        });
        filled += Number(result.rowsAffected);
      }
      await client.execute('COMMIT');
      return filled;
    } catch (error) {
      await client.execute('ROLLBACK').catch(() => {});
      throw error;
    }
  });
}

/**
 * Fill what one transcript is missing, from its resume point to the end of the file.
 *
 * `complete: false` means the deadline stopped it, not that anything failed.
 */
async function fillOneFile(
  dbPath: string,
  filePath: string,
  deadline?: number,
  guaranteeFirstBatch = false,
): Promise<{ filled: number; complete: boolean }> {
  const resume = await withWriteRetry(dbPath, client => offsetResumePoint(client, filePath));
  if (!resume) return { filled: 0, complete: true };

  // What each un-filled row claims to be, so an offset is only written for a line that still
  // holds that message. Bounded by one transcript's prose messages -- the largest on this
  // machine is 205 MB of transcript, of which prose is 2.7%.
  const wanted = new Map<number, { role: unknown; chars: unknown; ts: unknown }>(
    (await withWriteRetry(dbPath, async client => (await client.execute({
      sql: 'SELECT line, role, chars, ts FROM transcript_messages WHERE path = ? AND byte_offset IS NULL',
      args: [filePath],
    })).rows)).map(row => [Number(row.line), { role: row.role, chars: row.chars, ts: row.ts }]),
  );

  let filled = 0;
  let batch: { line: number; byteOffset: number }[] = [];

  // A file that has been deleted or is unreadable yields nothing and is simply left for a later
  // pass -- the sweep in `runIndexPass` is what reclaims a dead pointer, not this.
  for await (const chunk of streamProseFrom(filePath, resume.startByte, resume.startLine)) {
    const row = wanted.get(chunk.message.line);
    if (!row) continue;

    // The file is not what the index describes. The pass rebuilds a diverged file before this
    // runs, so this is the racy remainder -- and an offset pointing at a line that now holds
    // something else would resolve a hit to the wrong body, which nothing downstream could tell.
    // Leaving the row null keeps it correct and merely slow.
    if (!describesSameMessage(row, chunk.message)) break;

    batch.push({ line: chunk.message.line, byteOffset: chunk.byteOffset });
    if (batch.length < WRITE_BATCH) continue;

    filled += await commitOffsets(dbPath, filePath, batch);
    batch = [];
    // Between committed batches, so stopping is always at a point the resume point can find.
    // The first-batch guarantee is spent the moment anything commits: from here the deadline
    // is exact again.
    if (expired(deadline) && !(guaranteeFirstBatch && filled === 0)) return { filled, complete: false };
  }

  if (batch.length > 0) filled += await commitOffsets(dbPath, filePath, batch);
  return { filled, complete: true };
}

/**
 * Fill missing offsets across the whole index, oldest path first, until the deadline.
 *
 * Called at the end of an index pass with whatever budget is left, and only once the pass has
 * caught up: a session still being written to needs its latest turns findable more than a
 * finished one needs a faster seek.
 */
export async function fillMissingByteOffsets(input: {
  dbPath: string;
  deadline?: number;
  /** Whether the deadline was real when the OWNING PASS started, not when this call is made. */
  budgetWasReal?: boolean;
}): Promise<{ filled: number; complete: boolean }> {
  let filled = 0;
  let cursor = '';

  // The same guarantee `runIndexPass` carries (index-pass.ts, K-65): a budget that was real
  // when the pass started buys at least one batch of work here, even though indexing has
  // usually consumed it by the time this runs. Without this, the expiry test below ran BEFORE
  // the first file, so on a busy machine the backfill was starved forever -- 0 rows, pass
  // after pass, each one reporting an honest `complete: false` and doing nothing. The verdict
  // is the CALLER'S, taken at pass start: computed here it would read "already spent" under
  // exactly the load that causes the starvation. A deadline already in the past when the pass
  // began is still obeyed exactly. The overrun is bounded to one WRITE_BATCH (~200 rows,
  // ~110 ms), the same bound the index pass accepts and for the same reason: enrichment that
  // never starts is worse than a bounded overrun on a path whose partial results are always
  // correct.
  const budgeted = input.budgetWasReal === true;

  for (;;) {
    if (expired(input.deadline) && !(budgeted && filled === 0)) return { filled, complete: false };

    const next = await nextPathNeedingOffsets(input.dbPath, cursor);
    if (next === null) return { filled, complete: true };

    const outcome = await fillOneFile(input.dbPath, next, input.deadline, budgeted && filled === 0);
    filled += outcome.filled;
    if (!outcome.complete) return { filled, complete: false };
    cursor = next;
  }
}
