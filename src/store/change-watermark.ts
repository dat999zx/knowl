import { getClient } from './database.js';

/**
 * Highest `knowledge_commits` rowid, or 0 when the table is empty.
 *
 * rowid is used as the watermark because it is dense, monotonic, and already
 * present. It is NOT stable across snapshot restore, which reassigns rowids via
 * `INSERT ... SELECT *`; callers must clamp a stored watermark that exceeds head.
 */
export async function readCommitHead(): Promise<number> {
  const row = (await getClient().execute('SELECT MAX(rowid) AS head FROM knowledge_commits')).rows[0];
  const head = row?.head;
  return head === null || head === undefined ? 0 : Number(head);
}
