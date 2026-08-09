import { getClient } from '../store/database.js';

export type SyncState = {
  apiHost: string;
  /**
   * Decimal bigint as a string, always. The server's sequence is a `bigint`, and a JS number
   * loses digits above 2^53 -- a watermark one short skips a commit permanently, which is the
   * failure the gapless sequence was introduced to eliminate.
   */
  since: string | null;
  /** Opaque position inside an incomplete traversal. Non-null means `since` must not move. */
  cursor: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
};

const asText = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

/** Call inside `withTeamStore` -- this reads the ambient database, which must be the replica. */
export async function readSyncState(): Promise<SyncState | null> {
  const result = await getClient().execute(
    'SELECT api_host, since, cursor, last_synced_at, last_error FROM cloud_sync_state WHERE id = 1',
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    apiHost: String(row.api_host),
    since: asText(row.since),
    cursor: asText(row.cursor),
    lastSyncedAt: asText(row.last_synced_at),
    lastError: asText(row.last_error),
  };
}

export async function writeSyncState(state: SyncState): Promise<void> {
  await getClient().execute({
    // Bound as text on both sides of the upsert. Binding `since` as a number would defeat the
    // whole reason it is a string.
    sql: `INSERT INTO cloud_sync_state (id, api_host, since, cursor, last_synced_at, last_error)
          VALUES (1, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            api_host = excluded.api_host,
            since = excluded.since,
            cursor = excluded.cursor,
            last_synced_at = excluded.last_synced_at,
            last_error = excluded.last_error`,
    args: [state.apiHost, state.since, state.cursor, state.lastSyncedAt, state.lastError],
  });
}
