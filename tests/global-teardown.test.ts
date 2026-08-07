import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RUN_ROOT_ENV,
  removeRunTemporaryRoot,
  sweepOrphanedTemporaryRoots,
  sweepScratchDirectories,
} from './global-teardown.js';

/**
 * The sweep exists for a real reason and must keep working.
 *
 * On Windows libSQL holds the `-shm` sidecar until the owning process lets go, so a suite's
 * own `afterEach` removal of its fixture routinely fails, and the failure is swallowed on
 * purpose -- housekeeping must not fail a passing test. Without a sweep the directories
 * accumulate one per test, per run.
 *
 * What it must stop doing is deciding on the name alone. `.knowl-` is a prefix a person
 * reaches for too: a benchmark script parked in `.knowl-bench/` was deleted mid-session by a
 * test run, silently, because it matched. A name is not evidence; contents are.
 */

const BASE = path.resolve('./.knowl-teardown-test');

const makeDir = async (...segments: string[]) => {
  await fs.mkdir(path.join(BASE, ...segments), { recursive: true });
};
const makeFile = async (relative: string, body = 'x') => {
  const file = path.join(BASE, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, 'utf8');
};
const exists = async (name: string) =>
  fs.access(path.join(BASE, name)).then(() => true, () => false);

describe('global teardown sweep', () => {
  beforeEach(async () => {
    await fs.rm(BASE, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(BASE, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(BASE, { recursive: true, force: true }).catch(() => {});
    vi.restoreAllMocks();
  });

  describe('what it must still collect', () => {
    it('removes a scratch repository fixture', async () => {
      await makeFile('.knowl-repo-fixture/.knowl/config.json', '{}');
      await makeFile('.knowl-repo-fixture/.knowl/knowl.db');

      await sweepScratchDirectories(BASE);

      expect(await exists('.knowl-repo-fixture')).toBe(false);
    });

    it('removes a scratch KNOWL_HOME', async () => {
      // The shape `vitest.config.ts` points KNOWL_HOME at: machine-local state, no `.knowl`
      // directory of its own, because it *is* one.
      await makeFile('.knowl-test-home/repos.json', '{"repos":[]}');
      await makeDir('.knowl-test-home', 'workspaces');

      await sweepScratchDirectories(BASE);

      expect(await exists('.knowl-test-home')).toBe(false);
    });

    it('removes a base directory whose repositories are nested inside it', async () => {
      // `tests/cli/repo-discovery.test.ts` nests fixtures one level down, because discovery
      // skips dot-named repositories. The marker is then not at the top level.
      await makeFile('.knowl-discovery/linked/.knowl/config.json', '{}');
      await makeFile('.knowl-discovery/standalone/.knowl/config.json', '{}');

      await sweepScratchDirectories(BASE);

      expect(await exists('.knowl-discovery')).toBe(false);
    });

    it('removes a fixture stripped down to the files Knowl itself wrote', async () => {
      // A test that deleted its own `.knowl` directory but left the guidance files behind.
      await makeFile('.knowl-cli-fixture/AGENTS.md', '# agents');
      await makeFile('.knowl-cli-fixture/KNOWL.md', '# knowl');

      await sweepScratchDirectories(BASE);

      expect(await exists('.knowl-cli-fixture')).toBe(false);
    });

    it('removes a fixture that is nothing but loose databases', async () => {
      // `.knowl-pool-test`, `.knowl-bootstrap-test` and `.knowl-schema-version-test` build no
      // repository at all -- just bare libSQL files. A first pass at this predicate left all
      // three behind on a full run, which is how they got into this test.
      await makeFile('.knowl-pool-test/a.db', 'sqlite');
      await makeFile('.knowl-pool-test/a.db-shm', '');
      await makeFile('.knowl-pool-test/a.db-wal', '');

      await sweepScratchDirectories(BASE);

      expect(await exists('.knowl-pool-test')).toBe(false);
    });

    it('removes an empty leftover', async () => {
      await makeDir('.knowl-empty');

      await sweepScratchDirectories(BASE);

      expect(await exists('.knowl-empty')).toBe(false);
    });

    it('removes a loose database parked beside the repository', async () => {
      // `tests/store/namespace-concurrency.test.ts` opens its namespace database as a bare
      // file next to the repository rather than inside a fixture directory. Windows holds the
      // handle past that suite's own removal -- measured, EBUSY on all three -- and the sweep
      // only ever looked at directories, so the files survived every single run.
      await makeFile('.knowl-namespace-session.db', 'sqlite');
      await makeFile('.knowl-namespace-session.db-shm', '');
      await makeFile('.knowl-namespace-session.db-wal', '');

      await sweepScratchDirectories(BASE);

      expect(await exists('.knowl-namespace-session.db')).toBe(false);
      expect(await exists('.knowl-namespace-session.db-shm')).toBe(false);
      expect(await exists('.knowl-namespace-session.db-wal')).toBe(false);
    });
  });

  describe('what it must not touch', () => {
    it('leaves a directory that only shares the prefix', async () => {
      // The reproduction: a lane parked benchmark scripts under a `.knowl-` name and a test
      // run deleted them. Nothing in here was written by Knowl.
      await makeFile('.knowl-bench/measure-scan.mjs', 'console.log(1)');
      await makeFile('.knowl-bench/results.csv', 'a,b\n');

      await sweepScratchDirectories(BASE);

      expect(await exists('.knowl-bench')).toBe(true);
      expect(await exists('.knowl-bench/measure-scan.mjs')).toBe(true);
    });

    it('says so rather than leaving the user to notice', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await makeFile('.knowl-bench/measure-scan.mjs', 'console.log(1)');

      await sweepScratchDirectories(BASE);

      // Silence is what made the deletion a mystery; silence about the opposite decision
      // would just move the mystery.
      expect(warn).toHaveBeenCalled();
      expect(warn.mock.calls.flat().join(' ')).toContain('.knowl-bench');
    });

    it('collects the fixtures beside a directory it refuses to collect', async () => {
      await makeFile('.knowl-bench/measure-scan.mjs', 'console.log(1)');
      await makeFile('.knowl-repo-fixture/.knowl/config.json', '{}');
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      await sweepScratchDirectories(BASE);

      expect(await exists('.knowl-bench')).toBe(true);
      expect(await exists('.knowl-repo-fixture')).toBe(false);
    });

    it('leaves a loose file that shares the prefix but is not a database', async () => {
      // A file has no contents this sweep can reason about, so name and extension are the
      // whole evidence. Both have to match, or a person's notes go the way of `.knowl-bench`.
      await makeFile('.knowl-notes.md', '# mine');
      await makeFile('.knowl-backup.db.txt', 'not a database');
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      await sweepScratchDirectories(BASE);

      expect(await exists('.knowl-notes.md')).toBe(true);
      expect(await exists('.knowl-backup.db.txt')).toBe(true);
    });

    it('ignores anything not carrying the prefix at all', async () => {
      await makeFile('benchmarks/run.mjs', 'console.log(1)');
      await makeFile('.knowl/config.json', '{}');

      await sweepScratchDirectories(BASE);

      expect(await exists('benchmarks')).toBe(true);
      expect(await exists('.knowl')).toBe(true);
    });
  });
});

/**
 * The other fixture convention, and the one that actually leaked.
 *
 * Thirty test files build their fixtures with `mkdtemp` in `os.tmpdir()` under a dotless
 * `knowl-` name, which the sweep above -- repository root, dot-prefixed -- has never visited.
 * Measured on Windows 2026-08-06: 28,524 such directories, 5.7 GB, roughly 1.9 GB for every day
 * the suite was run. Nothing failed; nothing was ever reclaimed either.
 *
 * The fix is to stop scattering them: `setup` gives the run its own temporary directory, so
 * what has to be collected afterwards is one directory whose owner is not in question.
 */
const ONE_HOUR = 60 * 60 * 1000;

describe('the temporary directory the suite runs in', () => {
  it('belongs to this run rather than to the machine', () => {
    // The regression guard for the redirect itself. Take this away and every `mkdtemp` in the
    // suite goes back to landing loose in a shared `%TEMP%` that nothing sweeps.
    expect(path.basename(os.tmpdir())).toMatch(/^knowl-run-/);
    expect(process.env[RUN_ROOT_ENV]).toBe(os.tmpdir());
  });
});

describe('collecting a run root', () => {
  let runRoot: string;

  beforeEach(async () => {
    runRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-runroot-test-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('removes the fixtures and the root', async () => {
    await fs.mkdir(path.join(runRoot, 'knowl-pass-aa1122', '.knowl'), { recursive: true });
    await fs.writeFile(path.join(runRoot, 'knowl-pass-aa1122', '.knowl', 'knowl.db'), 'sqlite');
    await fs.mkdir(path.join(runRoot, 'knowl-lex-bb3344'), { recursive: true });

    const report = await removeRunTemporaryRoot(runRoot);

    expect(report.removed).toBe(2);
    expect(await fs.access(runRoot).then(() => true, () => false)).toBe(false);
  });

  it('applies none of the guards the shared directory needs', async () => {
    // Deliberate asymmetry, and the whole reason for routing fixtures through a run root: a
    // directory created by this run for this run needs no evidence of ownership. The same
    // contents sitting loose in `%TEMP%` would be spared by every guard there is.
    await fs.mkdir(path.join(runRoot, 'notes'), { recursive: true });
    await fs.writeFile(path.join(runRoot, 'notes', 'measure-scan.mjs'), 'console.log(1)');
    await fs.writeFile(path.join(runRoot, 'notes', 'package.json'), '{}');

    await removeRunTemporaryRoot(runRoot);

    expect(await fs.access(runRoot).then(() => true, () => false)).toBe(false);
  });

  it('collects the fixtures beside one Windows is still holding', async () => {
    // The case the whole file exists for: libSQL keeps the `-shm` sidecar for the life of the
    // worker, so a removal can fail. One stuck fixture must not strand the rest of the run
    // behind it -- that is why the root is emptied child by child rather than in one call.
    await fs.mkdir(path.join(runRoot, 'knowl-locked-aa'), { recursive: true });
    await fs.mkdir(path.join(runRoot, 'knowl-free-bb'), { recursive: true });
    // What a held `-shm` sidecar actually does: the removal fails for the fixture itself and
    // for anything that would have to remove it on the way past, the run root included.
    const held = path.resolve(path.join(runRoot, 'knowl-locked-aa'));
    const real = fs.rm.bind(fs);
    vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      const attempt = path.resolve(String(target));
      if (held === attempt || held.startsWith(attempt + path.sep)) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      return real(target, options);
    });

    const report = await removeRunTemporaryRoot(runRoot);

    expect(report).toMatchObject({ removed: 1, locked: 1 });
    vi.restoreAllMocks();
    expect(await fs.access(path.join(runRoot, 'knowl-free-bb')).then(() => true, () => false))
      .toBe(false);
    // The root survives with the stuck fixture inside it, and the next run's orphan pass -- by
    // then well past the age guard -- is what finally collects it.
    expect(await fs.access(path.join(runRoot, 'knowl-locked-aa')).then(() => true, () => false))
      .toBe(true);
  });

  it('outlasts a delete-pending child rather than leaving the root behind', async () => {
    // Windows holds a removed directory in a delete-pending state until its last handle
    // closes, so an attempt can fail against a directory that is on its way out anyway.
    // Measured: a run whose last act was removing fixtures left an empty root behind every
    // time. The window closes on its own, so the removal has to be one that waits.
    await fs.mkdir(path.join(runRoot, 'knowl-transient-aa'), { recursive: true });
    const real = fs.rm.bind(fs);
    let pending = true;
    vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (pending && String(target).includes('knowl-transient-aa')) {
        pending = false;
        throw Object.assign(new Error('ENOTEMPTY: directory not empty'), { code: 'ENOTEMPTY' });
      }
      return real(target, options);
    });

    const report = await removeRunTemporaryRoot(runRoot);

    expect(await fs.access(runRoot).then(() => true, () => false)).toBe(false);
    // Nothing to warn about: the root went, so nothing survived inside it.
    expect(report.locked).toBe(0);
  });
});

describe('collecting what an earlier run left in the shared temporary directory', () => {
  /**
   * A stand-in for `%TEMP%`: shared with everything else on the machine, so every deletion here
   * has to be justified by evidence rather than by a name.
   */
  let TMP: string;
  const at = (...segments: string[]) => path.join(TMP, ...segments);
  const there = async (name: string) => fs.access(at(name)).then(() => true, () => false);
  const write = async (relative: string, body = 'x') => {
    const file = at(relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body, 'utf8');
  };
  /** Far enough past everything in TMP that the age guard is satisfied. */
  const wellLater = () => Date.now() + 4 * ONE_HOUR;

  beforeEach(async () => {
    TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-tmp-test-'));
  });

  afterEach(async () => {
    await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
  });

  it('collects an abandoned run root', async () => {
    await write('knowl-run-abc123/knowl-pass-aa/.knowl/knowl.db', 'sqlite');

    const report = await sweepOrphanedTemporaryRoots(TMP, { now: wellLater() });

    expect(report.removed).toBe(1);
    expect(await there('knowl-run-abc123')).toBe(false);
  });

  it('collects a fixture from before there were run roots', async () => {
    // The 5.7 GB already on disk when this was found: one directory per test, per run, going
    // back to whenever that suite was written.
    await write('knowl-handlers-aa11/transcripts.db', 'sqlite');
    await write('knowl-handlers-aa11/transcripts.db-shm');

    await sweepOrphanedTemporaryRoots(TMP, { now: wellLater() });

    expect(await there('knowl-handlers-aa11')).toBe(false);
  });

  it('leaves a directory a live run is still writing to', async () => {
    // The hazard that makes a bare `%TEMP%` sweep unsafe: a second `npm test` in another
    // terminal owns directories this run knows nothing about. Age is the only signal
    // distinguishing them, and a running suite refreshes its root's mtime constantly.
    await write('knowl-run-live99/knowl-sem-bb/.knowl/knowl.db', 'sqlite');

    const report = await sweepOrphanedTemporaryRoots(TMP, { now: Date.now() });

    expect(await there('knowl-run-live99')).toBe(true);
    // Not reported either: a young directory is the ordinary case, not a decision worth naming.
    expect(report.spared).toEqual([]);
  });

  it('waits a full hour by default', async () => {
    await write('knowl-run-recent/knowl-sem-bb/.knowl/knowl.db', 'sqlite');

    await sweepOrphanedTemporaryRoots(TMP, { now: Date.now() + ONE_HOUR / 2 });

    expect(await there('knowl-run-recent')).toBe(true);
  });

  it('leaves a checkout parked under a knowl- name', async () => {
    // A worktree of this repository in the temporary directory is a real thing here --
    // `knowl-pr7` -- and it satisfies the content-marker predicate on its very first entry,
    // because it contains a `.knowl`, a `KNOWL.md` and a `CLAUDE.md` of its own. Deleting one
    // takes uncommitted work with it, so working-directory evidence overrides everything else.
    await write('knowl-pr7/KNOWL.md', '# knowl');
    await write('knowl-pr7/.knowl/knowl.db', 'sqlite');
    await write('knowl-pr7/.git/HEAD', 'ref: refs/heads/pr-7');

    const report = await sweepOrphanedTemporaryRoots(TMP, { now: wellLater() });

    expect(await there('knowl-pr7')).toBe(true);
    expect(report.spared).toContain('knowl-pr7');
  });

  it('leaves a directory holding nothing this suite wrote', async () => {
    await write('knowl-notes/plan.md', '# mine');

    const report = await sweepOrphanedTemporaryRoots(TMP, { now: wellLater() });

    expect(await there('knowl-notes')).toBe(true);
    expect(report.spared).toContain('knowl-notes');
  });

  it('ignores anything without the prefix', async () => {
    // A fixture named after something other than Knowl is still inside a run root, and is
    // collected with it. Loose in `%TEMP%`, the name is the only thing making a directory ours
    // to consider at all.
    await write('a-very-distinctive-project-name/.knowl/knowl.db', 'sqlite');

    await sweepOrphanedTemporaryRoots(TMP, { now: wellLater() });

    expect(await there('a-very-distinctive-project-name')).toBe(true);
  });

  it('leaves the run root it is told to skip', async () => {
    await write('knowl-run-mine/knowl-pass-aa/.knowl/knowl.db', 'sqlite');

    await sweepOrphanedTemporaryRoots(TMP, { now: wellLater(), skip: at('knowl-run-mine') });

    expect(await there('knowl-run-mine')).toBe(true);
  });

  it('leaves loose files alone whatever they are called', async () => {
    await write('knowl-stray.db', 'sqlite');

    await sweepOrphanedTemporaryRoots(TMP, { now: wellLater() });

    expect(await there('knowl-stray.db')).toBe(true);
  });
});

describe('what a mutation run gets', () => {
  it('replaces the base global setup instead of merging with it', async () => {
    // `mergeConfig` concatenates arrays, so `globalSetup: []` in the override merges to the
    // base's list unchanged. That is not a hypothetical: it is why the repository sweep that
    // file documents itself as disabling ran under every mutation job anyway, and why setup
    // ran twice once a second entry was added -- minting a run root inside the first one's
    // already-redirected `os.tmpdir()`.
    const config = (await import('../vitest.mutation.config.js')).default;

    expect(config.test?.globalSetup).toEqual(['./tests/global-temp-setup.ts']);
  });
});
