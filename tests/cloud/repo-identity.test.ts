import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GitUnavailableError,
  NoGitRemoteError,
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

  it('refuses a repo with no remote instead of inventing an identity', async () => {
    await makeGitRepo(REPO, {});

    expect(() => resolveRepoIdentity(REPO)).toThrow(NoGitRemoteError);
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
});
