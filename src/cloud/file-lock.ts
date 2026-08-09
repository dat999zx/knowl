import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_STALE_MS = 30_000;

/**
 * A cross-process mutex, where losing means doing nothing.
 *
 * `wx` is an atomic create-if-absent at the filesystem level, so two processes racing cannot
 * both succeed. The loser returns `null` rather than queueing: the callers here are a
 * long-lived MCP server and a CLI spawned by every hook, so a queue would turn one slow
 * refresh into every process blocking behind it.
 *
 * Staleness is required, not a nicety. A holder killed between create and release leaves the
 * file forever, and without a break the only remedy is deleting a file the user does not know
 * exists.
 */
export async function acquireLock(
  lockPath: string,
  options: { staleMs?: number } = {},
): Promise<(() => Promise<void>) | null> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  const release = async (): Promise<void> => {
    // `force` so a second release, or a release after another process broke our stale lock,
    // is a no-op rather than an error thrown from a cleanup path.
    await fs.rm(lockPath, { force: true }).catch(() => {});
  };

  try {
    const handle = await fs.open(lockPath, 'wx');
    await handle.close();
    return release;
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
  }

  const stat = await fs.stat(lockPath).catch(() => null);
  if (!stat || Date.now() - stat.mtimeMs < staleMs) return null;

  // Break it and take it. A second breaker can win the race here and both would believe they
  // hold it; that is acceptable because the guarded operation re-reads state under the lock
  // and is idempotent -- see `ensureAccessToken`.
  await fs.rm(lockPath, { force: true }).catch(() => {});
  try {
    const handle = await fs.open(lockPath, 'wx');
    await handle.close();
    return release;
  } catch {
    return null;
  }
}
