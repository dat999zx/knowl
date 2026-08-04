import crypto from 'node:crypto';
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
  anchor: string | null;
};

/**
 * How many bytes ending at the watermark identify what was indexed.
 *
 * Large enough to span a whole transcript line in the common case, small enough that reading it
 * is one page: the cost of the check is a single 512-byte read per file per pass.
 */
const ANCHOR_BYTES = 512;

/**
 * A fingerprint of the bytes immediately before `bytes`, or null if the file is shorter.
 *
 * This is the answer to "is what I already indexed still there", which a size cannot give. A
 * transcript rewritten in place -- an editor, a redaction pass, a sync client replacing the
 * file -- can keep the same length or grow, and `size < bytes_indexed` sees neither. What
 * follows is worse than a stale index: every stored line number still resolves, to whatever
 * text now occupies that line, so search returns the *wrong bodies* rather than nothing.
 *
 * The byte count is mixed in so an identical window at a different offset cannot collide.
 */
export async function anchorAt(filePath: string, bytes: number): Promise<string | null> {
  if (bytes <= 0) return null;
  const start = Math.max(0, bytes - ANCHOR_BYTES);
  const length = bytes - start;

  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    // Short read: the file no longer reaches the watermark, so nothing here was indexed from it.
    if (bytesRead < length) return null;
    return `${bytes}:${crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32)}`;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Whether the file on disk is no longer the file this index describes.
 *
 * A null stored anchor is an index written before anchors existed: unknown, not divergent. It is
 * adopted the next time the file is looked at, so an existing index gains the check for free.
 */
async function divergedFromIndex(filePath: string, size: number, state: FileState): Promise<boolean> {
  if (state.bytesIndexed <= 0) return false;
  if (size < state.bytesIndexed) return true; // shrank: cheap, and needs no read
  if (state.anchor === null) return false;
  return (await anchorAt(filePath, state.bytesIndexed)) !== state.anchor;
}

/** What the file row currently says about the session's name and opening ask. */
export type SessionNamingState = {
  displayName: string | null;
  nameKind: number;
  opening: string | null;
};

async function readFileState(dbPath: string, filePath: string): Promise<FileState | null> {
  const rows = await withWriteRetry(dbPath, async client => (await client.execute({
    sql: `SELECT bytes_indexed, lines_indexed, size_at_index, display_name, name_kind, opening, anchor
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
    anchor: rows[0].anchor === null || rows[0].anchor === undefined ? null : String(rows[0].anchor),
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
 * Drop a rewritten file's rows and reset its watermark, in one transaction.
 *
 * One transaction because the two facts are one fact. Dropping the rows and then resetting the
 * watermark leaves a window where a crash -- a killed CLI, a machine going to sleep -- has zero
 * rows behind a high watermark. The next pass reads that watermark, streams from it, and every
 * message before it is gone from the index with nothing left to say so: `commitBatchOn` skips
 * anything the watermark already covers, so the rows are never re-inserted. Resetting first and
 * dropping second is no better -- it replays committed lines into `UNIQUE(path, line)`.
 *
 * The unbatched delete is deliberate: a rebuild is rare, and a batched delete is exactly the
 * multi-transaction shape this has to avoid. Naming is reset with the watermark, because a
 * rewritten file no longer contains the entries the old name came from.
 */
async function rebuildFileRows(dbPath: string, filePath: string): Promise<void> {
  await withWriteRetry(dbPath, async client => {
    await client.execute('BEGIN IMMEDIATE');
    try {
      const ids = (await client.execute({
        sql: 'SELECT id FROM transcript_messages WHERE path = ?',
        args: [filePath],
      })).rows.map(row => Number(row.id));

      for (const id of ids) {
        await client.execute({ sql: 'DELETE FROM transcript_fts WHERE rowid = ?', args: [id] });
        await client.execute({ sql: 'DELETE FROM transcript_vectors WHERE message_id = ?', args: [id] });
      }
      await client.execute({ sql: 'DELETE FROM transcript_messages WHERE path = ?', args: [filePath] });
      await client.execute({
        sql: `UPDATE transcript_files
              SET bytes_indexed = 0, lines_indexed = 0, size_at_index = 0,
                  display_name = NULL, name_kind = 0, opening = NULL, anchor = NULL
              WHERE path = ?`,
        args: [filePath],
      });
      await client.execute('COMMIT');
    } catch (error) {
      await client.execute('ROLLBACK').catch(() => {});
      throw error;
    }
  });
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
  // Read outside the transaction: it touches the file, not the database, and holding a write
  // lock across a file read would starve a live session for no reason.
  const anchor = await anchorAt(file.path, batch[batch.length - 1].bytesConsumed);
  return withWriteRetry(dbPath, async client => commitBatchOn(client, file, size, batch, naming, anchor));
}

async function commitBatchOn(
  client: Client,
  file: TranscriptFile,
  size: number,
  batch: ProseChunk[],
  naming: SessionNamingState,
  anchor: string | null,
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

    for (const { message, byteOffset } of fresh) {
      const inserted = await client.execute({
        sql: `INSERT INTO transcript_messages (path, session_id, parent_session_id, line, role, chars, ts, byte_offset)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [file.path, file.sessionId, file.parentSessionId, message.line, message.role, message.text.length, message.timestamp, byteOffset],
      });
      // The FTS rowid is the message id, which is how a hit maps back to a pointer.
      await client.execute({
        sql: 'INSERT INTO transcript_fts(rowid, body) VALUES (?, ?)',
        args: [Number(inserted.lastInsertRowid), message.text],
      });
    }

    await client.execute({
      sql: `INSERT INTO transcript_files (path, session_id, parent_session_id, bytes_indexed, lines_indexed, size_at_index, updated_at, display_name, name_kind, opening, anchor)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET
              bytes_indexed = excluded.bytes_indexed,
              lines_indexed = excluded.lines_indexed,
              size_at_index = excluded.size_at_index,
              updated_at = excluded.updated_at,
              anchor = excluded.anchor,${NAMING_UPSERT}`,
      args: [
        file.path, file.sessionId, file.parentSessionId,
        watermark.bytesConsumed, watermark.linesConsumed, size, new Date().toISOString(),
        naming.displayName, naming.nameKind, naming.opening, anchor,
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
  /** The caller's verdict on whether the file on disk still matches what the index describes. */
  rewritten: boolean,
  deadline?: number,
): Promise<{ indexed: number; rebuilt: boolean; complete: boolean }> {
  // A file that no longer matches its watermark was rewritten, not appended to. Its old line
  // numbers no longer point anywhere, so the only safe move is to rebuild it -- rows and
  // watermark together, or the rebuild inserts nothing (see `rebuildFileRows`).
  if (rewritten) await rebuildFileRows(dbPath, file.path);

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
      // The anchor moves with the watermark it describes -- pinning one and not the other would
      // make the pair describe a file state that never existed.
      const finalAnchor = await anchorAt(file.path, next.value.bytesConsumed);
      await withWriteRetry(dbPath, client => client.execute({
        sql: `INSERT INTO transcript_files (path, session_id, parent_session_id, bytes_indexed, lines_indexed, size_at_index, updated_at, display_name, name_kind, opening, anchor)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(path) DO UPDATE SET
                bytes_indexed = MAX(transcript_files.bytes_indexed, excluded.bytes_indexed),
                lines_indexed = MAX(transcript_files.lines_indexed, excluded.lines_indexed),
                size_at_index = excluded.size_at_index,
                updated_at = excluded.updated_at,
                anchor = CASE WHEN excluded.bytes_indexed >= transcript_files.bytes_indexed
                  THEN excluded.anchor ELSE transcript_files.anchor END,${NAMING_UPSERT}`,
        args: [
          file.path, file.sessionId, file.parentSessionId,
          next.value.bytesConsumed, next.value.linesConsumed, size, new Date().toISOString(),
          naming.displayName, naming.nameKind, naming.opening, finalAnchor,
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

  // A scan that may be missing roots has not enumerated the archive, so this pass cannot claim
  // to have caught up with it however far it got.
  if (scan.degraded) result.complete = false;

  try {
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
      // Asked *before* the up-to-date shortcut, not inside it. A file rewritten in place at the
      // same length matches every number this row holds, so the shortcut is precisely where an
      // undetected rewrite goes to hide.
      const diverged = state !== null && await divergedFromIndex(file.path, size, state);

      if (state && !diverged && size === state.sizeAtIndex && size === state.bytesIndexed) {
        // Nothing to index, but an index predating anchors has nothing to detect a rewrite
        // with. Adopting one now costs a 512-byte read and never has to happen again.
        if (state.anchor === null && state.bytesIndexed > 0) {
          const adopted = await anchorAt(file.path, state.bytesIndexed);
          if (adopted !== null) {
            await withWriteRetry(input.dbPath, client => client.execute({
              sql: 'UPDATE transcript_files SET anchor = ? WHERE path = ? AND anchor IS NULL',
              args: [adopted, file.path],
            }));
          }
        }
        continue;
      }

      const { indexed, rebuilt, complete } =
        await indexOneFile(input.dbPath, file, size, state, diverged, input.deadline);
      result.indexed += indexed;
      result.filesTouched++;
      if (rebuilt) result.rebuilt++;
      // Mid-file stop: the watermark is committed, so the next pass resumes inside this file.
      if (!complete) {
        result.complete = false;
        break;
      }
    }
  } catch (error) {
    result.complete = false;
    throw error;
  } finally {
    // Recorded whatever happened, because "did the last pass finish" cannot be recovered from
    // the rows afterwards: a file the pass never reached leaves nothing behind to notice.
    await recordIndexState(input.dbPath, result.complete, files.length).catch(() => {});
  }

  return result;
}

/** Persist what this pass can say about the index as a whole. See `readTranscriptIndexState`. */
async function recordIndexState(dbPath: string, complete: boolean, filesSeen: number): Promise<void> {
  await withWriteRetry(dbPath, async client => {
    const indexed = Number((await client.execute('SELECT COUNT(*) AS n FROM transcript_files')).rows[0].n);
    await client.execute({
      sql: `INSERT INTO transcript_index_state (id, complete, files_seen, files_indexed, updated_at)
            VALUES (1, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              complete = excluded.complete,
              files_seen = excluded.files_seen,
              files_indexed = excluded.files_indexed,
              updated_at = excluded.updated_at`,
      args: [complete ? 1 : 0, filesSeen, indexed, new Date().toISOString()],
    });
  });
}
