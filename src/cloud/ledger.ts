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

/** Staged and not yet sent. This is exactly what a push has to work through. */
export async function listStaged(workspace: string): Promise<PublishedRecord[]> {
  const result = await getClient().execute({
    sql: `SELECT * FROM cloud_published
          WHERE remote_workspace = ? AND stage_state = 'pending' AND retracted_at IS NULL
          ORDER BY staged_at, item_id`,
    args: [workspace],
  });
  return result.rows.map(row => toRecord(row as unknown as Record<string, unknown>));
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
): Promise<void> {
  await getClient().execute({
    sql: `UPDATE cloud_published SET remote_version = ?, pushed_at = ?, stage_state = 'clear'
          WHERE item_id = ? AND remote_workspace = ?`,
    args: [remoteVersion, new Date().toISOString(), itemId, workspace],
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
    sql: `UPDATE cloud_published SET retracted_at = ?, remote_version = NULL
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
