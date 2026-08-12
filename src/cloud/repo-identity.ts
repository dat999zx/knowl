import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export type RepoIdentity = {
  /**
   * What this project publishes under. `host[:port]/path` when derived from a remote, plus
   * `#subpath` when the project sits below the git root; otherwise the name that was asked for,
   * or the project directory's own.
   */
  identity: string;
  /**
   * Which of the three routes decided it, recorded rather than re-derived later. A pointer saying
   * only `notes` cannot answer "was that my folder name, or did somebody type it".
   */
  source: 'explicit' | 'remote' | 'directory';
  /** Null unless the identity came from a remote. */
  remoteName: string | null;
  remoteUrl: string | null;
  subpath: string | null;
};

/**
 * A remote was named and is not there.
 *
 * Only raised for a remote the caller ASKED for. A missing `origin` on a project nobody said
 * anything about is not an error -- version control is not a condition of using this product.
 */
export class NoGitRemoteError extends Error {}

/** No identity could be formed at all, so the caller has to say what to use. */
export class UnnameableProjectError extends Error {}

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
      'This project is a git repository, so Knowl would normally read its identity from a remote. ' +
      'Put git on PATH, or pass --repo <name> to name the project yourself.',
    );
  }
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

/**
 * What this project publishes under, by one of three routes.
 *
 * A remote is the best answer WHEN THERE IS ONE: it is identical for everyone who clones, so a
 * team lands in one bucket without anybody typing anything, and `#subpath` keeps a monorepo's
 * packages apart. It was also, until this change, the ONLY answer — a project with no remote was
 * refused outright, which made git a condition of using the cloud. It is not one. A directory of
 * notes is a project; so is work that has never been pushed anywhere. People pay for how much they
 * store, not for keeping it in a shape this tool recognises.
 *
 * So the remote is now a default rather than a requirement, and the routes are, in order:
 * an explicit `--repo` name; the named-or-default remote; the project directory's own name.
 */
export function resolveRepoIdentity(
  projectRoot: string,
  options: { remote?: string; repo?: string } = {},
): RepoIdentity {
  // Named outright, so no git runs at all -- the route for a project that is not a repository, or
  // is one with nowhere to push. First, because a caller who says what they want should not have
  // the answer overridden by whatever git happens to report.
  if (options.repo !== undefined) {
    return {
      identity: sanitizeName(options.repo, 'The --repo name'),
      source: 'explicit',
      remoteName: null,
      remoteUrl: null,
      subpath: null,
    };
  }

  // Asked-for versus assumed, and the difference decides whether a miss is an error. `--remote
  // upstream` against a repo with no `upstream` is a typo worth reporting; no `origin` on a project
  // nobody said anything about is just a project with nowhere to push.
  const requested = options.remote;
  const remoteName = requested ?? 'origin';
  const remoteUrl = readRemote(projectRoot, remoteName);

  if (!remoteUrl) {
    if (requested !== undefined) {
      throw new NoGitRemoteError(
        `No git remote "${requested}" in ${projectRoot}. ` +
        'Check the name against `git remote -v`, drop the flag to use origin, or pass ' +
        '--repo <name> to name this project without a remote.',
      );
    }
    return fromDirectory(projectRoot);
  }

  const identity = normalizeRemoteUrl(remoteUrl);
  if (!identity) {
    // The remote exists and cannot be reduced to an identity. Deliberately NOT replaced by the
    // directory name: a project carrying a remote plainly means to publish under it, and quietly
    // filing it somewhere else would put a team's knowledge in a bucket nobody is reading.
    throw new NoGitRemoteError(
      `Could not read a repository identity from remote "${remoteName}" (${remoteUrl}). ` +
      'Pass --repo <name> to name this project explicitly.',
    );
  }

  const toplevel = git(projectRoot, ['rev-parse', '--show-toplevel']);
  const subpath = toplevel
    ? path.relative(path.resolve(toplevel), path.resolve(projectRoot)).split(path.sep).join('/') || null
    : null;

  return {
    identity: subpath ? `${identity}#${subpath}` : identity,
    source: 'remote',
    remoteName,
    remoteUrl,
    subpath,
  };
}

/**
 * Reads a remote, treating "this is not a git repository" as an answer rather than a failure.
 *
 * The `.git` test is what keeps a missing git binary meaningful. `GitUnavailableError` exists so a
 * machine without git is not told to add a remote it already has, and that is still right for a
 * repository -- but a plain directory has no remote to be wrong about, and refusing to connect over
 * a tool it does not need would be the same overreach as demanding a remote. So: a repository and
 * no git, complain; no repository, fall through to the name.
 */
function readRemote(projectRoot: string, remoteName: string): string | null {
  const looksLikeRepo = existsSync(path.join(projectRoot, '.git'));
  try {
    return git(projectRoot, ['config', '--get', `remote.${remoteName}.url`]);
  } catch (error) {
    if (error instanceof GitUnavailableError && !looksLikeRepo) return null;
    throw error;
  }
}

/**
 * The project's own directory name.
 *
 * Stable for as long as the folder is called what it is called, which is all an identity has to be:
 * the server treats this value as a label for grouping, not as a claim about anything. It is not
 * unique across machines, so two people who each keep notes in `~/notes` and connect to one
 * workspace share a bucket. That is visible in the connect output and fixed by naming one of them
 * with `--repo`, which is a better trade than refusing to run.
 */
function fromDirectory(projectRoot: string): RepoIdentity {
  const base = path.basename(path.resolve(projectRoot));
  return {
    identity: sanitizeName(base, `The project directory name ("${base}")`),
    source: 'directory',
    remoteName: null,
    remoteUrl: null,
    subpath: null,
  };
}

/**
 * Lowercased and whitespace-collapsed, matching what `normalizeRemoteUrl` does to a remote so the
 * routes cannot produce two identities for one project. Length is bounded here because the server
 * accepts 200 characters, and a value refused there would fail at push -- long after connect said
 * yes, and with a message about a limit the user never saw.
 */
function sanitizeName(raw: string, subject: string): string {
  const cleaned = raw.trim().toLowerCase().replace(/\s+/g, '-');
  if (!cleaned) {
    throw new UnnameableProjectError(
      `${subject} is empty, so there is nothing to publish under. Pass --repo <name>.`,
    );
  }
  if (cleaned.length > 200) {
    throw new UnnameableProjectError(
      `${subject} is ${cleaned.length} characters and the limit is 200. Pass a shorter --repo <name>.`,
    );
  }
  return cleaned;
}
