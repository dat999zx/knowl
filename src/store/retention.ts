import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getClient, withClientTransaction } from './database.js';

/**
 * The one place that answers "when does Knowl delete something."
 *
 * The audit found three separate unbounded growths -- `.knowl/snapshots` at 1.12 GB in ten
 * files, `.knowl/cache/hook-debounce` at 7,134 files whose useful life is 1500 ms, and
 * `knowledge_commits` at 3.57 MB of before/after row snapshots against 1.32 MB of the items
 * themselves. They are not three bugs. They are one: nothing in this system ever deletes
 * anything, and every growth point was written by someone who reasonably assumed something
 * else would eventually sweep.
 *
 * So the policy lives here, once, and is applied at the three points where the growth
 * actually happens rather than in a maintenance command nobody runs:
 *
 *   - `createSnapshot` prunes as it writes. Snapshots grow on a schedule because
 *     `upgrade --all` snapshots every repository, so the moment one is created is exactly
 *     the moment the old ones became redundant.
 *   - `claimCapture` sweeps as it claims, bounded, for the same reason.
 *   - `runStoreRetention` runs from `knowl upgrade`, which is the command that already
 *     visits every repository on the machine. The habit that caused the growth pays for it.
 *
 * Two rules throughout. Nothing is deleted that a reader could still legitimately want --
 * the horizons are generous and the bounds keep the newest. And nothing is deleted that this
 * module did not put there: sweeps match on shape, so a file a human parked in one of these
 * directories survives.
 */

/**
 * Snapshots kept, newest first.
 *
 * Each is a full VACUUM of the database, so the sequence costs (size x count) and the sizes
 * grow together. Three is two rollbacks deep plus the one just taken, which is the depth an
 * actual recovery uses: the pre-restore snapshot that `restoreSnapshot` writes is always the
 * newest, so undoing a bad restore never reaches past the first.
 */
export const SNAPSHOT_KEEP = 3;

/**
 * How long a hook capture fingerprint suppresses a duplicate.
 *
 * Lives here rather than in `hook-debounce.ts`, which re-exports it, so that the window and
 * the lifetime of the file enforcing it are decided in one place. They were not, which is
 * how a 1500 ms window came to be kept on disk indefinitely.
 */
export const HOOK_CAPTURE_DEBOUNCE_MS = 1500;

/**
 * How long a debounce claim is kept after it stops mattering.
 *
 * 40x the window, so a suspended process, a clock that stepped, or a filesystem with coarse
 * timestamps cannot cost a live claim -- and one minute of claims is a handful of files
 * rather than seven thousand.
 */
export const CLAIM_MAX_AGE_MS = HOOK_CAPTURE_DEBOUNCE_MS * 40;

/**
 * Claims removed per sweep.
 *
 * The first sweep of an already-grown directory has thousands to remove, and it runs inside
 * a hook, on the agent's turn. Bounded so that pass costs a few milliseconds and the backlog
 * drains over the next several tool calls, instead of one turn paying for all of history.
 */
export const CLAIM_SWEEP_BUDGET = 512;

/**
 * How long a commit keeps the full before/after copy of every item it touched.
 *
 * The rows are never deleted: which items changed, how, when and under what message is the
 * audit trail, and `loadChangesInRange` and blast radius both read it. What ages out is the
 * pair of complete item snapshots inside each change, which is where the bytes are and which
 * nothing reads past the moment a change card is rendered.
 *
 * Ninety days is well past any watermark -- a host session's watermark is hours old at most.
 */
export const COMMIT_PAYLOAD_HORIZON_DAYS = 90;

/** Commits rewritten per pass, so one upgrade cannot stall on a very long history. */
const COMMIT_COMPACT_BATCH = 2_000;

// --- files -------------------------------------------------------------------------------

/**
 * Delete every claim file older than the window can possibly need, up to the budget.
 *
 * Synchronous because its caller is, and returns the count so a caller can report it.
 * Every failure is swallowed: a hook that fails because housekeeping failed is worse than a
 * directory that stays large, and the next call will try again anyway.
 */
export function sweepDebounceClaims(
  claimDir: string,
  now = Date.now(),
  maxAgeMs = CLAIM_MAX_AGE_MS,
  budget = CLAIM_SWEEP_BUDGET,
): number {
  let removed = 0;
  try {
    for (const name of fsSync.readdirSync(claimDir)) {
      if (removed >= budget) break;
      if (!name.endsWith('.claim')) continue;
      const file = path.join(claimDir, name);
      try {
        if (now - fsSync.statSync(file).mtimeMs <= maxAgeMs) continue;
        fsSync.unlinkSync(file);
        removed += 1;
      } catch {
        // Raced with another hook process, or vanished under us. Either way it is gone.
      }
    }
  } catch {
    // No directory yet, or unreadable. Nothing to sweep.
  }
  return removed;
}

/**
 * Keep the newest `keep` snapshots and their manifests; return what was removed.
 *
 * Ordered by modification time rather than by name so a snapshot restored or copied in from
 * elsewhere is placed by when it arrived. `protect` is the snapshot being written right now,
 * named explicitly rather than trusted to sort first.
 */
export async function pruneSnapshots(
  snapshotDir: string,
  keep = SNAPSHOT_KEEP,
  protect?: string,
): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(snapshotDir);
  } catch {
    return [];
  }

  const protectedPath = protect ? path.resolve(protect) : null;
  const snapshots: Array<{ file: string; mtimeMs: number; name: string }> = [];
  for (const name of names) {
    // Shape, not everything in the directory: a file a human parked here is not ours.
    if (!name.endsWith('.db')) continue;
    const file = path.join(snapshotDir, name);
    if (protectedPath && path.resolve(file) === protectedPath) continue;
    try {
      snapshots.push({ file, name, mtimeMs: (await fs.stat(file)).mtimeMs });
    } catch {
      // Gone already.
    }
  }

  snapshots.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));

  const removed: string[] = [];
  // `protect` occupies one of the kept slots, because it is a snapshot too.
  for (const stale of snapshots.slice(Math.max(keep - (protectedPath ? 1 : 0), 0))) {
    try {
      await fs.rm(stale.file, { force: true });
      // A manifest never outlives its snapshot: an orphan manifest is a checksum for a file
      // that is not there, which reads as corruption.
      await fs.rm(`${stale.file}.manifest.json`, { force: true });
      removed.push(stale.file);
    } catch {
      // Locked or already gone; the next snapshot will try again.
    }
  }
  return removed;
}

// --- database ----------------------------------------------------------------------------

export type CommitCompaction = { commits: number; bytesFreed: number };

const isoDaysAgo = (days: number, now = Date.now()) =>
  new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

/**
 * Strip the before/after item snapshots out of commits past the horizon.
 *
 * `itemId` and `action` stay, which is everything the readers need: blast radius asks which
 * commit *inserted* an item and who else it inserted, and change cards only ever look at
 * commits newer than a host session's watermark -- hours, not months.
 *
 * One payload is kept regardless of age: the `before` of a `delete`. A hard delete is the
 * only action whose item is not still in `knowledge_items` afterwards, so that copy is the
 * last one there is. Deletes are rare, so keeping them costs nothing and losing them would
 * be the one irreversible thing in an otherwise reversible sweep.
 *
 * This is also the honest answer to "blast radius full-scans an unindexed LIKE." That scan
 * is `changes LIKE '%<id>%'`, and a leading wildcard cannot use an index in SQLite at all,
 * so there is no index to add. What can be made smaller is the thing being scanned, and the
 * before/after payloads are almost all of it.
 */
export async function compactKnowledgeCommits(
  horizonDays = COMMIT_PAYLOAD_HORIZON_DAYS,
  now = Date.now(),
): Promise<CommitCompaction> {
  const client = getClient();
  const cutoff = isoDaysAgo(horizonDays, now);

  const rows = (await client.execute({
    sql: `SELECT id, changes FROM knowledge_commits
          WHERE created_at < ? AND (changes LIKE '%"before"%' OR changes LIKE '%"after"%')
          ORDER BY created_at ASC LIMIT ?`,
    args: [cutoff, COMMIT_COMPACT_BATCH],
  })).rows;

  const rewrites: Array<{ id: string; changes: string; saved: number }> = [];
  for (const row of rows) {
    const original = String(row.changes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(original);
    } catch {
      // Unreadable already; rewriting it would only lose more.
      continue;
    }
    if (!Array.isArray(parsed)) continue;

    const compacted = JSON.stringify(
      parsed.map((change: any) => (change?.action === 'delete' && change.before
        ? { itemId: change.itemId, action: change.action, before: change.before }
        : { itemId: change?.itemId, action: change?.action })),
    );
    if (compacted.length >= original.length) continue;
    rewrites.push({ id: String(row.id), changes: compacted, saved: original.length - compacted.length });
  }

  if (rewrites.length === 0) return { commits: 0, bytesFreed: 0 };

  // One transaction holding many statements, not many transactions holding one. Both cost
  // the same in fsyncs on paper and do not in practice, and the transaction *count* is what
  // the driver has a limit on.
  await withClientTransaction(async () => {
    for (const rewrite of rewrites) {
      await client.execute({
        sql: 'UPDATE knowledge_commits SET changes = ? WHERE id = ?',
        args: [rewrite.changes, rewrite.id],
      });
    }
  });

  return {
    commits: rewrites.length,
    bytesFreed: rewrites.reduce((total, rewrite) => total + rewrite.saved, 0),
  };
}

/**
 * Delete memory sessions past the `expires_at` they were written with.
 *
 * The column has always been written and never enforced, so a store held every session it
 * had ever opened. Nothing promotable is lost: session *events* carry their own 48-hour
 * expiry and are already purged on every hook, and promotion reads events -- so by the time
 * a seven-day session TTL lapses there has been nothing to promote for five days.
 *
 * Events and host bindings are deleted explicitly rather than left to `ON DELETE CASCADE`.
 * Relying on the cascade is what hid K-01, and an explicit delete says which tables this
 * function owns.
 */
export async function purgeExpiredMemorySessions(now = new Date().toISOString()): Promise<number> {
  const client = getClient();
  const expired = (await client.execute({
    sql: 'SELECT id FROM memory_sessions WHERE expires_at <= ?',
    args: [now],
  })).rows.map(row => String(row.id));
  if (expired.length === 0) return 0;

  const placeholders = expired.map(() => '?').join(', ');
  // Children then parent, in one transaction: a purge that half-applied would leave events
  // pointing at a session that is not there.
  await withClientTransaction(async () => {
    await client.execute({
      sql: `DELETE FROM memory_session_events WHERE session_id IN (${placeholders})`,
      args: expired,
    });
    await client.execute({
      sql: `DELETE FROM host_session_bindings WHERE memory_session_id IN (${placeholders})`,
      args: expired,
    });
    await client.execute({
      sql: `DELETE FROM memory_sessions WHERE id IN (${placeholders})`,
      args: expired,
    });
  });
  return expired.length;
}

export type RetentionReport = {
  commits: number;
  commitBytesFreed: number;
  sessions: number;
  claims: number;
};

/**
 * Every retention rule that is not applied at its own growth point, in one call.
 *
 * Best-effort as a whole: housekeeping must never be the reason an upgrade fails, and every
 * part of it is idempotent, so the next upgrade finishes whatever this one did not.
 * Requires an open database.
 */
export async function runStoreRetention(projectRoot: string): Promise<RetentionReport> {
  const report: RetentionReport = { commits: 0, commitBytesFreed: 0, sessions: 0, claims: 0 };

  try {
    const compaction = await compactKnowledgeCommits();
    report.commits = compaction.commits;
    report.commitBytesFreed = compaction.bytesFreed;
  } catch {
    // Leave it for the next upgrade.
  }

  try {
    report.sessions = await purgeExpiredMemorySessions();
  } catch {
    // As above.
  }

  // Unbounded here on purpose: this is not running inside an agent's turn, so the whole
  // backlog can go at once rather than draining over the next few hundred tool calls.
  report.claims = sweepDebounceClaims(
    path.join(projectRoot, '.knowl', 'cache', 'hook-debounce'),
    Date.now(),
    CLAIM_MAX_AGE_MS,
    Number.POSITIVE_INFINITY,
  );

  return report;
}
