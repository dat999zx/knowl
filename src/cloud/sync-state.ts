import { getClient } from '../store/database.js';
import type { CloudRole } from './api-client.js';

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
  /**
   * This caller's role in the workspace, as the server reported it on the last sync page.
   *
   * The only way to refuse a reader without a round trip, and it rides on every response for
   * free. NULL means a replica synced by a build that predates the column -- treated as
   * **unknown, not denied**: refusing on missing local state would block a legitimate editor
   * over a column that had not been invented yet.
   */
  role: CloudRole | null;
};

const asText = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

/** Call inside `withTeamStore` -- this reads the ambient database, which must be the replica. */
export async function readSyncState(): Promise<SyncState | null> {
  const result = await getClient().execute(
    'SELECT api_host, since, cursor, last_synced_at, last_error, role FROM cloud_sync_state WHERE id = 1',
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    apiHost: String(row.api_host),
    since: asText(row.since),
    cursor: asText(row.cursor),
    lastSyncedAt: asText(row.last_synced_at),
    lastError: asText(row.last_error),
    role: asRole(row.role),
  };
}

const ROLES = new Set(['owner', 'admin', 'editor', 'reader']);

/** An unrecognised role reads as unknown, not as a role. Nothing here may invent authority. */
const asRole = (value: unknown): CloudRole | null => {
  const text = asText(value);
  return text !== null && ROLES.has(text) ? (text as CloudRole) : null;
};

export async function writeSyncState(state: SyncState): Promise<void> {
  await getClient().execute({
    // Bound as text on both sides of the upsert. Binding `since` as a number would defeat the
    // whole reason it is a string.
    sql: `INSERT INTO cloud_sync_state (id, api_host, since, cursor, last_synced_at, last_error, role)
          VALUES (1, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            api_host = excluded.api_host,
            since = excluded.since,
            cursor = excluded.cursor,
            last_synced_at = excluded.last_synced_at,
            last_error = excluded.last_error,
            role = excluded.role`,
    // `?? null` on the role alone: it is the one field added after this row shape was in use, so
    // it is the one a caller can reach here without. `undefined` is not a value libSQL can bind,
    // and NULL is exactly the right answer -- it reads back as "unknown", which is what a writer
    // that did not mention the role is saying.
    args: [state.apiHost, state.since, state.cursor, state.lastSyncedAt, state.lastError, state.role ?? null],
  });
}
