import { spawnSync } from 'node:child_process';

export type GateVerdict =
  | { ok: true }
  | { ok: false; reason: 'not-default-branch' | 'behind-remote' | 'git-unavailable'; detail: string };

/**
 * Git could not be run at all -- distinct from git running and reporting no.
 *
 * The same collapse `repo-identity.ts` guards against, for the same reason: `spawnSync` reports
 * a missing binary as `status: null` with `error` set, and `status !== 0` is true for `null`, so
 * a machine without git on PATH reads as a branch problem unless `error` is checked first. This
 * repo has shipped that confusion twice already -- most memorably in `fileContentHash`, where
 * every read error mapped to "gone".
 */
class GitUnavailable extends Error {}

function git(cwd: string, args: string[]): string | null {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error) throw new GitUnavailable(result.error.message);
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

/**
 * The branch the team's knowledge tracks.
 *
 * `origin/HEAD` is the answer when the remote published one, which a fresh clone records. The
 * `main`/`master` fallback exists because that symbolic ref is local state a clone can be missing
 * -- an old clone, a `git remote set-head` never run -- and guessing wrong there is cheap while
 * refusing to publish at all is not.
 */
export function defaultBranchOf(projectRoot: string): string | null {
  const head = git(projectRoot, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (head) {
    const name = head.replace(/^refs\/remotes\/origin\//, '');
    if (name && name !== head) return name;
  }
  for (const candidate of ['main', 'master']) {
    if (git(projectRoot, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${candidate}`])) {
      return candidate;
    }
  }
  return null;
}

/** Null on a detached HEAD, which is not a branch and must not be reported as one. */
export function currentBranchOf(projectRoot: string): string | null {
  const name = git(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return !name || name === 'HEAD' ? null : name;
}

/**
 * How many commits `origin/<branch>` has that this checkout does not.
 *
 * Read from the remote-tracking ref, never from the network. A fetch is the user's to run: doing
 * one here would put an unbounded network call in front of a command that is otherwise offline,
 * and a stale tracking ref errs toward refusing to publish, which is the safe direction.
 */
export function commitsBehindRemote(projectRoot: string, branch: string): number | null {
  const count = git(projectRoot, ['rev-list', '--count', `HEAD..origin/${branch}`]);
  if (count === null) return null;
  const parsed = Number(count);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Whether this checkout may speak for the team.
 *
 * Two conditions, and the second is the one that looks optional and is not. Being behind the
 * remote default branch is INDISTINGUISHABLE from the code having been deleted: the file the
 * team just published about is genuinely not here. Publishing or reporting drift from that
 * vantage retires knowledge that is still correct for everyone who is current.
 *
 * This repository has shipped that collapse before -- `fileContentHash` caught every read
 * error and returned null, `currentStateOf` mapped null to `gone`, and an antivirus lock on
 * Windows became "the file you read is deleted", fired as the strongest notice the system has
 * about an intact file.
 */
export function checkPublishGate(projectRoot: string): GateVerdict {
  let current: string | null;
  let target: string | null;
  try {
    current = currentBranchOf(projectRoot);
    target = defaultBranchOf(projectRoot);
  } catch (error: any) {
    return {
      ok: false,
      reason: 'git-unavailable',
      detail:
        `Could not run git in ${projectRoot}: ${error.message}. ` +
        'Publishing is gated on the default branch, so git has to be on PATH.',
    };
  }

  // "Git ran and could not tell me" is its own answer, and it is not "you are on the wrong
  // branch". A repo with no remote-tracking default branch has no team vantage to publish from,
  // and saying so names something the user can act on.
  if (!target) {
    return {
      ok: false,
      reason: 'git-unavailable',
      detail:
        `Could not determine the default branch of ${projectRoot}: no origin/HEAD, origin/main ` +
        'or origin/master. Run git remote set-head origin --auto, or fetch the remote first.',
    };
  }

  if (current !== target) {
    return {
      ok: false,
      reason: 'not-default-branch',
      detail:
        `This checkout is on ${current ?? 'a detached HEAD'}, not ${target}. ` +
        'Knowledge about code only this branch has would be false for everyone on ' +
        `${target}, and there is no unpublish.`,
    };
  }

  const behind = commitsBehindRemote(projectRoot, target);
  if (behind === null) {
    return {
      ok: false,
      reason: 'git-unavailable',
      detail: `Could not compare ${projectRoot} against origin/${target}.`,
    };
  }
  if (behind > 0) {
    return {
      ok: false,
      reason: 'behind-remote',
      detail:
        `This checkout is ${behind} commit(s) behind origin/${target}. ` +
        'From here, code the team just landed is indistinguishable from code that was deleted. ' +
        'Pull first.',
    };
  }

  return { ok: true };
}
