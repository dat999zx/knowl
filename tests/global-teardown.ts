import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Remove the scratch repositories and scratch temporary directories the suite creates.
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
 *
 * There are two fixture conventions and this file used to know about only one. Four call
 * sites build fixtures under the repository root with a `.knowl-` name; forty build them in
 * `os.tmpdir()` with a dotless `knowl-` name, and the sweep below never looks there. Measured
 * on Windows 2026-08-06: 28,524 `knowl-*` directories totalling 5.7 GB in `%TEMP%`, roughly
 * 1.9 GB for every day the suite was run. `setup` closes that gap -- see it for how.
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

/**
 * A libSQL database and its sidecars.
 *
 * Some suites never build a repository at all -- `.knowl-pool-test`, `.knowl-bootstrap-test`
 * and `.knowl-schema-version-test` hold nothing but bare `*.db` files -- and the first
 * version of this predicate left all three behind on a full run. They are also the suites
 * whose files Windows is most likely to still be holding, which is the case the sweep exists
 * for in the first place.
 */
const DATABASE_FILE = /\.db(-shm|-wal)?$/;

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
    if (entry.isFile() && DATABASE_FILE.test(entry.name)) return true;
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
  const candidates = entries.filter(entry => entry.name.startsWith('.knowl-'));

  let removed = 0;
  let locked = 0;
  const spared: string[] = [];

  for (const entry of candidates) {
    const target = path.join(root, entry.name);

    // A bare database parked beside the repository rather than inside a fixture directory.
    // `tests/store/namespace-concurrency.test.ts` opens its namespace database that way, and
    // Windows holds the handle past that suite's own removal -- measured, EBUSY on the file
    // and both sidecars. This sweep only looked at directories, so those three survived every
    // run and accumulated in the repository root.
    //
    // The evidence here is weaker than for a directory, and deliberately narrower to
    // compensate: a file has no contents this can reason about, so the name and the extension
    // are all there is, and BOTH have to match -- the `.knowl-` prefix and the libSQL file
    // shape. `.knowl-notes.md` is a person's file and stays.
    if (entry.isFile()) {
      if (!DATABASE_FILE.test(entry.name)) {
        spared.push(entry.name);
        continue;
      }
      try {
        await fs.rm(target, { force: true });
        removed += 1;
      } catch {
        locked += 1;
      }
      continue;
    }

    if (!entry.isDirectory()) continue;

    if (!(await isKnowlScratch(target))) {
      spared.push(entry.name);
      continue;
    }
    // Still best-effort: a directory a straggling handle keeps alive is left for the next
    // run to collect, which is strictly better than failing the suite over housekeeping.
    try {
      await fs.rm(target, { recursive: true, force: true });
      removed += 1;
    } catch {
      locked += 1;
    }
  }

  if (locked > 0) {
    console.warn(`[knowl-tests] ${locked} scratch fixture(s) still locked; left for the next run.`);
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

/** Name of every fixture root this run creates, and the env var that carries it to workers. */
const RUN_ROOT_PREFIX = 'knowl-run-';
export const RUN_ROOT_ENV = 'KNOWL_TEST_TMP_ROOT';

/** The variables `os.tmpdir()` consults: TMPDIR first on POSIX, TEMP first on Windows. */
const TMPDIR_ENV_KEYS = ['TMPDIR', 'TMP', 'TEMP'] as const;

/**
 * How old a stray `knowl-` directory in the real temporary directory must be before this
 * collects it.
 *
 * `%TEMP%` is shared with every other process on the machine, including a second `npm test`
 * in another terminal, so nothing here may assume it owns what it finds. An hour is far longer
 * than any fixture stays untouched inside a live run -- a running suite's root has its mtime
 * refreshed every time a worker creates or removes a fixture inside it -- and far shorter than
 * a developer will tolerate the residue.
 */
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * Names that mean a person works in this directory, whatever else it holds.
 *
 * A checkout of *this* repository satisfies `isKnowlScratch` on its first entry: it contains
 * `KNOWL.md`, `CLAUDE.md` and a `.knowl` of its own. A git worktree parked in the temporary
 * directory under a `knowl-` name -- which is a thing done in this project, `knowl-pr7` -- would
 * therefore be indistinguishable from a fixture, and deleting one takes uncommitted work with
 * it. Checked at the top level only: a fixture that is itself a scratch git repository sits one
 * level down inside a run root, so vetoing on a nested `.git` would spare the run root too.
 */
const WORKING_DIRECTORY_MARKERS = new Set(['.git', 'node_modules', 'package.json']);

/**
 * The real temporary directory, captured before `setup` redirects it.
 *
 * `setup` points `os.tmpdir()` at this run's own root, and that redirect is inherited by the
 * main process as well as the workers. Teardown has to sweep the directory the redirect
 * replaced, so the original is kept here rather than re-read.
 */
let systemTmpdir = os.tmpdir();

/** This run's fixture root, or undefined when `setup` did not run. */
let runRoot: string | undefined;

/** What the redirected variables held before `setup`, so teardown can put them back. */
const originalTmpdirEnv = new Map<string, string | undefined>();

/**
 * Give the whole run one temporary directory, so leaving fixtures behind costs one directory
 * rather than thousands.
 *
 * Thirty test files call `mkdtemp` in `os.tmpdir()`, and on Windows their own `afterEach`
 * removal fails against a libSQL handle the worker holds until it exits -- correctly swallowed,
 * because housekeeping must not fail a passing test, but nothing ever revisited the directory.
 * Redirecting `os.tmpdir()` fixes every one of those call sites without touching any of them,
 * and keeps fixing the ones written next year: a test that reaches for the temporary directory
 * gets a contained one whether or not its author knew to ask.
 *
 * `os.tmpdir()` reads these variables on every call, and vitest's workers inherit the
 * environment of the process this runs in, so setting them here is enough -- verified against
 * a worker's top-level `os.tmpdir()`, not assumed.
 *
 * This deletes nothing, which is the whole reason it is allowed to exist: see `teardown` for
 * the setup-time sweep that had to be removed.
 */
export async function setup(): Promise<void> {
  // realpath because macOS reports `os.tmpdir()` as `/var/folders/...`, a symlink to
  // `/private/var/folders/...`. A spawned CLI resolves its own cwd, so a fixture handed out
  // under the symlinked form compares unequal to the same directory as the child sees it, and
  // every guard deciding identity by comparing paths silently stops matching. Not hypothetical:
  // it turned `knowl init` refusals into successes on the macOS CI leg while Linux and Windows
  // stayed green. Canonicalising the parent fixes every caller at once, because this is the
  // value the TMPDIR variables below hand to `os.tmpdir()` in the workers.
  //
  // The parent and not just the run root: `sweepOrphanedTemporaryRoots` decides what to skip
  // with `path.resolve(target) === path.resolve(skip)`, and `path.resolve` normalises without
  // resolving symlinks. A canonical run root under a symlinked parent would compare unequal to
  // itself there, and the sweep would stop recognising its own live root.
  systemTmpdir = await fs.realpath(os.tmpdir());
  // mkdtemp rather than a name of our own: two suites can be running at once, and each must
  // own its root outright or the concurrency hazard just moves up a level.
  runRoot = await fs.mkdtemp(path.join(systemTmpdir, RUN_ROOT_PREFIX));
  for (const key of TMPDIR_ENV_KEYS) {
    originalTmpdirEnv.set(key, process.env[key]);
    process.env[key] = runRoot;
  }
  process.env[RUN_ROOT_ENV] = runRoot;
}

/** True when nothing has touched this directory for `minAgeMs`. */
async function isStale(target: string, now: number, minAgeMs: number): Promise<boolean> {
  const stats = await fs.stat(target).catch(() => null);
  if (!stats) return false;
  // The most recent of the three, so a directory is only ever judged stale when every clock
  // agrees it is. Creating and removing fixtures inside a run root refreshes its mtime, which
  // is what keeps a long but live run from looking abandoned.
  const touched = Math.max(stats.mtimeMs, stats.ctimeMs, stats.birthtimeMs);
  return now - touched >= minAgeMs;
}

/** True when a person works in this directory, whatever Knowl artifacts it also holds. */
async function isWorkingDirectory(dir: string): Promise<boolean> {
  const entries = await fs.readdir(dir).catch(() => []);
  return entries.some(name => WORKING_DIRECTORY_MARKERS.has(name));
}

/**
 * Remove this run's own temporary root.
 *
 * No guard of any kind, and none is needed: `setup` created this directory for this run and
 * nothing else has ever been told where it is. That is the entire point of routing fixtures
 * through it -- the ownership question that makes a bare `%TEMP%` sweep hazardous is answered
 * at creation time instead of guessed at deletion time.
 *
 * Child by child, so one fixture Windows is still holding cannot strand the rest of the run
 * behind it. Whatever survives keeps the root alive, and the next run's orphan pass gets it.
 */
export async function removeRunTemporaryRoot(root: string): Promise<SweepReport> {
  let removed = 0;
  let locked = 0;

  const children = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const child of children) {
    try {
      await fs.rm(path.join(root, child.name), { recursive: true, force: true });
      removed += 1;
    } catch {
      locked += 1;
    }
  }

  // Retrying, and not a plain `rmdir`. Windows keeps a just-removed directory in a
  // delete-pending state until the last handle to it closes, so the parent can still look
  // non-empty for a moment after the loop above has emptied it -- measured: a run whose last
  // act was removing fixtures left its root behind, empty, every time. `fs.rm` backs off and
  // retries on exactly the EBUSY/ENOTEMPTY/EPERM this produces.
  const rootRemoved = await fs
    .rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    .then(() => true, () => false);
  // If the root went, nothing survived inside it, whatever the individual attempts reported.
  if (rootRemoved) locked = 0;

  return { removed, locked, spared: [] };
}

/**
 * Collect what earlier runs died before collecting.
 *
 * Unlike the run root, nothing here is ours by construction: `%TEMP%` is shared with every
 * other process on the machine, including a second `npm test` in another terminal. So a
 * candidate has to clear three independent guards -- an age threshold, the same content-marker
 * predicate the repository sweep uses, and the working-directory veto -- because the cost of a
 * false positive here is somebody else's work, not a directory.
 */
export async function sweepOrphanedTemporaryRoots(
  tmpRoot: string,
  options: { skip?: string; now?: number; minAgeMs?: number } = {},
): Promise<SweepReport> {
  const now = options.now ?? Date.now();
  const minAgeMs = options.minAgeMs ?? ORPHAN_MIN_AGE_MS;

  let removed = 0;
  let locked = 0;
  const spared: string[] = [];

  const entries = await fs.readdir(tmpRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    // Directories only. A loose file in a directory this size is evidence of nothing, and no
    // suite has ever put one there -- fixtures start with `mkdtemp`.
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith('knowl-')) continue;

    const target = path.join(tmpRoot, entry.name);
    if (options.skip && path.resolve(target) === path.resolve(options.skip)) continue;

    // Young: a suite running in another terminal, or one that started while this one ran.
    // Silently left -- this is the ordinary case, not something to report.
    if (!(await isStale(target, now, minAgeMs))) continue;

    if (await isWorkingDirectory(target)) {
      spared.push(entry.name);
      continue;
    }
    if (!(await isKnowlScratch(target))) {
      spared.push(entry.name);
      continue;
    }

    try {
      await fs.rm(target, { recursive: true, force: true });
      removed += 1;
    } catch {
      locked += 1;
    }
  }

  return { removed, locked, spared };
}

/** Said out loud, in both directions, for the same reason the repository sweep says it. */
function reportTemporarySweep(report: SweepReport, tmpRoot: string): void {
  if (report.locked > 0) {
    console.warn(
      `[knowl-tests] ${report.locked} temporary fixture(s) still locked; left for the next run.`,
    );
  }
  if (report.spared.length > 0) {
    console.warn(
      `[knowl-tests] left ${report.spared.join(', ')} alone in ${tmpRoot}: knowl- prefixed but ` +
      `either worked in or holding nothing this suite wrote. Remove by hand if it is residue ` +
      `from before fixtures moved into a per-run root.`,
    );
  }
}

/** Both halves of the temporary-directory sweep, with the reporting. */
export async function sweepTemporaryFixtures(
  tmpRoot: string,
  options: { runRoot?: string; now?: number; minAgeMs?: number } = {},
): Promise<SweepReport> {
  const own = options.runRoot
    ? await removeRunTemporaryRoot(options.runRoot)
    : { removed: 0, locked: 0, spared: [] };
  const orphans = await sweepOrphanedTemporaryRoots(tmpRoot, {
    skip: options.runRoot,
    now: options.now,
    minAgeMs: options.minAgeMs,
  });

  const report: SweepReport = {
    removed: own.removed + orphans.removed,
    locked: own.locked + orphans.locked,
    spared: orphans.spared,
  };
  reportTemporarySweep(report, tmpRoot);
  return report;
}

/**
 * Sweeping at teardown only, deliberately.
 *
 * This file also exported its sweep as `setup`, to clear what a crashed run had left behind.
 * That broke the suite: workers start staggered, and a later worker running setup deleted
 * fixtures the earlier workers were still using -- `tests/cli/cli.test.ts` lost its AGENTS.md
 * mid-assertion, and another test's spawn failed with a missing working directory. Both passed
 * in isolation, which is what made it look like contention rather than deletion.
 *
 * There is a `setup` above again, and it is allowed back only because it deletes nothing: it
 * creates one directory and points `os.tmpdir()` at it. Stale directories from a crashed run
 * are still collected here, at teardown, and never at setup.
 */
export async function teardown(): Promise<{ scratch: SweepReport; temporary: SweepReport }> {
  const scratch = await sweepScratchDirectories(process.cwd());
  const temporary = await sweepTemporaryFixtures(systemTmpdir, { runRoot });
  restoreTmpdirEnv();
  return { scratch, temporary };
}

/**
 * Teardown for a run that is not alone: the temporary half only.
 *
 * `vitest.mutation.config.ts` disables global setup entirely, because a mutation run keeps
 * several vitest runs alive at once in the SAME working directory and each one's repository
 * sweep deletes the others' live fixtures. Measured: that is what killed and restarted runner
 * processes, not the mutants.
 *
 * That reasoning covers the repository sweep and nothing else. A run root is owned outright by
 * the run that created it, so removing one cannot reach into a concurrent run -- and a mutation
 * run is exactly where the leak hurts most, being tens of vitest runs rather than one. The
 * orphan pass is skipped too: it is a whole-`%TEMP%` scan, and one run's worth of it per mutant
 * would be paid tens of times for a job the next `npm test` does once.
 */
export async function teardownTemporaryOnly(): Promise<SweepReport> {
  const report = runRoot
    ? await removeRunTemporaryRoot(runRoot)
    : { removed: 0, locked: 0, spared: [] };
  reportTemporarySweep(report, systemTmpdir);
  restoreTmpdirEnv();
  return report;
}

/**
 * Put the machine's own temporary directory back.
 *
 * The redirect outlives the workers otherwise, and this process is also the one a watch-mode
 * session keeps running in.
 */
function restoreTmpdirEnv(): void {
  for (const [key, value] of originalTmpdirEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalTmpdirEnv.clear();
  delete process.env[RUN_ROOT_ENV];
  runRoot = undefined;
}
