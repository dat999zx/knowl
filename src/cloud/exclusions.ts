import { getClient } from '../store/database.js';

export type ExclusionRecord = {
  itemId: string;
  excludedAt: string;
  reason: string | null;
};

/**
 * Never publish this atom, whatever else happens.
 *
 * Workspace-independent by design: this runs from `knowl store --local` in repositories that
 * may not be connected to anything, and "machine-local knowledge" is a fact about the atom
 * rather than about one team.
 *
 * Idempotent, with the newer reason winning. Re-excluding something already excluded is a
 * restatement of the same intent, and failing it would make `--local` unusable on a second edit.
 */
export async function excludeFromPublish(itemId: string, reason: string | null = null): Promise<void> {
  await getClient().execute({
    sql: `INSERT INTO cloud_excluded (item_id, excluded_at, reason)
          VALUES (?, ?, ?)
          ON CONFLICT (item_id) DO UPDATE SET
            excluded_at = excluded.excluded_at,
            reason = excluded.reason`,
    args: [itemId, new Date().toISOString(), reason],
  });
}

/**
 * Withdraw an exclusion. Does not stage anything.
 *
 * Deleting the row rather than tombstoning it: an exclusion carries no history worth keeping,
 * and unlike `remote_version` there is nothing here that only this machine knows.
 */
export async function clearExclusion(itemId: string): Promise<void> {
  await getClient().execute({
    sql: 'DELETE FROM cloud_excluded WHERE item_id = ?',
    args: [itemId],
  });
}

export async function isExcluded(itemId: string): Promise<boolean> {
  const result = await getClient().execute({
    sql: 'SELECT 1 FROM cloud_excluded WHERE item_id = ?',
    args: [itemId],
  });
  return result.rows.length > 0;
}

export async function listExcluded(): Promise<ExclusionRecord[]> {
  const result = await getClient().execute(
    'SELECT item_id, excluded_at, reason FROM cloud_excluded ORDER BY excluded_at, item_id',
  );
  return result.rows.map(row => ({
    itemId: String(row.item_id),
    excludedAt: String(row.excluded_at),
    reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
  }));
}

/**
 * The ids that may still be staged, in the order given.
 *
 * One query rather than one per id: the category sweep and the auto-stage seam both call this
 * with a whole batch, and a per-id check turns a sweep into hundreds of round trips.
 */
export async function filterExcluded(itemIds: string[]): Promise<string[]> {
  if (itemIds.length === 0) return [];
  const placeholders = itemIds.map(() => '?').join(', ');
  const result = await getClient().execute({
    sql: `SELECT item_id FROM cloud_excluded WHERE item_id IN (${placeholders})`,
    args: itemIds,
  });
  const excluded = new Set(result.rows.map(row => String(row.item_id)));
  return itemIds.filter(itemId => !excluded.has(itemId));
}
