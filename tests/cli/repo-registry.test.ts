import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listKnownRepos,
  readKnownRepos,
  recordKnownRepo,
  repoRegistryPath,
} from '../../src/cli/repo-registry.js';
import { discoverRepos } from '../../src/cli/repo-discovery.js';

const HOME = path.resolve('./.knowl-registry-home');
const A = path.resolve('./.knowl-registry-a');
const B = path.resolve('./.knowl-registry-b');
/** Never created, and neither is its parent: an entry on a drive that is not mounted. */
const UNREACHABLE = path.join(path.resolve('./.knowl-registry-unmounted'), 'repo');

/**
 * A repository fixture writes `.knowl/config.json`, not a bare `.knowl` directory.
 *
 * The directory alone stopped being the marker in the K-51 fix, for the reason this file
 * tests below: `knowlHome()` is itself called `.knowl`, so the bare directory made `$HOME`
 * a repository. These fixtures were built against the old marker; what they assert is
 * unchanged, only what it takes to *be* a repository is. Same correction, and same wording,
 * as `tests/cli/repo-discovery.test.ts` already carries.
 */
async function makeRepo(root: string): Promise<void> {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await fs.writeFile(path.join(root, '.knowl', 'config.json'), JSON.stringify({ version: 1 }), 'utf8');
}

const registryEntries = async (): Promise<string[]> =>
  JSON.parse(await fs.readFile(repoRegistryPath(), 'utf-8')).repos;

describe('known repo registry', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    for (const dir of [HOME, A, B, path.dirname(UNREACHABLE)]) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    await makeRepo(A);
    await makeRepo(B);
  });

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    for (const dir of [HOME, A, B, path.dirname(UNREACHABLE)]) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('starts empty rather than failing when nothing has been recorded', async () => {
    expect(await listKnownRepos()).toEqual([]);
  });

  it('records a repo once however many times it is upgraded', async () => {
    await recordKnownRepo(A);
    await recordKnownRepo(A);
    await recordKnownRepo(B);

    expect(await listKnownRepos()).toEqual([A, B].sort());
  });

  it('survives a corrupt registry instead of blocking the command that writes it', async () => {
    // This file is machine-local convenience state. Nothing in it is worth failing an
    // upgrade over, so a truncated or hand-edited file is replaced, not reported.
    await fs.mkdir(path.dirname(repoRegistryPath()), { recursive: true });
    await fs.writeFile(repoRegistryPath(), '{ this is not json', 'utf-8');

    await recordKnownRepo(A);

    expect(await listKnownRepos()).toEqual([A]);
  });

  describe('the project marker', () => {
    it('does not accept a bare .knowl directory as a repository', async () => {
      // The exact shape of `knowlHome()`: a directory called `.knowl` and nothing inside it
      // that says "project". K-51 is what happens when this is treated as a repository --
      // `$HOME` joins a list that `upgrade --all` and `doctor --fix` act on.
      const homeShaped = path.join(A, 'looks-like-home');
      await fs.mkdir(path.join(homeShaped, '.knowl'), { recursive: true });
      await recordKnownRepo(homeShaped);

      expect(await listKnownRepos()).not.toContain(homeShaped);
    });

    it('is the same marker discovery uses, so the two cannot disagree', async () => {
      // `discoverRepos` re-filters with `isProjectRoot`, which is why the wrong predicate
      // here was survivable. Survivable is not the same as harmless: `listKnownRepos` is
      // exported, and the next caller inherits the disagreement rather than the re-filter.
      // Nested under the dot-named fixture rather than being it: discovery skips dot-named
      // directories outright, which would decide this test for the wrong reason.
      const homeShaped = path.join(A, 'looks-like-home');
      const real = path.join(A, 'real');
      await fs.mkdir(path.join(homeShaped, '.knowl'), { recursive: true });
      await makeRepo(real);
      await recordKnownRepo(homeShaped);
      await recordKnownRepo(real);

      const discovered = (await discoverRepos({ record: false })).map(entry => entry.root);
      expect(discovered).toEqual([real]);
      expect(await listKnownRepos()).toEqual(discovered);
    });
  });

  describe('self-healing', () => {
    it('forgets a repo whose checkout is gone, and rewrites the file', async () => {
      // A registry that keeps naming deleted checkouts turns every sweep into a list of
      // failures the user cannot act on -- and `upgrade --all` acts on every entry.
      await recordKnownRepo(A);
      await recordKnownRepo(B);
      await fs.rm(B, { recursive: true, force: true });

      expect(await listKnownRepos()).toEqual([A]);
      // Filtering on read leaves the bad entry to be re-read forever. Healing removes it.
      expect(await registryEntries()).toEqual([A]);
    });

    it('forgets a directory that is still there but is no longer a repository', async () => {
      // The stray-entry shape: the path resolves, so nothing looks broken, but there is no
      // `.knowl/config.json` any more -- a scratch directory whose contents were cleaned up.
      await recordKnownRepo(A);
      await recordKnownRepo(B);
      await fs.rm(path.join(B, '.knowl'), { recursive: true, force: true });

      expect(await listKnownRepos()).toEqual([A]);
      expect(await registryEntries()).toEqual([A]);
    });

    it('reports what it forgot rather than shrinking the registry silently', async () => {
      await recordKnownRepo(A);
      await recordKnownRepo(B);
      await fs.rm(B, { recursive: true, force: true });

      const { repos, forgotten } = await readKnownRepos();

      expect(repos).toEqual([A]);
      expect(forgotten).toEqual([B]);
    });

    it('keeps an entry whose parent is unreachable, because a drive can be unmounted', async () => {
      // The one case that must not be healed: `D:\Code\repo` is not gone when `D:` is simply
      // not plugged in, and forgetting it would cost the user a repo per unmounted volume.
      await recordKnownRepo(A);
      await recordKnownRepo(UNREACHABLE);

      const { repos, forgotten } = await readKnownRepos();

      expect(repos).toEqual([A]);
      expect(forgotten).toEqual([]);
      // Still on file, so plugging the drive back in restores it without a re-upgrade.
      expect(await registryEntries()).toContain(UNREACHABLE);
    });

    it('leaves the file alone when there is nothing to forget', async () => {
      // Healing writes, and this file is how `assertKnowledgeDatabasePresent` tells a moved
      // database from a fresh clone. A read that rewrites on every call is a read that can
      // truncate it on any call.
      await recordKnownRepo(A);
      await recordKnownRepo(B);
      const before = await fs.stat(repoRegistryPath());

      await listKnownRepos();
      await listKnownRepos();

      expect(await registryEntries()).toEqual([A, B].sort());
      expect((await fs.stat(repoRegistryPath())).mtimeMs).toBe(before.mtimeMs);
    });
  });
});
