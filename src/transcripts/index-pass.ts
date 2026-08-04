import fs from 'node:fs/promises';
import type { Client } from '@libsql/client';
import { openTranscriptDb, withWriteRetry } from './database.js';
import { NAME_KIND, readOpeningAsk, streamProseFrom, type ProseChunk } from './parse.js';
import { defaultProjectsDir, scanTranscriptArchive, type TranscriptFile } from './paths.js';

/** Whether the transcript archive can be listed at all, as opposed to being empty. */
async function readableDir(target: string): Promise<boolean> {
  return fs.readdir(target).then(() => true, () => false);
}

export type IndexPassResult = {
  indexed: number;
  rebuilt: number;
  removed: number;
  filesTouched: number;
  /** False when a deadline cut the pass short. The watermarks are still valid; just resume. */
  complete: boolean;
};

/** Rows per write transaction. Small on purpose: a long transaction starves a live session. */
const WRITE_BATCH = 200;

type FileState = {
  bytesIndexed: number;
  linesIndexed: number;
  sizeAtIndex: number;
  displayName: string | null;
  nameKind: number;
  opening: string | null;
};

/** What the file row currently says about the session's name and opening ask. */
export type SessionNamingState = {
  displayName: string | null;
  nameKind: number;
  opening: string | null;
};

async function readFileState(dbPath: string, filePath: string): Promise<FileState | null> {
  const rows = await withWriteRetry(dbPath, async client => (await client.execute({
    sql: `SELECT bytes_indexed, lines_indexed, size_at_index, display_name, name_kind, opening
          FROM transcript_files WHERE path = ?`,
    args: [filePath],
  })).rows);
  if (rows.length === 0) return null;
  return {
    bytesIndexed: Number(rows[0].bytes_indexed),
    linesIndexed: Number(rows[0].lines_indexed),
    sizeAtIndex: Number(rows[0].size_at_index),
    displayName: rows[0].display_name === null ? null : String(rows[0].display_name),
    nameKind: Number(rows[0].name_kind ?? NAME_KIND.none),
    opening: rows[0].opening === null ? null : String(rows[0].opening),
  };
}

/**
 * Delete a file's rows from every table.
 *
 * The FTS delete is driven off the message ids rather than a join, because a contentless FTS5
 * table cannot be queried by anything but rowid and MATCH.
 */
async function dropFileRows(dbPath: string, filePath: string): Promise<void> {
  const ids = await withWriteRetry(dbPath, async client => (await client.execute({
    sql: 'SELECT id FROM transcript_messages WHERE path = ?',
    args: [filePath],
  })).rows.map(row => Number(row.id)));

  for (let start = 0; start < ids.length; start += WRITE_BATCH) {
    const slice = ids.slice(start, start + WRITE_BATCH);
    await withWriteRetry(dbPath, async client => {
      await client.execute('BEGIN IMMEDIATE');
      try {
        for (const id of slice) {
          await client.execute({ sql: 'DELETE FROM transcript_fts WHERE rowid = ?', args: [id] });
          await client.execute({ sql: 'DELETE FROM transcript_vectors WHERE message_id = ?', args: [id] });
        }
        await client.execute('COMMIT');
      } catch (error) {
        await client.execute('ROLLBACK').catch(() => {});
        throw error;
      }
    });
  }

  await withWriteRetry(dbPath, client =>
    client.execute({ sql: 'DELETE FROM transcript_messages WHERE path = ?', args: [filePath] }));
}

/**
 * Write one batch of messages and the watermark they justify, in a single transaction.
 *
 * The atomicity is the entire point. Committing rows and then updating `bytes_indexed`
 * separately leaves a window where a crash -- or a killed CLI, or a machine sleeping -- has
 * durable rows behind a stale watermark. The next pass re-reads those lines and dies on
 * `UNIQUE(path, line)`, so the index is not merely stale but unrepairable without manual
 * intervention. "Resumable" has to mean both facts move together or neither does.
 */
/**
 * The naming half of a `transcript_files` upsert.
 *
 * Rank-guarded rather than a plain `excluded` assignment: this process seeds its comparison from
 * the row it read before streaming, so a second writer that captured a higher-ranked name in the
 * meantime would otherwise be overwritten by a stale lower rank. `opening` is first-wins, since
 * a session's opening ask cannot change once it has been seen.
 */
const NAMING_UPSERT = `
              display_name = CASE WHEN excluded.name_kind >= transcript_files.name_kind
                THEN excluded.display_name ELSE transcript_files.display_name END,
              name_kind = MAX(transcript_files.name_kind, excluded.name_kind),
              opening = COALESCE(transcript_files.opening, excluded.opening)`;

async function commitBatch(
  dbPath: string,
  file: TranscriptFile,
  size: number,
  batch: ProseChunk[],
  naming: SessionNamingState,
): Promise<number> {
  return withWriteRetry(dbPath, async client => commitBatchOn(client, file, size, batch, naming));
}

async function commitBatchOn(
  client: Client,
  file: TranscriptFile,
  size: number,
  batch: ProseChunk[],
  naming: SessionNamingState,
): Promise<number> {
  const watermark = batch[batch.length - 1];

  await client.execute('BEGIN IMMEDIATE');
  try {
    // Re-read the watermark *inside* the transaction. The caller read it before streaming, and
    // a second writer -- a hook firing during a backfill -- may have advanced it since. Without
    // this, both parse the same lines and the loser dies on UNIQUE(path, line). BEGIN IMMEDIATE
    // serializes the writes; only this re-read makes them agree on what is left to do.
    const current = (await client.execute({
      sql: 'SELECT lines_indexed FROM transcript_files WHERE path = ?',
      args: [file.path],
    })).rows[0];
    const already = current ? Number(current.lines_indexed) : 0;

    if (already >= watermark.linesConsumed) {
      // Another writer covered this batch entirely.
      await client.execute('COMMIT');
      return 0;
    }

    const fresh = batch.filter(chunk => chunk.message.line > already);

    for (const { message } of fresh) {
      const inserted = await client.execute({
        sql: `INSERT INTO transcript_messages (path, session_id, parent_session_id, line, role, chars, ts)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [file.path, file.sessionId, file.parentSessionId, message.line, message.role, message.text.length, message.timestamp],
      });
      // The FTS rowid is the message id, which is how a hit maps back to a pointer.
      await client.execute({
        sql: 'INSERT INTO transcript_fts(rowid, body) VALUES (?, ?)',
        args: [Number(inserted.lastInsertRowid), message.text],
      });
    }

    await client.execute({
      sql: `INSERT INTO transcript_files (path, session_id, parent_session_id, bytes_indexed, lines_indexed, size_at_index, updated_at, display_name, name_kind, opening)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET
              bytes_indexed = excluded.bytes_indexed,
              lines_indexed = excluded.lines_indexed,
              size_at_index = excluded.size_at_index,
              updated_at = excluded.updated_at,${NAMING_UPSERT}`,
      args: [
        file.path, file.sessionId, file.parentSessionId,
        watermark.bytesConsumed, watermark.linesConsumed, size, new Date().toISOString(),
        naming.displayName, naming.nameKind, naming.opening,
      ],
    });

    await client.execute('COMMIT');
    return fresh.length;
  } catch (error) {
    await client.execute('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function indexOneFile(
  dbPath: string,
  file: TranscriptFile,
  size: number,
  state: FileState | null,
  deadline?: number,
): Promise<{ indexed: number; rebuilt: boolean; complete: boolean }> {
  // A file that shrank was rewritten, not appended to. Its old line numbers no longer point
  // anywhere, so the only safe move is to rebuild it.
  const rewritten = state !== null && size < state.bytesIndexed;
  if (rewritten) {
    await dropFileRows(dbPath, file.path);
    // Reset the watermark with the rows it described. Dropping one without the other is not a
    // half-measure, it is silent data loss: `commitBatchOn` re-reads the watermark and skips
    // any batch already covered by it, so a stale one suppresses every row the rebuild
    // re-inserts -- the pass reports `rebuilt: 1, indexed: 0` and leaves the file unsearchable.
    // The final watermark write takes MAX(existing, new), which would pin the old value too.
    // Naming is reset with the watermark. A rewritten file no longer contains the entries the
    // old name came from, so keeping it would attribute a name to a session that never had it.
    await withWriteRetry(dbPath, client => client.execute({
      sql: `UPDATE transcript_files
            SET bytes_indexed = 0, lines_indexed = 0, size_at_index = 0,
                display_name = NULL, name_kind = 0, opening = NULL
            WHERE path = ?`,
      args: [file.path],
    }));
  }

  const from = rewritten || !state
    ? { bytes: 0, lines: 0 }
    : { bytes: state.bytesIndexed, lines: state.linesIndexed };

  // Seeded from what is already stored, not from zero: a second pass over an appended file
  // would otherwise let a rank-1 `ai-title` overwrite a rank-3 rename captured earlier.
  const naming: SessionNamingState = rewritten || !state
    ? { displayName: null, nameKind: NAME_KIND.none, opening: null }
    : { displayName: state.displayName, nameKind: state.nameKind, opening: state.opening };

  let indexed = 0;
  let batch: ProseChunk[] = [];
  const iterator = streamProseFrom(file.path, from.bytes, from.lines, seen => {
    // `>=` so a later rename at the same rank wins; `>` alone would pin the first one.
    if (seen.kind >= naming.nameKind) {
      naming.displayName = seen.name;
      naming.nameKind = seen.kind;
    }
  });

  for (;;) {
    const next = await iterator.next();

    if (next.done) {
      if (batch.length > 0) {
        indexed += await commitBatch(dbPath, file, size, batch, naming);
      }
      // Trailing non-prose lines advanced the stream without yielding, so the final watermark
      // can be past the last committed batch. Recording it stops the next pass re-reading them.
      // Guarded against going backwards: a concurrent writer may already be further ahead.
      await withWriteRetry(dbPath, client => client.execute({
        sql: `INSERT INTO transcript_files (path, session_id, parent_session_id, bytes_indexed, lines_indexed, size_at_index, updated_at, display_name, name_kind, opening)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(path) DO UPDATE SET
                bytes_indexed = MAX(transcript_files.bytes_indexed, excluded.bytes_indexed),
                lines_indexed = MAX(transcript_files.lines_indexed, excluded.lines_indexed),
                size_at_index = excluded.size_at_index,
                updated_at = excluded.updated_at,${NAMING_UPSERT}`,
        args: [
          file.path, file.sessionId, file.parentSessionId,
          next.value.bytesConsumed, next.value.linesConsumed, size, new Date().toISOString(),
          naming.displayName, naming.nameKind, naming.opening,
        ],
      }));
      return { indexed, rebuilt: rewritten, complete: true };
    }

    // The opening ask is the session's first real user prose, which this stream already sees.
    // `readOpeningAsk` returns null for an injected turn, so the search moves to the next one
    // rather than describing the session by boilerplate it did not write.
    if (naming.opening === null && next.value.message.role === 'user') {
      naming.opening = readOpeningAsk(next.value.message.text)?.slice(0, 300) ?? null;
    }

    batch.push(next.value);
    if (batch.length < WRITE_BATCH) continue;

    indexed += await commitBatch(dbPath, file, size, batch, naming);
    batch = [];

    // Checked between committed batches, so stopping here is always at a consistent point.
    if (deadline !== undefined && Date.now() >= deadline) {
      return { indexed, rebuilt: rewritten, complete: false };
    }
  }
}

/**
 * Bring the index up to date with what is on disk.
 *
 * Every unit of work is idempotent against the stored watermark, so an interrupted pass leaves
 * nothing to repair -- "how far did we get" is already a column.
 */
export async function runIndexPass(input: {
  projectRoot: string;
  dbPath: string;
  projectsDir?: string;
  /** `Date.now()` value after which the pass stops between files. */
  deadline?: number;
}): Promise<IndexPassResult> {
  // Deliberately no long-lived `client` local. `withWriteRetry` closes and reopens the cached
  // connection when it hits SQLITE_BUSY_SNAPSHOT, so any handle captured up here would be a
  // closed one for the rest of the pass. Every operation re-acquires through the helper.
  await openTranscriptDb(input.dbPath);
  const scan = await scanTranscriptArchive(input.projectRoot, { projectsDir: input.projectsDir });
  const files = scan.files;
  const onDisk = new Set(files.map(file => file.path));

  const result: IndexPassResult = { indexed: 0, rebuilt: 0, removed: 0, filesTouched: 0, complete: true };

  // Deleted transcripts first: their pointers are dead, and a search that returns them wastes a
  // file read to discover it. Cheap when nothing vanished, which is the usual case.
  //
  // Gated on the archive being readable at all. "Discovery returned nothing" has two very
  // different causes: the user deleted their transcripts, or the archive is not reachable right
  // now -- a network home directory, an unset HOME, a machine where Claude Code has not run yet.
  // The second is indistinguishable from the first by file list alone, and treating it as
  // deletion destroys the entire index, including a backfill that may have taken hours. Keeping
  // stale rows costs one wasted file read per dead pointer, and the next pass that can see the
  // archive reclaims them.
  //
  // Gated on `scan.degraded` for the same reason one level up. The root set is whatever `git
  // worktree list` said, and a git that could not run at all shrinks it to the project root --
  // at which point every worktree's sessions look deleted and the sweep drops their rows *and
  // their vectors*. Re-indexing is cheap; re-embedding an archive is not, and nothing was
  // stale. A definitive "not a checkout" is not degraded: it misses no roots.
  const archiveReadable = await readableDir(input.projectsDir ?? defaultProjectsDir());
  if (archiveReadable && !scan.degraded) {
    const known = await withWriteRetry(input.dbPath, async client =>
      (await client.execute('SELECT path FROM transcript_files')).rows.map(row => String(row.path)));

    for (const knownPath of known) {
      if (onDisk.has(knownPath)) continue;
      await dropFileRows(input.dbPath, knownPath);
      await withWriteRetry(input.dbPath, client =>
        client.execute({ sql: 'DELETE FROM transcript_files WHERE path = ?', args: [knownPath] }));
      result.removed++;
    }
  }

  for (const file of files) {
    if (input.deadline !== undefined && Date.now() >= input.deadline) {
      result.complete = false;
      break;
    }

    let size: number;
    try {
      size = (await fs.stat(file.path)).size;
    } catch {
      continue; // Vanished between discovery and now; the next pass cleans it up.
    }

    const state = await readFileState(input.dbPath, file.path);
    if (state && size === state.sizeAtIndex && size === state.bytesIndexed) continue;

    const { indexed, rebuilt, complete } = await indexOneFile(input.dbPath, file, size, state, input.deadline);
    result.indexed += indexed;
    result.filesTouched++;
    if (rebuilt) result.rebuilt++;
    // Mid-file stop: the watermark is committed, so the next pass resumes inside this file.
    if (!complete) {
      result.complete = false;
      break;
    }
  }

  return result;
}
