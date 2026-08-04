import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sweepScratchDirectories } from './global-teardown.js';

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

    it('ignores anything not carrying the prefix at all', async () => {
      await makeFile('benchmarks/run.mjs', 'console.log(1)');
      await makeFile('.knowl/config.json', '{}');

      await sweepScratchDirectories(BASE);

      expect(await exists('benchmarks')).toBe(true);
      expect(await exists('.knowl')).toBe(true);
    });
  });
});
