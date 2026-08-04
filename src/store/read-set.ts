import crypto from 'node:crypto';
import { getClient } from './database.js';

/**
 * What a session read, and the hash of it as of that read.
 *
 * This is the storage half of the change-impact plan's certain tier (docs/change-impact-plan.md
 * §7.1). Every softer tier in that plan -- path match, title match, an edge two hops out -- is a
 * guess about relevance; this one is a hash equality on something the session provably looked at,
 * which is why it is the only tier allowed to push a notice and block a task finish. The store
 * therefore has one job beyond persistence: make "unreleased row" mean exactly "a belief this
 * session still holds", because the tier's ≥95% precision bar is computed against nothing else.
 *
 * Filled from the captured per-tool path stream and never from an agent reporting its own reads --
 * CooperBench measures agents defecting from their own stated commitments 32% of the time, so
 * nothing load-bearing may depend on an agent declaring anything about itself.
 *
 * Rows are released, not deleted, at task-finish and session-stop. A released row is the evidence
 * that a finding was justified and is the denominator §9's precision number is computed against;
 * GC sweeps it later on its own terms (`sweepReadSets`), which is a separate decision from the
 * work having finished.
 *
 * Advisory throughout: this subsystem runs inside a capture path that fires on every tool call,
 * and a memory server that breaks the agent it is trying to help has done more damage than the
 * staleness it was watching for. Bad input is dropped rather than thrown on, and the `BestEffort`
 * wrappers exist for the lifecycle call sites, following `flagCorrectionSiblingsBestEffort`.
 */

export interface ReadSetEntry {
  id: string;
  sessionId: string;
  agentId: string | null;
  taskId: string | null;
  locator: string;
  observedHash: string;
  toolName: string | null;
  readAt: string;
  releasedAt: string | null;
}

/** One observation, as the capture path sees it. */
export type ReadObservation = {
  sessionId: string;
  agentId?: string | null;
  taskId?: string | null;
  locator: string;
  observedHash: string;
  toolName?: string | null;
};

/**
 * Locators per `IN (...)` batch. 200 following `VISIBILITY_CHUNK` in `change-watermark.ts`, and
 * chunked at all because the caller is a write-triggered detector: it hands over every locator a
 * re-indexed file produced, which is unbounded in the size of the file, and SQLite's bind-parameter
 * ceiling is a hard error rather than a slow query.
 */
export const READ_SET_CHUNK = 200;

const COLUMNS = 'id, session_id, agent_id, task_id, locator, observed_hash, tool_name, read_at, released_at';

const newId = (): string => crypto.randomUUID().replace(/-/g, '').substring(0, 16);

const text = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

/**
 * Empty and whitespace-only are the same thing as absent everywhere in this table.
 *
 * Returns the value unchanged rather than trimmed, deliberately. `releaseReadSet` searches by the
 * caller's own `task_id` and the detector compares against the stored `observed_hash`, and neither
 * goes through here -- so a stored value that had been quietly trimmed on the way in would simply
 * stop matching the argument it is looked up by. Blankness is the only judgment made here.
 */
const orNull = (value: string | null | undefined): string | null =>
  value !== null && value !== undefined && value.trim().length > 0 ? value : null;

const toEntry = (row: Record<string, unknown>): ReadSetEntry => ({
  id: String(row.id),
  sessionId: String(row.session_id),
  agentId: text(row.agent_id),
  taskId: text(row.task_id),
  locator: String(row.locator),
  observedHash: String(row.observed_hash),
  toolName: text(row.tool_name),
  readAt: String(row.read_at),
  releasedAt: text(row.released_at),
});

/**
 * The canonical form of a locator, or null when it is not one this table may hold.
 *
 * Exported because the detector has to build the locator it searches by, and a second copy of
 * this rule would diverge silently: the write path would store `symbol://src/a.ts#f` and the read
 * path would look for `symbol://src\a.ts#f`, which is not a miss anybody notices -- it is a
 * feature that quietly never fires.
 *
 * **Directories are the hazard this exists for.** `Grep` contributes no `file_path`, so it cannot
 * poison the set by that route, but its `path` argument *is* allowlisted through the stdin filter
 * (`lifecycle.ts:34`) and arrives on the same stream every other tool's file path does. One
 * `Grep` scoped to `src/store` would put a directory in the read-set, and from then on every edit
 * anywhere beneath it reads as an invalidation of that session's work -- a false positive per
 * write, delivered on the tool-side channel, which is the channel measured at ~20.8% mean accuracy
 * cost to the agent receiving it.
 *
 * A directory is rejected by requiring an extension on the last segment: a dot at index ≥ 1 of the
 * basename. That is a heuristic and it is deliberately biased. It accepts `.eslintrc.json` and
 * rejects `.gitignore`, `Makefile` and `LICENSE`, so a genuine read of an extensionless file is
 * lost. The bias is chosen because the two errors do not cost the same -- a missed file costs
 * recall on a tier that is allowed to be incomplete, while an accepted directory costs precision
 * on the one tier that is allowed to interrupt.
 *
 * Paths are repo-relative by convention (`host-hook.ts` relativizes before the path is ever
 * captured, and `symbol-index.ts` builds its locators the same way). A leading slash, a trailing
 * slash, and `.` or `..` segments are all refused because each of them lets one file be described
 * by two different locators, and two locators for one file is a missed match, not a duplicate row.
 */
export function normalizeLocator(raw: string): string | null {
  const value = (raw ?? '').trim();

  if (value.startsWith('symbol://')) {
    const rest = value.slice('symbol://'.length);
    // First `#`, not last: the path cannot contain one, and a qualified name conceivably can.
    const hash = rest.indexOf('#');
    if (hash < 0) return null;
    const name = rest.slice(hash + 1).trim();
    const filePath = normalizeFilePath(rest.slice(0, hash));
    // A symbol locator without a name is a file locator wearing the wrong scheme, and the two
    // hash the same thing at different granularities; letting it through would make a file-level
    // observation compare against a signature hash and always look changed.
    if (filePath === null || name.length === 0) return null;
    return `symbol://${filePath}#${name}`;
  }

  if (value.startsWith('file://')) {
    const rest = value.slice('file://'.length);
    // A `#` here is a malformed symbol locator, not a file whose name contains one. Guessing
    // which would be guessing at granularity, which is the one thing this locator has to be
    // unambiguous about.
    if (rest.includes('#')) return null;
    const filePath = normalizeFilePath(rest);
    return filePath === null ? null : `file://${filePath}`;
  }

  return null;
}

function normalizeFilePath(raw: string): string | null {
  // Windows separators are normalized rather than rejected, matching `symbol-index.ts:36`. A host
  // that emits `src\store\a.ts` is describing the same file as `src/store/a.ts`, and storing both
  // spellings means the detector's equality never fires on that platform -- which is this one.
  const filePath = raw.trim().replace(/\\/g, '/');
  if (filePath.length === 0) return null;

  const segments = filePath.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return null;

  const basename = segments[segments.length - 1];
  const dot = basename.indexOf('.', 1);
  if (dot < 0 || dot === basename.length - 1) return null;

  return filePath;
}

/**
 * Record one read, or recognise that it is one already on file.
 *
 * **Idempotent per (session, locator, hash) among unreleased rows.** The capture path fires on
 * every tool call and an agent re-reads the same file constantly, so a row per read would make
 * this table grow with tool calls rather than with distinct observations -- against a plan whose
 * own measurement target is "steady-state rows bounded post-GC". Nothing is learned by the second
 * write either: two rows carrying the same hash for the same session are one belief.
 *
 * The dedupe is scoped to *unreleased* rows, not to the whole table. A released row is finished
 * evidence; matching against it would mean that a session which reads a file, finishes its task,
 * and starts a new one is treated as still holding the old row and never records the new read --
 * so the detector goes quiet for exactly the locators the session touches most.
 *
 * **A different hash is a new observation and retires the old one.** Recording it is not in
 * question -- the agent has now seen a newer version. What is decided here is that the previous
 * unreleased row for the same session and locator is released in the same breath, so
 * `activeReadersOf` returns one row per session per locator carrying that session's current
 * belief. The alternative -- leave both live -- makes the certain tier fire on the superseded row
 * and report a session as stale for a change it has already read, which is a *guaranteed* false
 * positive on the one tier held to ≥95%, and every consumer would have to re-derive
 * "newest wins" to avoid it.
 *
 * Belief is session-scoped, following the contract's own dedupe key, which names no agent. Two
 * sub-agents of one session that read the same locator at different versions therefore share one
 * belief; that is a known simplification, not an oversight.
 *
 * Deliberately not wrapped in `withClientTransaction`: it is not nestable and this runs inside a
 * hook path that may already hold one, where the failure would be a thrown DatabaseError on every
 * capture. What the transaction would buy is closing a sub-millisecond window in which a
 * concurrent reader sees the old belief already released and the new one not yet inserted, whose
 * cost is one missed detection in an advisory subsystem. Ordering matters and is chosen for the
 * same reason: the release runs *before* the insert, because a release predicated on
 * `released_at IS NULL` would otherwise retire the row just written.
 */
export async function recordRead(input: ReadObservation): Promise<void> {
  const locator = normalizeLocator(input.locator);
  const sessionId = orNull(input.sessionId);
  const observedHash = orNull(input.observedHash);
  // An empty hash is worse than a missing row: it is NOT NULL-satisfying, so the column's
  // guarantee holds while every empty-hash read compares equal to every other one.
  if (locator === null || sessionId === null || observedHash === null) return;

  const client = getClient();
  const existing = await client.execute({
    sql: `SELECT id FROM work_read_sets
          WHERE session_id = ? AND locator = ? AND observed_hash = ? AND released_at IS NULL
          LIMIT 1`,
    args: [sessionId, locator, observedHash],
  });
  if (existing.rows.length > 0) return;

  const readAt = new Date().toISOString();
  // No hash predicate needed: the check above proved no unreleased row carries this hash, so
  // whatever is still live for this session and locator is by construction an older observation.
  await client.execute({
    sql: 'UPDATE work_read_sets SET released_at = ? WHERE session_id = ? AND locator = ? AND released_at IS NULL',
    args: [readAt, sessionId, locator],
  });
  await client.execute({
    sql: `INSERT INTO work_read_sets (${COLUMNS})
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    args: [
      newId(),
      sessionId,
      orNull(input.agentId),
      orNull(input.taskId),
      locator,
      observedHash,
      orNull(input.toolName),
      readAt,
    ],
  });
}

/**
 * Every live read of any of these locators, across all sessions.
 *
 * The detector's query: a write lands on one file, that file yields its locators, and this answers
 * who is still standing on them. Invalid locators are dropped rather than searched for, and
 * duplicates collapsed, so a caller that hands over a re-indexed file's whole symbol list pays for
 * distinct work only.
 *
 * Ordered by read time within each batch. Across batches the order is the batch order, which is
 * the caller's locator order -- callers that need a global ordering must impose it themselves,
 * since a sort spanning chunks would mean holding the whole result to reorder it.
 */
export async function activeReadersOf(locators: string[]): Promise<ReadSetEntry[]> {
  const wanted = [...new Set(
    (locators ?? []).map(normalizeLocator).filter((locator): locator is string => locator !== null),
  )];
  if (wanted.length === 0) return [];

  const client = getClient();
  const entries: ReadSetEntry[] = [];
  for (let index = 0; index < wanted.length; index += READ_SET_CHUNK) {
    const chunk = wanted.slice(index, index + READ_SET_CHUNK);
    const rows = await client.execute({
      sql: `SELECT ${COLUMNS} FROM work_read_sets
            WHERE locator IN (${chunk.map(() => '?').join(', ')}) AND released_at IS NULL
            ORDER BY read_at ASC, id ASC`,
      args: chunk,
    });
    for (const row of rows.rows) entries.push(toEntry(row));
  }
  return entries;
}

/** Everything one session is still standing on. Serves the gate and the replan hint. */
export async function activeReadSetForSession(sessionId: string): Promise<ReadSetEntry[]> {
  const rows = await getClient().execute({
    sql: `SELECT ${COLUMNS} FROM work_read_sets
          WHERE session_id = ? AND released_at IS NULL
          ORDER BY read_at ASC, id ASC`,
    args: [sessionId],
  });
  return rows.rows.map(row => toEntry(row));
}

/**
 * Mark a session's live reads finished, and return how many there were.
 *
 * With a `taskId`, only that task's rows: `knowl_task_finish` ends one task inside a session that
 * keeps running, and releasing the whole session there would drop the reads the session is still
 * relying on for its next task -- silently disarming the detector for the rest of the session.
 *
 * Sets `released_at`, never deletes. The row is the evidence a finding was justified and the
 * denominator the precision number is computed against; deleting it at task-finish would mean the
 * system could only ever measure findings whose sessions were still open.
 */
export async function releaseReadSet(sessionId: string, taskId?: string): Promise<number> {
  const releasedAt = new Date().toISOString();
  const result = await getClient().execute(
    taskId === undefined
      ? {
        sql: 'UPDATE work_read_sets SET released_at = ? WHERE session_id = ? AND released_at IS NULL',
        args: [releasedAt, sessionId],
      }
      : {
        sql: `UPDATE work_read_sets SET released_at = ?
              WHERE session_id = ? AND task_id = ? AND released_at IS NULL`,
        args: [releasedAt, sessionId, taskId],
      },
  );
  return Number(result.rowsAffected ?? 0);
}

/**
 * Hard-delete released rows released before the cutoff, and return how many went.
 *
 * Never touches an unreleased row, at any age. A session that has been open for a week is not
 * garbage -- it is the case this whole subsystem exists for -- and an age-based sweep that could
 * reach live rows would delete a long-running agent's read-set out from under it and report
 * "nothing you read has changed" for the rest of its life.
 *
 * The cutoff is compared against `released_at` rather than `read_at`, because release is when the
 * row stopped being useful for anything but the precision denominator. Comparing against read time
 * would collect a row that was read a month ago and released this morning, taking the evidence out
 * of the denominator on the same day the finding it justified was adjudicated.
 */
export async function sweepReadSets(olderThanIso: string): Promise<number> {
  const result = await getClient().execute({
    sql: 'DELETE FROM work_read_sets WHERE released_at IS NOT NULL AND released_at < ?',
    args: [olderThanIso],
  });
  return Number(result.rowsAffected ?? 0);
}

/**
 * Capture must never fail the tool call it is observing.
 *
 * `recordRead` already returns quietly on input it will not store; this covers the store being
 * mid-snapshot, locked, or on a schema older than the read-set. Same shape as
 * `flagCorrectionSiblingsBestEffort`: the core throws so tests and callers that want to know can,
 * and the wrapper is what the lifecycle path calls.
 */
export async function recordReadBestEffort(input: ReadObservation): Promise<void> {
  try {
    await recordRead(input);
  } catch {
    // An observation lost is one missed detection; an exception here is a broken tool call.
  }
}

/** Releasing is bookkeeping at a boundary the caller owns; `null` distinguishes "failed" from 0. */
export async function releaseReadSetBestEffort(sessionId: string, taskId?: string): Promise<number | null> {
  try {
    return await releaseReadSet(sessionId, taskId);
  } catch {
    return null;
  }
}
