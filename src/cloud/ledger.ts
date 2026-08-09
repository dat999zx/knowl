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
  };
}

/**
 * Record the intent to publish. Sends nothing.
 *
 * `ON CONFLICT DO NOTHING` rather than an upsert, because re-staging must be a no-op and not a
 * reset: an atom already pushed carries the `remote_version` every republish needs, and a
 * second `knowl publish` naming it would otherwise blank that number and turn the next push
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
      sql: `INSERT INTO cloud_published (item_id, remote_workspace, staged_at, staged_on_branch)
            VALUES (?, ?, ?, ?)
            ON CONFLICT (item_id, remote_workspace) DO NOTHING`,
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
          WHERE remote_workspace = ? AND pushed_at IS NULL AND retracted_at IS NULL
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
    sql: `UPDATE cloud_published SET remote_version = ?, pushed_at = ?
          WHERE item_id = ? AND remote_workspace = ?`,
    args: [remoteVersion, new Date().toISOString(), itemId, workspace],
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
