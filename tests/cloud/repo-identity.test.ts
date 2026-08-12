import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GitUnavailableError,
  NoGitRemoteError,
  UnnameableProjectError,
  normalizeRemoteUrl,
  resolveRepoIdentity,
} from '../../src/cloud/repo-identity.js';

describe('normalizeRemoteUrl', () => {
  it('collapses every URL form for one repo to one identity', () => {
    // The whole point: two colleagues who cloned differently must publish to the same bucket.
    const expected = 'github.com/acme/web';
    expect(normalizeRemoteUrl('git@github.com:Acme/Web.git')).toBe(expected);
    expect(normalizeRemoteUrl('https://github.com/Acme/Web.git')).toBe(expected);
    expect(normalizeRemoteUrl('https://github.com/Acme/Web')).toBe(expected);
    expect(normalizeRemoteUrl('ssh://git@github.com/Acme/Web.git')).toBe(expected);
    expect(normalizeRemoteUrl('git://github.com/acme/web.git')).toBe(expected);
    expect(normalizeRemoteUrl('https://github.com/acme/web/')).toBe(expected);
  });

  it('strips embedded credentials, which is the one thing that must never reach the server', () => {
    expect(normalizeRemoteUrl('https://user:ghp_secret@github.com/acme/web.git')).toBe('github.com/acme/web');
  });

  it('keeps a non-default port, because two ports can be two different servers', () => {
    expect(normalizeRemoteUrl('ssh://git@git.internal:2222/team/api.git')).toBe('git.internal:2222/team/api');
  });

  it('keeps nested group paths, which GitLab uses and GitHub does not', () => {
    expect(normalizeRemoteUrl('git@gitlab.com:acme/platform/api.git')).toBe('gitlab.com/acme/platform/api');
  });

  it('returns null rather than guessing at something that is not a remote', () => {
    expect(normalizeRemoteUrl('')).toBeNull();
    expect(normalizeRemoteUrl('not a url')).toBeNull();
    expect(normalizeRemoteUrl('https://github.com')).toBeNull();
  });
});

const REPO = path.resolve('./.knowl-identity-repo');

async function makeGitRepo(root: string, remotes: Record<string, string>): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: root });
  for (const [name, url] of Object.entries(remotes)) {
    spawnSync('git', ['remote', 'add', name, url], { cwd: root });
  }
}

describe('resolveRepoIdentity', () => {
  beforeEach(async () => {
    await fs.rm(REPO, { recursive: true, force: true }).catch(() => {});
  });
  afterEach(async () => {
    await fs.rm(REPO, { recursive: true, force: true }).catch(() => {});
  });

  it('reads origin by default and reports which remote it used', async () => {
    await makeGitRepo(REPO, { origin: 'git@github.com:acme/web.git' });

    const identity = resolveRepoIdentity(REPO);

    expect(identity.identity).toBe('github.com/acme/web');
    expect(identity.remoteName).toBe('origin');
    expect(identity.subpath).toBeNull();
  });

  it('prefers the named remote, so a fork can publish to the upstream bucket', async () => {
    // origin is the fork; upstream is the team's. Defaulting to origin silently files a
    // forked contributor's knowledge under a repo nobody else reads.
    await makeGitRepo(REPO, {
      origin: 'git@github.com:contributor/web.git',
      upstream: 'git@github.com:acme/web.git',
    });

    expect(resolveRepoIdentity(REPO, { remote: 'upstream' }).identity).toBe('github.com/acme/web');
  });

  it('qualifies a project below the git root, so a monorepo does not merge its packages', async () => {
    // Several .knowl projects under one remote normalize alike. Without the subpath they
    // would share one identity and silently pool their knowledge.
    await makeGitRepo(REPO, { origin: 'git@github.com:acme/mono.git' });
    const nested = path.join(REPO, 'packages', 'api');
    await fs.mkdir(nested, { recursive: true });

    const identity = resolveRepoIdentity(nested);

    expect(identity.subpath).toBe('packages/api');
    expect(identity.identity).toBe('github.com/acme/mono#packages/api');
  });

  /*
   * This used to assert the opposite -- `refuses a repo with no remote instead of inventing an
   * identity`. The premise was that a cloud workspace keys knowledge on the remote URL, so a repo
   * without one has nothing stable to publish under. Both halves were wrong: the server validates
   * `originRepo` as any non-empty string up to 200 characters and treats it as a label for
   * grouping, and a folder name is stable for exactly as long as the folder is called that.
   *
   * What the refusal actually did was make git a condition of using the product, for people who
   * pay by how much they store.
   */
  it('falls back to the directory name for a repo with no remote', async () => {
    await makeGitRepo(REPO, {});

    const identity = resolveRepoIdentity(REPO);

    expect(identity.identity).toBe('.knowl-identity-repo');
    expect(identity.source).toBe('directory');
    expect(identity.remoteName).toBeNull();
  });

  /*
   * The fixture lives outside the checkout, and that is load-bearing rather than tidiness.
   *
   * `git config --get remote.origin.url` run in a directory with no `.git` SEARCHES UPWARD. A
   * fixture under this repo would therefore be answered with knowl's own origin, and the test would
   * pass by reading the developer's checkout instead of the directory it created. Same rule as
   * `tests/cli/project-marker.test.ts`, which was red locally and green in CI for this reason.
   */
  it('names a plain directory that is not a git repository at all', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-notes-'));
    try {
      const identity = resolveRepoIdentity(outside);

      expect(identity.source).toBe('directory');
      expect(identity.identity).toBe(path.basename(outside).toLowerCase());
      expect(identity.remoteUrl).toBeNull();
    } finally {
      await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('takes an explicit name over anything git would have said', async () => {
    // A repo WITH a usable remote, so this proves precedence rather than fallback.
    await makeGitRepo(REPO, { origin: 'git@github.com:acme/web.git' });

    const identity = resolveRepoIdentity(REPO, { repo: 'My Notes' });

    // Lowercased and whitespace-collapsed, the same treatment a remote gets, so one project cannot
    // end up with two identities depending on which route named it.
    expect(identity.identity).toBe('my-notes');
    expect(identity.source).toBe('explicit');
    expect(identity.remoteName).toBeNull();
  });

  it('still refuses a remote that was named and is not there', async () => {
    // The distinction the fallback must not swallow: a missing `origin` nobody asked about is a
    // project with nowhere to push, but `--remote upstream` against a repo that has no `upstream`
    // is a typo, and answering it with the folder name would file the knowledge somewhere silently.
    await makeGitRepo(REPO, { origin: 'git@github.com:acme/web.git' });

    expect(() => resolveRepoIdentity(REPO, { remote: 'upstream' })).toThrow(NoGitRemoteError);
  });

  it('refuses a remote it cannot reduce to an identity rather than renaming the project', async () => {
    await makeGitRepo(REPO, { origin: 'not a url' });

    expect(() => resolveRepoIdentity(REPO)).toThrow(NoGitRemoteError);
  });

  it('refuses a name that the server would reject at push time', async () => {
    await makeGitRepo(REPO, {});

    expect(() => resolveRepoIdentity(REPO, { repo: '   ' })).toThrow(UnnameableProjectError);
    expect(() => resolveRepoIdentity(REPO, { repo: 'x'.repeat(201) })).toThrow(UnnameableProjectError);
  });

  it('says git is missing rather than blaming a remote that is really there', async () => {
    // spawnSync reports a missing binary as status null with `error` set, and `status !== 0`
    // is true for null. Without checking `error` first, a machine with no git on PATH is told
    // to add a remote it already has.
    await makeGitRepo(REPO, { origin: 'git@github.com:acme/web.git' });
    const realPath = process.env.PATH;
    process.env.PATH = '';

    try {
      expect(() => resolveRepoIdentity(REPO)).toThrow(GitUnavailableError);
      expect(() => resolveRepoIdentity(REPO)).not.toThrow(NoGitRemoteError);
    } finally {
      process.env.PATH = realPath;
    }
  });

  it('does not demand git from a project that is not a repository', async () => {
    // The complement of the test above, and the reason the `.git` check exists. Missing git is a
    // real problem for a repository whose remote cannot then be read, and no problem at all for a
    // directory of notes -- refusing over a tool the project does not use would be the same
    // overreach as refusing over a missing remote.
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-nogit-'));
    const realPath = process.env.PATH;
    process.env.PATH = '';

    try {
      expect(resolveRepoIdentity(outside).source).toBe('directory');
    } finally {
      process.env.PATH = realPath;
      await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
    }
  });
});
