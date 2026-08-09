import { spawnSync } from 'node:child_process';
import path from 'node:path';

export type RepoIdentity = {
  /** `host[:port]/path`, plus `#subpath` when the project is not at the git root. */
  identity: string;
  remoteName: string;
  remoteUrl: string;
  subpath: string | null;
};

export class NoGitRemoteError extends Error {}

/**
 * Git could not be run at all -- distinct from git running and reporting no remote.
 *
 * `spawnSync` reports a missing binary as `status: null` with `error` set, and `status !== 0`
 * is true for `null`. So a machine without git on PATH, or a spawn refused by a sandbox, read
 * as "this repository has no remote" and the user was told to add one they already have.
 * This repo has shipped that same collapse before, in `fileContentHash`, where every read
 * error mapped to "gone" and an antivirus lock became "the file you read is deleted".
 */
export class GitUnavailableError extends Error {}

/**
 * One identity per repository, whatever URL form the clone used.
 *
 * Host and path are both lowercased. GitHub, GitLab and Bitbucket all treat repository
 * names case-insensitively, so preserving case would split one repo into two buckets the
 * first time somebody typed `Acme` instead of `acme`. A case-sensitive host would merge two
 * genuinely different repos, which is the rarer and more visible failure.
 *
 * Credentials are stripped before anything else. A token in a remote URL is a token that
 * would otherwise be published, stored in config, and read back by every teammate.
 */
export function normalizeRemoteUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  // scp-like syntax (`git@host:owner/repo.git`) is not a URL and `new URL` cannot parse it.
  const scpLike = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(trimmed);
  const parsed = scpLike
    ? { host: scpLike[1], pathname: scpLike[2] }
    : parseAsUrl(trimmed);
  if (!parsed) return null;

  const host = parsed.host.toLowerCase();
  const segments = parsed.pathname
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean)
    .map(segment => segment.toLowerCase());

  // One segment is a host with no repository -- `https://github.com` resolves, and calling it
  // a repo identity would let every such remote collide under a single bucket.
  if (!host || segments.length < 2) return null;
  return `${host}/${segments.join('/')}`;
}

function parseAsUrl(value: string): { host: string; pathname: string } | null {
  try {
    const url = new URL(value);
    // `url.host` keeps a non-default port and drops a default one, which is exactly the rule
    // we want: `:2222` distinguishes a server, `:443` does not.
    return { host: url.host, pathname: url.pathname };
  } catch {
    return null;
  }
}

function git(cwd: string, args: string[]): string | null {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  // Checked before the status, and separately from it: "git could not run" is a different
  // fact from "git ran and said no", and only the second one is about this repository.
  if (result.error) {
    throw new GitUnavailableError(
      `Could not run git: ${result.error.message}. ` +
      'Knowl derives a cloud repository identity from the git remote, so git has to be on PATH.',
    );
  }
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

/**
 * Which remote, and therefore which bucket this repo publishes into.
 *
 * `origin` by default and overridable, because in a fork workflow `origin` is the fork and
 * `upstream` is the team's. Whichever was used is recorded on the result and written into
 * config, so the answer stays inspectable rather than being re-derived differently later.
 */
export function resolveRepoIdentity(
  projectRoot: string,
  options: { remote?: string } = {},
): RepoIdentity {
  const remoteName = options.remote ?? 'origin';
  const remoteUrl = git(projectRoot, ['config', '--get', `remote.${remoteName}.url`]);
  if (!remoteUrl) {
    throw new NoGitRemoteError(
      `No git remote "${remoteName}" in ${projectRoot}. ` +
      'A cloud workspace keys published knowledge on the remote URL, so a repository with ' +
      'no remote has no stable identity to publish under. Add a remote, or pass --remote ' +
      'to name a different one.',
    );
  }

  const identity = normalizeRemoteUrl(remoteUrl);
  if (!identity) {
    throw new NoGitRemoteError(
      `Could not read a repository identity from remote "${remoteName}" (${remoteUrl}).`,
    );
  }

  const toplevel = git(projectRoot, ['rev-parse', '--show-toplevel']);
  const subpath = toplevel
    ? path.relative(path.resolve(toplevel), path.resolve(projectRoot)).split(path.sep).join('/') || null
    : null;

  return {
    identity: subpath ? `${identity}#${subpath}` : identity,
    remoteName,
    remoteUrl,
    subpath,
  };
}
