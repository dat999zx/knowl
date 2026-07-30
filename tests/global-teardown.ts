import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Remove the scratch repositories the suite creates.
 *
 * Every suite already deletes its own fixtures in `afterEach`, and on Windows that removal
 * routinely fails: libSQL holds the `-shm` sidecar until the owning process releases it,
 * which is after the test that created it has finished. The failure is swallowed on purpose
 * -- a locked fixture must not fail an otherwise passing test -- so the directories simply
 * accumulate.
 *
 * That was survivable while fixtures had fixed names and each run reused them. Suites that
 * need genuine per-test isolation now suffix a counter, so a run leaves one directory per
 * test rather than one per fixture, and the count grows with every run.
 *
 * This runs once, in the main process, after every worker has finished with its files.
 */
async function sweep(): Promise<void> {
  const root = process.cwd();
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const scratch = entries.filter(entry => entry.isDirectory() && entry.name.startsWith('.knowl-'));

  let removed = 0;
  for (const entry of scratch) {
    // Still best-effort: a directory a straggling handle keeps alive is left for the next
    // run to collect, which is strictly better than failing the suite over housekeeping.
    try {
      await fs.rm(path.join(root, entry.name), { recursive: true, force: true });
      removed += 1;
    } catch {
      // Left behind; the next run's teardown will pick it up.
    }
  }

  if (scratch.length > removed) {
    console.warn(`[knowl-tests] ${scratch.length - removed} scratch director(ies) still locked; left for the next run.`);
  }
}

/** Clears anything a previous run crashed out of, so a run never starts on stale fixtures. */
export const setup = sweep;

/** Clears this run's, once every worker has released its files. */
export const teardown = sweep;
