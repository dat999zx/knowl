import fs from 'node:fs/promises';

/**
 * Reset scratch fixture directories, and FAIL LOUDLY if the reset did not take.
 *
 * FOR FIXTURES WITHOUT A LIVE DATABASE — manifest homes, config dirs, plain files. A directory
 * holding an open libSQL database must NOT use this: on Windows the `-wal`/`-shm` sidecars stay
 * locked until after the test that opened them finishes, so inside `beforeEach` the removal
 * cannot succeed no matter how long it waits, and best-effort really is the honest contract
 * there. Verified, not assumed: forcing it produced EBUSY on `knowl.db-wal` on every single
 * test in the suite.
 *
 * Where it DOES apply, the conventional `.catch(() => {})` is worth replacing. `fs.rm` recursive
 * deletes what it can and throws on the one entry it cannot, so a swallowed failure in
 * `beforeEach` silently hands the test a half-erased fixture. `tests/workspace/resolve.test.ts >
 * names this repo and lists the others as peers` failed deterministically — in isolation, not
 * only under load — with `ENOENT ... .knowl-resolve-home/workspaces/ws/workspace.json`, and
 * passed 6/6 the moment that directory was cleared by hand. The error named a missing manifest;
 * the cause was a fixture that never got cleared. A cleanup failure should report itself as one.
 *
 * Retries before giving up, since a transient handle usually clears within a few hundred
 * milliseconds.
 */
export async function resetScratchDirs(...dirs: string[]): Promise<void> {
  const ATTEMPTS = 5;
  const BACKOFF_MS = 120;

  for (const dir of dirs) {
    let lastError: unknown;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, BACKOFF_MS));
      }
    }

    // `force: true` already makes a missing directory a success, so anything still present
    // here is a directory that refused to go — the case the old swallow hid.
    const stillThere = await fs
      .stat(dir)
      .then(() => true)
      .catch(() => false);

    if (stillThere) {
      throw new Error(
        `Scratch fixture could not be reset: ${dir}\n` +
        `It survived ${ATTEMPTS} removal attempts, so this test would have run against ` +
        `leftover state.\n` +
        `MOST LIKELY CAUSE: this very process still holds a libSQL handle. \`closeDb()\` ` +
        `closes only the ambient connection — peer repositories opened through the ` +
        `connection pool need \`releaseAll()\` as well, and an EBUSY on knowl.db/-wal/-shm ` +
        `is what a missing one looks like. Otherwise: a stray \`knowl serve\` outside the ` +
        `suite, or a leftover directory to delete by hand.` +
        (lastError ? `\nLast error: ${String(lastError)}` : ''),
      );
    }
  }
}
