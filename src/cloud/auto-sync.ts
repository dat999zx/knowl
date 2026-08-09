import path from 'node:path';
import type { ProjectConfig } from '../core/types.js';
import { teamStoreDir } from '../core/paths.js';
import { acquireLock } from './file-lock.js';
import { runPull } from './pull.js';
import { readSyncState } from './sync-state.js';
import { withTeamStore } from './team-store.js';

/**
 * Short, because arrival is announced rather than waited for.
 *
 * Sixty seconds is indistinguishable from instant in practice -- nobody publishes and expects a
 * colleague to see it within a minute -- while costing a fraction of the requests a per-query
 * check would. The notice in `team-update.ts` is what makes the gap safe; this only decides how
 * often we look.
 */
export const AUTO_SYNC_INTERVAL_MS = 60_000;

export async function shouldAutoSync(
  workspaceId: string,
  configRoot: string,
  now: () => number = Date.now,
): Promise<boolean> {
  const state = await withTeamStore(workspaceId, configRoot, () => readSyncState()).catch(() => null);
  if (!state?.lastSyncedAt) return true;

  const last = Date.parse(state.lastSyncedAt);
  // An unparseable timestamp is treated as due. "I cannot tell" must never read as "no need":
  // the failure mode of guessing wrong is a replica that silently stops syncing forever.
  if (Number.isNaN(last)) return true;
  return now() - last >= AUTO_SYNC_INTERVAL_MS;
}

function autoSyncLockPath(workspaceId: string): string {
  return path.join(teamStoreDir(workspaceId), 'auto-sync.lock');
}

/**
 * Fire a sync and return immediately. Never awaited, never throws.
 *
 * The query answers from the replica on disk; this only decides what the NEXT query will see.
 * Awaiting it would put a network round trip back on a path the whole sync-down architecture
 * exists to keep off -- the Knowl workflow queries before every subtask, so the cost is paid
 * several times a turn.
 *
 * Single-flight for the same reason the token refresh is: one long-lived MCP server plus a CLI
 * spawned by every hook means "check, then sync" run naively is a thundering herd against our
 * own server. Losing the lock means doing nothing, not queueing.
 *
 * Everything below reaches the replica through `withTeamStore`, which is scoped rather than
 * global. That is what makes firing this from a live request safe: this runs detached and
 * therefore CONCURRENTLY with the query that started it, so a helper touching the process-wide
 * database context would corrupt a request that had already returned its answer.
 */
export function maybeAutoSync(input: { projectRoot: string; config: ProjectConfig; now?: () => number }): void {
  const pointer = input.config.cloud;
  if (!pointer) return;

  void (async () => {
    try {
      if (!await shouldAutoSync(pointer.workspaceId, input.projectRoot, input.now)) return;
      const release = await acquireLock(autoSyncLockPath(pointer.workspaceId));
      if (!release) return;
      try {
        await runPull({ projectRoot: input.projectRoot, config: input.config });
      } finally {
        await release();
      }
    } catch {
      // Swallowed deliberately. A background refresh that cannot reach the server must not
      // surface as an error on an unrelated query the caller already has an answer for --
      // `doctor` reports the lag, and `lastError` records the reason.
    }
  })();
}
