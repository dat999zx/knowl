import type { CloudApi } from './api-client.js';
import { applySyncRows } from './sync-apply.js';
import { readSyncState, writeSyncState } from './sync-state.js';
import { dropTeamStore, withTeamStore } from './team-store.js';

/** A safety stop, not a page budget: a traversal that never returns a null cursor is a bug. */
const DEFAULT_MAX_PAGES = 1_000;

/** Reported out of `traverse` rather than handled inside it -- see `runSync`. */
const RESYNC_REQUIRED = Symbol('resync-required');

export type SyncInput = {
  workspaceId: string;
  apiHost: string;
  configRoot: string;
  api: CloudApi;
  accessToken: string;
  maxPages?: number;
};

export type SyncResult = {
  status: 'synced' | 'incomplete' | 'resynced';
  upserted: number;
  deleted: number;
  pages: number;
  since: string | null;
};

/**
 * Walk the feed until the traversal completes, applying as we go.
 *
 * Pages are applied immediately rather than accumulated: applying is idempotent, so an
 * interrupted sync that delivered nothing would be strictly worse than one that delivered
 * half. What is NOT done early is advancing `since` -- `nextSeq` is constant across a
 * traversal and only means "everything up to here has arrived" once the cursor comes back
 * null. Committing it mid-traversal skips every row the later pages carried.
 */
export async function runSync(input: SyncInput): Promise<SyncResult> {
  const first = await traverse(input);
  if (first !== RESYNC_REQUIRED) return first;

  // Outside the store wrapper, deliberately. `dropTeamStore` closes the connection pool and
  // clears the database the wrapper is holding open, so doing it from inside would tear down
  // the context still unwinding around it. Detect inside, act after.
  await dropTeamStore(input.workspaceId, input.configRoot);
  const second = await traverse(input);
  if (second === RESYNC_REQUIRED) {
    // Twice in a row means the server refused a watermark we had just cleared, which is not a
    // condition a third attempt improves.
    throw new Error(
      'The server asked for a full resync twice in a row. The replica was already rebuilt from ' +
      'scratch, so this is a server-side retention or sequence fault rather than stale local state.',
    );
  }
  return { ...second, status: 'resynced' };
}

async function traverse(input: SyncInput): Promise<SyncResult | typeof RESYNC_REQUIRED> {
  const maxPages = input.maxPages ?? DEFAULT_MAX_PAGES;

  return withTeamStore(input.workspaceId, input.configRoot, async () => {
    const state = await readSyncState();
    let since = state?.since ?? null;
    let cursor = state?.cursor ?? null;
    let upserted = 0;
    let deleted = 0;
    let pages = 0;
    // Carried across pages rather than read from the last one alone: a traversal that fails
    // mid-flight still knows the role every page it did receive agreed on, and the failure
    // writer below has to record something. Starts at whatever the replica already believed.
    let role = state?.role ?? null;

    for (;;) {
      let page;
      try {
        page = await input.api.fetchSyncPage({
          workspaceId: input.workspaceId,
          accessToken: input.accessToken,
          since,
          cursor,
        });
      } catch (error: any) {
        // Recorded so `doctor` can say why the replica is behind. The watermark is untouched,
        // so the next attempt asks for exactly what this one failed to get.
        await writeSyncState({
          apiHost: input.apiHost,
          since: state?.since ?? null,
          cursor: state?.cursor ?? null,
          lastSyncedAt: state?.lastSyncedAt ?? null,
          lastError: String(error?.message ?? error),
          role,
        });
        throw error;
      }

      role = page.role;

      // Not an empty page: the server is refusing our watermark as older than retention.
      // Reading it as "nothing changed" would advance past commits never delivered and leave
      // the replica permanently short, with nothing to reveal it. Reported upward rather than
      // handled here, because the remedy clears the database this callback is running inside.
      if (page.resyncRequired) return RESYNC_REQUIRED;

      pages += 1;
      const outcome = await applySyncRows(page.rows);
      upserted += outcome.upserted;
      deleted += outcome.deleted;

      if (page.cursor === null) {
        since = page.nextSeq;
        cursor = null;
        break;
      }

      cursor = page.cursor;
      if (pages >= maxPages) break;
    }

    const complete = cursor === null;
    await writeSyncState({
      apiHost: input.apiHost,
      // Only a completed traversal moves the watermark. An incomplete one keeps the old
      // `since` and carries the cursor, so the next run resumes instead of restarting.
      since: complete ? since : (state?.since ?? null),
      cursor: complete ? null : cursor,
      lastSyncedAt: new Date().toISOString(),
      lastError: null,
      role,
    });

    return {
      status: complete ? 'synced' : 'incomplete',
      upserted,
      deleted,
      pages,
      since: complete ? since : (state?.since ?? null),
    };
  });
}
