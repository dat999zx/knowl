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

/**
 * How long a model no repository names is kept before it is removed.
 *
 * Long, because the thing this protects is a model-selection sweep. The 16 models measured in
 * one repo's cache were downloaded by one -- 2,495 MB in an afternoon -- and an upgrade run
 * the next morning must not undo the afternoon's work while the results are still being read.
 * A month is well past that and still bounded, and weights are the one thing in this module
 * that can be fetched again rather than being gone.
 */
export const MODEL_CACHE_HORIZON_DAYS = 30;

/**
 * Suffix for a copy still in flight.
 *
 * Distinctive on purpose: the sweep that collects abandoned ones matches on it, so a killed
 * adoption costs disk until the next upgrade rather than forever, and nothing else in the
 * cache can be mistaken for one. `@huggingface/transformers` uses `.tmp.<pid>.<random>` for
 * the same job, which is why this is not that -- the two must never collect each other's.
 */
const PARTIAL_SUFFIX = '.knowl-partial';

/**
 * How long an in-flight copy is left alone before it is treated as abandoned.
 *
 * Not zero, because two upgrades can run at once and deleting a live partial would make the
 * other one redo a gigabyte. Not long, because an abandoned one is dead weight: a SIGKILL
 * during the rehearsal left a 110 MB orphan. The largest model measured copies in seconds,
 * so an hour is three orders of magnitude of headroom.
 */
const PARTIAL_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Suffix for a model that has left the cache and is being deleted.
 *
 * `fs.rm(recursive)` is not atomic, and on Windows it does not even stop when it fails.
 * Measured: given a tree holding a libSQL database another process has open, `fs.rm` rejects
 * with EBUSY while 200 files elsewhere in the tree are still untouched -- and all 200 are
 * gone 400 ms later, deleted in the background, after the caller has already moved on.
 *
 * That makes a half-deleted model directory a real state, and a dangerous one here:
 * `resolveModelCache` decides a model is cached by asking whether its directory EXISTS, so a
 * model that lost its weights mid-prune reads as present and then fails to load.
 *
 * So the directory leaves the cache's namespace in one `rename`, which IS atomic, and only
 * the renamed copy is deleted. Whether that delete finishes decides how much disk comes
 * back; it can no longer decide whether the cache is coherent. A leftover is collected by
 * the next prune.
 */
const PRUNING_SUFFIX = '.knowl-pruning';

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
 * elsewhere is placed by when it arrived. `protect` names snapshots this prune must not take:
 * the one being written right now, and -- during a restore -- the one being restored from.
 * Naming the second is not politeness. The prune runs between the restore's manifest check and
 * its ATTACH, so deleting the source there left ATTACH to create an empty database in its place
 * and the restore to delete a store it could not refill.
 */
export async function pruneSnapshots(
  snapshotDir: string,
  keep = SNAPSHOT_KEEP,
  protect?: string | string[],
): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(snapshotDir);
  } catch {
    return [];
  }

  const protectedPaths = new Set(
    (protect === undefined ? [] : Array.isArray(protect) ? protect : [protect]).map(one => path.resolve(one)),
  );

  // Counted rather than taken from the set's size: a protected path can name a snapshot
  // outside this directory -- `snapshot restore` accepts any path -- and one that is not here
  // is not occupying a slot here.
  let protectedHere = 0;
  const snapshots: Array<{ file: string; mtimeMs: number; name: string }> = [];
  for (const name of names) {
    // Shape, not everything in the directory: a file a human parked here is not ours.
    if (!name.endsWith('.db')) continue;
    const file = path.join(snapshotDir, name);
    if (protectedPaths.has(path.resolve(file))) { protectedHere += 1; continue; }
    try {
      snapshots.push({ file, name, mtimeMs: (await fs.stat(file)).mtimeMs });
    } catch {
      // Gone already.
    }
  }

  snapshots.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));

  const removed: string[] = [];
  // Every protected snapshot in this directory occupies one of the kept slots, because it is
  // a snapshot too.
  for (const stale of snapshots.slice(Math.max(keep - protectedHere, 0))) {
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

// --- model cache -------------------------------------------------------------------------

/**
 * K-42's retention half.
 *
 * The forward half made a *new* download resolve to a shared cache under `knowlHome()`.
 * It deliberately left what was already on disk alone, because repointing the constant would
 * have orphaned every existing tree and made the next query refetch a model sitting two
 * directories away. That leaves the trees orphaned in the other direction: measured on one
 * machine, 2,495 MB in one repo across 16 models, and two other repos holding byte-identical
 * 336 MB copies of the same eight files.
 *
 * Adoption is a copy, not a rename: `<repo>/.knowl/models` and `knowlHome()` are routinely on
 * different volumes -- D: and C: on the machine this was measured on -- and `rename` cannot
 * cross one.
 *
 * Which makes the ordering the whole design. Each file is copied to a `.knowl-partial` name,
 * checked for length, flushed, renamed into place, and only then removed from the repo. The
 * source is the last thing to go, so at every point where this can be killed -- and it moves
 * gigabytes, so it will be -- there is at least one complete copy of the weights. There is no
 * window in which a model exists only as a partial file.
 */
export type ModelAdoption = {
  /** Files copied into the shared cache. */
  adopted: number;
  /** Files the shared cache already held identically, removed from the repo unread. */
  deduplicated: number;
  /** Bytes returned to the repository's volume. */
  bytesFreed: number;
  /** Files present in both at different sizes. Neither copy is touched. */
  conflicts: string[];
};

export type ModelAdoptionOptions = {
  /** Seam for testing the interrupted-copy path, which is the one that must not lose data. */
  copyFile?: (source: string, destination: string) => Promise<void>;
};

async function listFilesRecursive(dir: string, prefix = ''): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(path.join(dir, entry.name), relative));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

/** Remove directories that are empty after a move, deepest first. Never the root itself. */
async function removeEmptyDirectories(root: string): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await removeEmptyDirectories(path.join(root, entry.name));
  }
  try {
    await fs.rmdir(root); // fails, correctly, while anything is left
  } catch {
    // Not empty, or gone. Either is fine.
  }
}

/** Copy one file into place so that no reader ever sees it half-written. */
async function adoptOne(
  source: string,
  destination: string,
  copyFile: (source: string, destination: string) => Promise<void>,
): Promise<void> {
  const partial = `${destination}.${process.pid}${PARTIAL_SUFFIX}`;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await copyFile(source, partial);

    // Opened once, then measured and flushed through the descriptor. Stat-by-path followed by
    // open-by-path is two lookups of the same name, so the size that was checked and the bytes
    // that get flushed and renamed are not guaranteed to be the same file.
    const handle = await fs.open(partial, 'r+');
    try {
      // Length is the cheap end of "did all of it arrive". A short copy is what a full disk
      // looks like, and a 300 MB model that is silently 200 MB fails much later and much worse.
      const [from, to] = await Promise.all([fs.stat(source), handle.stat()]);
      if (from.size !== to.size) throw new Error(`short copy: ${to.size} of ${from.size} bytes`);

      // Flushed before the rename, not after. Rename is atomic with respect to other
      // processes, not with respect to power loss: without this the directory entry can reach
      // the disk while the contents have not, which is a model that exists and is empty.
      await handle.sync();
    } finally {
      await handle.close();
    }

    await fs.rename(partial, destination);
  } catch (error) {
    await fs.rm(partial, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Move a repository's model cache into the shared one, and give the space back.
 *
 * Returns rather than throws: this runs from `knowl upgrade`, and a machine that could not
 * finish a migration must still get its upgrade. Whatever is left behind is picked up next
 * time, because every step is idempotent -- a file already adopted is a duplicate on the
 * next pass, and a duplicate is removed without being copied again.
 */
export async function adoptLegacyModelCache(
  legacyDir: string,
  sharedDir: string,
  options: ModelAdoptionOptions = {},
): Promise<ModelAdoption> {
  const copyFile = options.copyFile ?? ((from, to) => fs.copyFile(from, to));
  const report: ModelAdoption = { adopted: 0, deduplicated: 0, bytesFreed: 0, conflicts: [] };

  // Anything a killed run left mid-copy, before writing more of them, and *before* the
  // early return below -- a SIGKILL during the last file of a migration leaves an orphan
  // behind an emptied legacy tree, and gating this on there being more to adopt is how a
  // 110 MB partial comes to sit in the cache forever. Found exactly that way.
  //
  // Matched by suffix, so this collects only its own: `@huggingface/transformers` names its
  // in-flight downloads `.tmp.<pid>.<random>` and they are none of our business.
  for (const relative of await listFilesRecursive(sharedDir)) {
    if (!relative.endsWith(PARTIAL_SUFFIX)) continue;
    const partial = path.join(sharedDir, relative);
    try {
      // Age, not ownership: a second upgrade running right now owns a fresh one, and taking
      // it would make that process recopy a gigabyte for nothing.
      if (Date.now() - (await fs.stat(partial)).mtimeMs < PARTIAL_MAX_AGE_MS) continue;
      await fs.rm(partial, { force: true });
    } catch {
      // Gone, or not ours to remove. Next upgrade.
    }
  }

  const files = await listFilesRecursive(legacyDir);
  if (files.length === 0) {
    await removeEmptyDirectories(legacyDir);
    return report;
  }

  for (const relative of files) {
    const source = path.join(legacyDir, relative);
    const destination = path.join(sharedDir, relative);

    let size: number;
    try {
      size = (await fs.stat(source)).size;
    } catch {
      continue; // vanished under us
    }

    let existing: Awaited<ReturnType<typeof fs.stat>> | null;
    try {
      existing = await fs.stat(destination);
    } catch {
      existing = null;
    }

    try {
      if (existing) {
        if (existing.size !== size) {
          // Two revisions of one file. Declaring either the loser is a guess, and the guess
          // that is wrong destroys the working copy -- so keep both and say which.
          report.conflicts.push(destination);
          continue;
        }
        // Same size, same name, same origin: the shared cache already has this. Removing the
        // repo copy unread is the entire 336 MB saving on two of the three repos measured.
        await fs.rm(source, { force: true });
        report.deduplicated += 1;
        report.bytesFreed += size;
        continue;
      }

      await adoptOne(source, destination, copyFile);
      await fs.rm(source, { force: true });
      report.adopted += 1;
      report.bytesFreed += size;
    } catch {
      // This file stays where it is, whole, and the next upgrade tries again.
    }
  }

  await removeEmptyDirectories(legacyDir);
  return report;
}

export type ModelPrune = { pruned: string[]; bytesFreed: number };

export type ModelPruneOptions = {
  /** Seam for testing the half-deleted-model path, which is the one that must not exist. */
  removeTree?: (target: string) => Promise<void>;
};

/**
 * Remove cached models that no repository on this machine names.
 *
 * Two guards, and the first is the one that matters. **A model named by any known
 * repository's config is never removed, at any age.** That is what stops a running `serve`
 * losing the weights underneath it: the model it loaded is the model its config names.
 *
 * The filesystem will not do that for us, which is worth stating because the opposite is the
 * natural assumption. Measured on this machine: a file held open by another process can be
 * deleted, the delete succeeds, and the holder goes on reading it. Windows does not refuse.
 * So "it is in use" has to be a fact this function knows, not a lock it trips over.
 *
 * The second guard is the horizon, which only ever delays: a model nothing names is kept
 * `MODEL_CACHE_HORIZON_DAYS` past its newest file, so an afternoon of benchmarking survives
 * the next morning's upgrade.
 *
 * Fails closed. An empty keep set means the configs could not be read, not that nothing is
 * wanted, and on the machine this was measured on the difference is 2.5 GB.
 */
export async function pruneModelCache(
  cacheDir: string,
  keepModels: string[],
  now = Date.now(),
  horizonDays = MODEL_CACHE_HORIZON_DAYS,
  options: ModelPruneOptions = {},
): Promise<ModelPrune> {
  const removeTree = options.removeTree ?? (async (target: string) => {
    await fs.rm(target, { recursive: true, force: true });
  });
  const report: ModelPrune = { pruned: [], bytesFreed: 0 };
  if (keepModels.length === 0) return report;

  const keep = new Set(keepModels.map(model => model.split('/').join(path.sep)));
  const cutoff = now - horizonDays * 24 * 60 * 60 * 1000;

  let orgs;
  try {
    orgs = await fs.readdir(cacheDir, { withFileTypes: true });
  } catch {
    return report;
  }

  for (const org of orgs) {
    // A model is `<org>/<name>`, always two levels. A file at the top is not ours, and
    // neither is a directory holding no model directory.
    if (!org.isDirectory()) continue;

    let models;
    try {
      models = await fs.readdir(path.join(cacheDir, org.name), { withFileTypes: true });
    } catch {
      continue;
    }

    for (const model of models) {
      if (!model.isDirectory()) continue;

      // A model an earlier prune took out of the namespace but could not finish deleting.
      // Not a model, not a candidate, just disk to give back.
      if (model.name.endsWith(PRUNING_SUFFIX)) {
        await removeTree(path.join(cacheDir, org.name, model.name)).catch(() => {});
        continue;
      }

      const relative = path.join(org.name, model.name);
      if (keep.has(relative)) continue;

      const dir = path.join(cacheDir, relative);
      const files = await listFilesRecursive(dir);
      if (files.length === 0) continue;

      let newest = 0;
      let bytes = 0;
      for (const file of files) {
        try {
          const stat = await fs.stat(path.join(dir, file));
          newest = Math.max(newest, stat.mtimeMs);
          bytes += stat.size;
        } catch {
          // Gone under us; it costs nothing either way.
        }
      }
      if (newest === 0 || newest > cutoff) continue;

      // Out of the namespace first, in one atomic step, so no reader can ever see a model
      // directory that exists without its weights.
      const condemned = `${dir}.${process.pid}${PRUNING_SUFFIX}`;
      try {
        await fs.rename(dir, condemned);
      } catch {
        // Could not take it out of the way -- something holds it. Leave it whole.
        continue;
      }
      report.pruned.push(dir);

      try {
        await removeTree(condemned);
        // Counted where the space actually comes back. A rename that outlives its delete has
        // pruned the model from the cache but not yet returned the disk.
        report.bytesFreed += bytes;
      } catch {
        // Left for the next prune to collect, under a name that is not a model.
      }
    }

    // An org directory with no models left is an empty shell.
    await fs.rmdir(path.join(cacheDir, org.name)).catch(() => {});
  }

  return report;
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
 * This is NOT the answer to "blast radius full-scans an unindexed LIKE", though it was
 * recorded as one. The premise is right -- `changes LIKE '%<id>%'` leads with a wildcard, and
 * no B-tree can serve that -- but "no index serves this query as written" was read as "this
 * query cannot be made fast", and the two are different claims. Measured on a copy of a real
 * store: compaction takes the scan from 6.49 ms to 0.13 ms at 643 commits, and the same
 * compacted table at 20,000 commits is back to 2.54 ms. It shrinks the bytes, not the rows,
 * and commit rows are never deleted -- so the scan stays O(commits) and that store writes
 * 21.5 of them a day.
 *
 * What actually fixes it is not an index on this column but a column to index:
 * `knowledge_commit_items` records which items a commit touched at write time, which turns
 * the lookup into an equality search. See `blast-radius.ts`. Compaction still earns its
 * place here -- it is 80x fewer bytes in the store -- it just was not a performance fix.
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
  models: {
    /** Files copied out of `<repo>/.knowl/models` into the shared cache. */
    adopted: number;
    /** Files the shared cache already held identically, removed from the repo unread. */
    deduplicated: number;
    /** Bytes returned to the repository's volume by adoption. */
    bytesFreed: number;
    /** Files present in both caches at different sizes. Neither copy was touched. */
    conflicts: string[];
    /** Model directories removed from the shared cache because nothing names them. */
    pruned: string[];
    /** Bytes returned to the shared cache's volume by pruning. */
    prunedBytes: number;
  };
};

/**
 * Where a repository's own weights live, and where the machine's live.
 *
 * Passed in rather than resolved here. `src/ai/embeddings.ts` decides where the cache *is*;
 * this module only decides what happens to what is already sitting in one, and two modules
 * that both compute a path are two modules that can disagree about it.
 */
export type ModelCacheRetention = {
  legacyDir: string;
  sharedDir: string;
  /** Every model any known repository names. Empty means "could not tell", and prunes none. */
  keepModels: string[];
};

/**
 * Every retention rule that is not applied at its own growth point, in one call.
 *
 * Best-effort as a whole: housekeeping must never be the reason an upgrade fails, and every
 * part of it is idempotent, so the next upgrade finishes whatever this one did not.
 * Requires an open database.
 */
export async function runStoreRetention(
  projectRoot: string,
  modelCache?: ModelCacheRetention,
): Promise<RetentionReport> {
  const report: RetentionReport = {
    commits: 0, commitBytesFreed: 0, sessions: 0, claims: 0,
    models: { adopted: 0, deduplicated: 0, bytesFreed: 0, conflicts: [], pruned: [], prunedBytes: 0 },
  };

  // Adopt before pruning, in that order: a model this repo was the last holder of is in the
  // shared cache before anything decides whether the shared cache still needs it.
  if (modelCache) {
    try {
      const adoption = await adoptLegacyModelCache(modelCache.legacyDir, modelCache.sharedDir);
      report.models.adopted = adoption.adopted;
      report.models.deduplicated = adoption.deduplicated;
      report.models.bytesFreed = adoption.bytesFreed;
      report.models.conflicts = adoption.conflicts;
    } catch {
      // Whole files, where they were. Next upgrade.
    }

    try {
      const pruned = await pruneModelCache(modelCache.sharedDir, modelCache.keepModels);
      report.models.pruned = pruned.pruned;
      report.models.prunedBytes = pruned.bytesFreed;
    } catch {
      // As above.
    }
  }

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
