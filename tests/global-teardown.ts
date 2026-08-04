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

/**
 * Evidence that Knowl -- not a person -- created a directory.
 *
 * The sweep used to match on the name alone, and `.knowl-` is a prefix a person reaches for
 * too: benchmark scripts parked under one were deleted mid-session by a test run, silently,
 * because the name matched. So the name only decides what to *look at*; what is inside
 * decides what to remove.
 *
 * Every entry here is something only this codebase writes. Searched two levels deep because
 * the marker is not always at the top: discovery skips dot-named repositories, so those
 * fixtures nest a real repository one level inside a dot-named base.
 */
const KNOWL_ARTIFACTS = new Set([
  '.knowl',        // a scratch repository
  'repos.json',    // a scratch KNOWL_HOME
  'workspaces',
  'resume.db',
  'diagnostics',
  'AGENTS.md',     // guidance files, for a fixture whose .knowl was removed by its own test
  'KNOWL.md',
  'CLAUDE.md',
]);

const MARKER_DEPTH = 2;

/** True when the directory holds something only Knowl writes, or holds nothing at all. */
async function isKnowlScratch(dir: string, depth = MARKER_DEPTH): Promise<boolean> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false; // unreadable: not ours to decide about
  }

  // An empty leftover is a fixture whose contents were removed and whose directory was not.
  // Nothing is lost by collecting it, and it is the most common survivor of a locked -shm.
  if (entries.length === 0) return true;

  for (const entry of entries) {
    if (KNOWL_ARTIFACTS.has(entry.name)) return true;
  }
  if (depth <= 0) return false;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await isKnowlScratch(path.join(dir, entry.name), depth - 1)) return true;
  }
  return false;
}

export type SweepReport = { removed: number; locked: number; spared: string[] };

export async function sweepScratchDirectories(root: string): Promise<SweepReport> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const candidates = entries.filter(entry => entry.isDirectory() && entry.name.startsWith('.knowl-'));

  let removed = 0;
  let locked = 0;
  const spared: string[] = [];

  for (const entry of candidates) {
    const dir = path.join(root, entry.name);
    if (!(await isKnowlScratch(dir))) {
      spared.push(entry.name);
      continue;
    }
    // Still best-effort: a directory a straggling handle keeps alive is left for the next
    // run to collect, which is strictly better than failing the suite over housekeeping.
    try {
      await fs.rm(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      locked += 1;
    }
  }

  if (locked > 0) {
    console.warn(`[knowl-tests] ${locked} scratch director(ies) still locked; left for the next run.`);
  }
  if (spared.length > 0) {
    // Said out loud in both directions. Silence is what turned the old deletion into a
    // mystery, and staying silent about the opposite decision would only move the mystery:
    // a directory that looks swept-up but is not is the next person's confusion.
    console.warn(
      `[knowl-tests] left ${spared.join(', ')} alone: .knowl- prefixed but holding nothing this ` +
      `suite wrote. Rename if it is a fixture that should be collected.`,
    );
  }

  return { removed, locked, spared };
}

/**
 * Teardown only, deliberately.
 *
 * This also ran as `setup`, to clear what a crashed run had left behind. That broke the suite:
 * workers start staggered, and a later worker running setup deleted fixtures the earlier
 * workers were still using -- `tests/cli/cli.test.ts` lost its AGENTS.md mid-assertion, and
 * another test's spawn failed with a missing working directory. Both passed in isolation, which
 * is what made it look like contention rather than deletion.
 *
 * Stale directories from a crashed run are collected by the next run's teardown instead. One
 * run's worth of clutter is a much smaller problem than a sweep that can delete live fixtures.
 */
export const teardown = () => sweepScratchDirectories(process.cwd());
