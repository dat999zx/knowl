import { getClient } from '../store/database.js';

export type PublishedRecord = {
  itemId: string;
  remoteWorkspace: string;
  /** The server's version, once a push was confirmed. NULL while an item is only staged. */
  remoteVersion: number | null;
  stagedAt: string;
  stagedOnBranch: string | null;
  pushedAt: string | null;
  retractedAt: string | null;
  /** Explicit since level 10. `pending` is what a push works through. */
  stageState: 'pending' | 'clear';
  /** The atom's hashes as of the last confirmed push. NULL for a row that predates the columns. */
  remoteContentHash: string | null;
  remoteLifecycleHash: string | null;
};

const asText = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

function toRecord(row: Record<string, unknown>): PublishedRecord {
  return {
    itemId: String(row.item_id),
    remoteWorkspace: String(row.remote_workspace),
    remoteVersion: row.remote_version === null || row.remote_version === undefined
      ? null
      : Number(row.remote_version),
    stagedAt: String(row.staged_at),
    stagedOnBranch: asText(row.staged_on_branch),
    pushedAt: asText(row.pushed_at),
    retractedAt: asText(row.retracted_at),
    stageState: String(row.stage_state) === 'pending' ? 'pending' : 'clear',
    remoteContentHash: asText(row.remote_content_hash),
    remoteLifecycleHash: asText(row.remote_lifecycle_hash),
  };
}

/**
 * Record the intent to publish. Sends nothing.
 *
 * `ON CONFLICT DO NOTHING` rather than an upsert, because re-staging must be a no-op and not a
 * reset: an atom already pushed carries the `remote_version` every republish needs, and a
 * second `knowl cloud stage` naming it would otherwise blank that number and turn the next push
 * into a conflict the user cannot explain.
 *
 * Returns how many rows were newly staged, which is not the same as how many ids were asked
 * for -- already-pushed and already-staged ids are silently the same request.
 */
export async function stageForPublish(
  itemIds: string[],
  workspace: string,
  branch: string | null,
): Promise<number> {
  if (itemIds.length === 0) return 0;
  const stagedAt = new Date().toISOString();
  let staged = 0;
  for (const itemId of itemIds) {
    const result = await getClient().execute({
      sql: `INSERT INTO cloud_published (item_id, remote_workspace, staged_at, staged_on_branch, stage_state)
            VALUES (?, ?, ?, ?, 'pending')
            ON CONFLICT (item_id, remote_workspace) DO UPDATE SET
              staged_at = excluded.staged_at,
              staged_on_branch = excluded.staged_on_branch,
              stage_state = 'pending'
            WHERE cloud_published.pushed_at IS NULL`,
      args: [itemId, workspace, stagedAt, branch],
    });
    staged += Number(result.rowsAffected ?? 0);
  }
  return staged;
}

/**
 * Stage again, deliberately, something this machine has already pushed.
 *
 * The distinction from `stageForPublish` is who asked. A sweep (`--category decision`) means
 * "publish the decisions that are not published", so an already-pushed atom is not part of the
 * request and re-sending it would spend a version bump and an embedding job on identical content.
 * Naming an id (`--id abc`) means "publish this", about an item the caller has in hand -- the
 * only way to send a correction, and the request is meaningless if it silently does nothing.
 *
 * Neither `remote_version` nor `pushed_at` is cleared. The version is the only copy of that
 * number on this machine and the republish this call exists to enable is exactly what needs it.
 * `pushed_at` used to be nulled here to signal "staged again", which destroyed the record of when
 * the atom was last sent and left `unstage` with nothing to restore -- `stage_state` carries that
 * signal now.
 */
export async function restageForPublish(
  itemIds: string[],
  workspace: string,
  branch: string | null,
): Promise<number> {
  if (itemIds.length === 0) return 0;
  const stagedAt = new Date().toISOString();
  let staged = 0;
  for (const itemId of itemIds) {
    const result = await getClient().execute({
      sql: `INSERT INTO cloud_published (item_id, remote_workspace, staged_at, staged_on_branch, stage_state)
            VALUES (?, ?, ?, ?, 'pending')
            ON CONFLICT (item_id, remote_workspace) DO UPDATE SET
              staged_at = excluded.staged_at,
              staged_on_branch = excluded.staged_on_branch,
              stage_state = 'pending',
              retracted_at = NULL`,
      args: [itemId, workspace, stagedAt, branch],
    });
    staged += Number(result.rowsAffected ?? 0);
  }
  return staged;
}

/**
 * Staged, but byte-for-byte what the server was last given.
 *
 * The atom was re-staged -- by an explicit `knowl cloud stage --id`, or by a write that rewrote
 * it to the same bytes -- and there is nothing to send. Sending it anyway costs a version bump
 * the server applies unconditionally, and that version then reaches every replica on its next
 * pull, so one no-op push is a round of sync traffic for the whole team.
 *
 * `IS` rather than `=` throughout: SQLite's `=` is unknown when either side is NULL, and a
 * hash is nullable on both sides. `IS` compares nulls as equal, which is the intended reading --
 * an atom with no content hash then and no content hash now has not changed.
 *
 * `remote_content_hash IS NOT NULL` gates the whole rule, so a row from before these columns
 * existed never matches and is always sent. Failing toward sending is the recoverable direction:
 * a redundant push spends a version, a wrongly skipped one strands a correction locally with
 * nothing to reveal it.
 *
 * Both hashes must match. Content alone would treat a retirement -- `status` and `freshness`
 * live in the lifecycle hash -- as an unchanged atom.
 *
 * `LEFT JOIN`, deliberately. A staged id whose atom is gone entirely is *missing*, and the push
 * reports that case its own way; an inner join would drop it here and turn a reportable problem
 * into a silent one.
 */
const UNCHANGED_SINCE_PUSH = `
  p.remote_content_hash IS NOT NULL
  AND p.remote_content_hash IS k.content_hash
  AND p.remote_lifecycle_hash IS k.lifecycle_hash`;

/**
 * Staged and not yet sent. This is exactly what a push has to work through.
 *
 * Excludes atoms identical to what was already pushed, so `knowl cloud status` and the push
 * itself agree on one number. `clearUnchangedStaged` settles the same rows in the table; this
 * filter is what keeps a read honest before that has run.
 */
export async function listStaged(workspace: string): Promise<PublishedRecord[]> {
  const result = await getClient().execute({
    sql: `SELECT p.* FROM cloud_published p
          LEFT JOIN knowledge_items k ON k.id = p.item_id
          WHERE p.remote_workspace = ? AND p.stage_state = 'pending' AND p.retracted_at IS NULL
            AND NOT (${UNCHANGED_SINCE_PUSH})
          ORDER BY p.staged_at, p.item_id`,
    args: [workspace],
  });
  return result.rows.map(row => toRecord(row as unknown as Record<string, unknown>));
}

/**
 * Settle the rows `listStaged` filters out, so the queue does not accumulate them forever.
 *
 * Run at the start of a push rather than from the read, because a read that writes is a surprise
 * and `knowl cloud status` is a read. The filter and this statement share one predicate so the
 * two cannot drift apart.
 *
 * Returns how many were settled, which is worth reporting: "3 unchanged" is the difference
 * between a push that did nothing and a push that was not needed.
 */
export async function clearUnchangedStaged(workspace: string): Promise<number> {
  const result = await getClient().execute({
    sql: `UPDATE cloud_published SET stage_state = 'clear'
          WHERE remote_workspace = ? AND stage_state = 'pending' AND retracted_at IS NULL
            AND item_id IN (
              SELECT p.item_id FROM cloud_published p
              JOIN knowledge_items k ON k.id = p.item_id
              WHERE p.remote_workspace = ? AND p.stage_state = 'pending'
                AND p.retracted_at IS NULL AND ${UNCHANGED_SINCE_PUSH}
            )`,
    args: [workspace, workspace],
  });
  return Number(result.rowsAffected ?? 0);
}

/**
 * Staged rows whose atom is no longer active.
 *
 * Staging filters on `status = 'active'`, but nothing revisits a row afterwards -- so an atom
 * superseded AFTER it was queued keeps `stage_state = 'pending'` and goes on being counted. One
 * number the user cannot reconcile against what a push reports reads as a broken push rather than
 * as an atom that was replaced, which is the whole of knowl#104.
 *
 * An INNER JOIN deliberately: a staged id whose row is gone entirely is *missing*, not retired,
 * and the push already reports that case its own way. Counting it here would name a remedy --
 * "it was superseded" -- that is not the one the user needs.
 */
export async function countInactiveStaged(workspace: string): Promise<number> {
  const result = await getClient().execute({
    sql: `SELECT COUNT(*) AS n
          FROM cloud_published p JOIN knowledge_items k ON k.id = p.item_id
          WHERE p.remote_workspace = ? AND p.stage_state = 'pending'
            AND p.retracted_at IS NULL AND k.status <> 'active'`,
    args: [workspace],
  });
  return Number(result.rows[0]?.n ?? 0);
}

/** Already sent and accepted. What this machine has put in front of the team. */
export async function listPushed(workspace: string): Promise<PublishedRecord[]> {
  const result = await getClient().execute({
    sql: `SELECT * FROM cloud_published
          WHERE remote_workspace = ? AND pushed_at IS NOT NULL
          ORDER BY pushed_at, item_id`,
    args: [workspace],
  });
  return result.rows.map(row => toRecord(row as unknown as Record<string, unknown>));
}

/**
 * Confirm a push, with the version the server returned.
 *
 * Called per accepted outcome and never for a conflict or a foreign origin -- an atom the server
 * did not take stays staged, so the next run retries exactly it and no more.
 */
export async function recordPushed(
  itemId: string,
  workspace: string,
  remoteVersion: number,
  /**
   * The hashes of the payload that was actually SENT, taken from that payload and never re-read
   * from the store. A fresh read here would record what the atom says now, and an edit landing
   * between the send and this write would then look already-published and never be sent -- the
   * same window `PushSnapshot` exists to close, reopened at the last step.
   */
  hashes: { contentHash: string | null; lifecycleHash: string | null },
): Promise<void> {
  await getClient().execute({
    sql: `UPDATE cloud_published
          SET remote_version = ?, pushed_at = ?, stage_state = 'clear',
              remote_content_hash = ?, remote_lifecycle_hash = ?
          WHERE item_id = ? AND remote_workspace = ?`,
    args: [
      remoteVersion, new Date().toISOString(),
      hashes.contentHash, hashes.lifecycleHash,
      itemId, workspace,
    ],
  });
}

/**
 * Record that the server accepted a retraction.
 *
 * `remote_version` is cleared with it, and that is the load-bearing half. The row is kept rather
 * than deleted so `knowl cloud status` can say this machine retracted the atom instead of
 * silently forgetting it ever published one -- but a version left behind would be a claim about
 * a server-side row that no longer exists, and the next `knowl cloud stage --id` naming this atom
 * would send it as `expectedVersion` and be refused by a tombstone it could not see.
 *
 * Re-staging deliberately clears `retracted_at` (see `restageForPublish`): retracting is not a
 * ban on the id, it is the removal of what was there. The server disagrees and refuses the
 * republish, which is the safer of the two and the one that wins.
 */
export async function recordRetracted(itemId: string, workspace: string): Promise<void> {
  await getClient().execute({
    sql: `UPDATE cloud_published
          SET retracted_at = ?, remote_version = NULL,
              remote_content_hash = NULL, remote_lifecycle_hash = NULL
          WHERE item_id = ? AND remote_workspace = ?`,
    args: [new Date().toISOString(), itemId, workspace],
  });
}

/**
 * The version to send as `expectedVersion`, or null on a first publish.
 *
 * Scoped to the workspace because one atom may be published to more than one, and a version
 * from one workspace is a claim about a row the other does not have.
 */
export async function publishedVersion(itemId: string, workspace: string): Promise<number | null> {
  const result = await getClient().execute({
    sql: 'SELECT remote_version FROM cloud_published WHERE item_id = ? AND remote_workspace = ?',
    args: [itemId, workspace],
  });
  const value = result.rows[0]?.remote_version;
  return value === null || value === undefined ? null : Number(value);
}

/**
 * Take an atom out of the queue without unpublishing it.
 *
 * Never `DELETE`. The row holds `remote_version`, the only copy of the server's version on this
 * machine, and knowl-cloud treats a republish arriving without `expectedVersion` as a conflict by
 * design -- so deleting the row to unstage a correction would leave the atom unpushable
 * afterwards. Clearing the state is the whole operation.
 *
 * Returns whether anything was actually pending, so a caller can tell "unstaged" from "there was
 * nothing to unstage" rather than reporting success for a no-op.
 */
export async function unstagePublish(itemId: string, workspace: string): Promise<boolean> {
  const result = await getClient().execute({
    sql: `UPDATE cloud_published SET stage_state = 'clear'
          WHERE item_id = ? AND remote_workspace = ? AND stage_state = 'pending'`,
    args: [itemId, workspace],
  });
  return Number(result.rowsAffected ?? 0) > 0;
}
