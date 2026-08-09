import fs from 'node:fs/promises';
import { teamStoreDir, teamStorePath } from '../core/paths.js';
import { releaseClient } from '../store/connection-pool.js';
import { getClient, withDbPath } from '../store/database.js';
import { resolveStorage } from '../store/storage-roles.js';

/**
 * Re-exported so every caller still reaches the replica's location through `cloud/`.
 *
 * The declarations themselves live in `core/paths.ts`: `workspace/resolve.ts` needs to name the
 * replica's file, and `cloud/` sits above `workspace/` in the layer order, so that import would
 * be upward. Moving the path down is what the boundary test asks for; leaving the re-export
 * here is what keeps this module the obvious place to look.
 */
export { teamStoreDir, teamStorePath };

/**
 * The watermark lives INSIDE the replica, not beside it.
 *
 * A watermark that outlived its data would claim commits had been applied to a database that
 * no longer holds them, and the next sync would start above rows it never received. Keeping
 * them in one file makes "delete the replica" a complete, safe reset -- which it must be,
 * because the replica is never a source of truth.
 *
 * `CHECK (id = 1)` because two watermarks is no watermark.
 */
const CREATE_SYNC_STATE = `
CREATE TABLE IF NOT EXISTS cloud_sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  api_host TEXT NOT NULL,
  since TEXT,
  cursor TEXT,
  last_synced_at TEXT,
  last_error TEXT
)`;

/**
 * `configRoot` is the *project's* root, not the replica's.
 *
 * The embedding profile is resolved from the config root, and the replica must be embedded
 * under the same profile as the repo that reads it -- otherwise its vectors are in a space the
 * local ranker filters out, and the replica silently contributes nothing.
 *
 * The project's own database is opened as the OUTER scope purely to carry that config root
 * inward. `withDbPath` keeps the caller's config root when one is already active and otherwise
 * derives it from the database's own path -- and the replica lives at
 * `<knowlHome>/cloud/<id>/knowledge.db`, so deriving would name `<knowlHome>` and pick up a
 * profile belonging to nobody.
 *
 * Both scopes are `withDbPath`, and that is the load-bearing detail rather than a stylistic
 * one. `initDbPath`/`closeDb` operate on the process-wide GLOBAL context, and the MCP server
 * establishes that context exactly once at startup (`server.ts`) and relies on it for the whole
 * of its life. A helper that opened the replica globally and closed it afterwards would leave
 * every later tool call in that process with no database at all -- so this must never be
 * reachable from a query, and `withDbPath` is scoped precisely so that it is not.
 */
export async function openTeamStore(workspaceId: string, configRoot: string): Promise<void> {
  await withTeamStore(workspaceId, configRoot, async () => {});
}

export async function withTeamStore<T>(
  workspaceId: string,
  configRoot: string,
  run: () => Promise<T>,
): Promise<T> {
  await fs.mkdir(teamStoreDir(workspaceId), { recursive: true });
  return withDbPath(resolveStorage(configRoot).knowledge, async () =>
    withDbPath(teamStorePath(workspaceId), async () => {
      await getClient().execute(CREATE_SYNC_STATE);
      return run();
    }));
}

/**
 * Everything the replica holds, cleared in one transaction.
 *
 * Ordered children-first so the deletes stand alone rather than relying on cascade, and the FTS
 * mirror needs no statement of its own -- it is trigger-maintained, so emptying `knowledge_items`
 * empties it too.
 */
const WIPE = [
  'DELETE FROM knowledge_evidence',
  'DELETE FROM evidence',
  'DELETE FROM knowledge_items',
  'DELETE FROM cloud_sync_state',
];

/**
 * Leave the replica empty, by deletion where that works and by truncation where it does not.
 *
 * The caller that matters is a resync, and what it needs is an empty replica -- not, in itself,
 * an absent file. Those differ on Windows: measured here, the `-shm` sidecar stays locked for
 * well over five seconds after `closeDb` and `releaseClient` have closed and WAL-checkpointed
 * every pooled handle, so `fs.rm` fails no matter how long it backs off. `store/retention.ts`
 * and the test global teardown record the same behaviour. Removing the directory is therefore
 * attempted, because it is the cleaner reset and it does work off Windows, but it cannot be the
 * guarantee.
 *
 * The truncation fallback is the guarantee, and it is a single transaction. Swallowing a failed
 * reset would leave every stale row in place and then apply a fresh traversal on top of it,
 * producing a replica holding atoms the server has already retracted while its watermark claims
 * it is current -- undetectable from the inside. Both paths therefore either leave nothing
 * behind or throw.
 */
export async function dropTeamStore(workspaceId: string, configRoot: string): Promise<void> {
  // `releaseClient` names the file directly, closing both its read-only and writable views and
  // checkpointing the writable one. Deliberately NOT `closeDb`: that releases the whole pool
  // and clears the process-wide global context, which here belongs to whoever called us -- the
  // MCP server opens its database once at startup and never reopens it.
  await releaseClient(teamStorePath(workspaceId));

  const removed = await fs
    // Barely any retries on purpose. A lock held by an antivirus scanner clears in a moment and
    // is worth one more attempt; the Windows sidecar lock does not clear on any timescale worth
    // blocking a resync for, and the truncation below handles it. Backing off harder only made
    // the drop take five seconds before reaching the fallback that was always going to run.
    .rm(teamStoreDir(workspaceId), { recursive: true, force: true, maxRetries: 2, retryDelay: 25 })
    .then(() => true, () => false);
  if (removed) return;

  await withTeamStore(workspaceId, configRoot, async () => {
    await getClient().batch(WIPE, 'write');
  });
}
