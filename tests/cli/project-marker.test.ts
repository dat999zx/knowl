import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findProjectRoot, mainWorktreeRoot } from '../../src/core/config.js';
import { findProjectRootSync } from '../../src/cli/database-presence.js';
import { discoverRepos } from '../../src/cli/repo-discovery.js';

/**
 * K-51: `~/.knowl` is machine-local Knowl state, not a project.
 *
 * Both directories are literally called `.knowl`, so every predicate that asked only
 * "is there a `.knowl` directory here" answered yes for the home directory. Reproduced on
 * this machine during the audit: one `agent-hook` call made from a scratch directory under
 * `C:\Users\Admin` walked up, decided `C:\Users\Admin` was the project, and created a fresh
 * empty `knowledge.db` inside the user's real `~/.knowl`.
 *
 * The marker is therefore `.knowl/config.json` -- the file `knowl init` writes and every
 * command reads -- rather than the directory. A home directory has no config.json in it.
 */

/**
 * Outside the repository, and that is load-bearing rather than tidiness.
 *
 * `findProjectRoot` walks UP until it finds a marker, so a fixture placed under the checkout
 * is only isolated while the checkout is not itself a Knowl project. It is one on every
 * maintainer's machine -- `.knowl/` is gitignored, so CI's fresh clone has none and passed
 * while `npm test` failed locally with the repo's own root as the resolved answer. A test
 * whose verdict depends on whether the developer has run `knowl init` is testing the machine.
 *
 * `os.tmpdir()` also makes the first case a truer version of what K-51 actually was: a scratch
 * directory somewhere under the real home, walking up past the real `~/.knowl`.
 */
let BASE: string;
let FAKE_HOME: string;
let UNDER_HOME: string;
let REAL: string;
let NESTED: string;

describe('what marks a directory as a Knowl project', () => {
  beforeEach(async () => {
    BASE = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-project-marker-'));
    FAKE_HOME = path.join(BASE, 'home');
    UNDER_HOME = path.join(FAKE_HOME, 'scratch', 'not-a-repo');
    REAL = path.join(BASE, 'real');
    NESTED = path.join(REAL, 'src', 'deep');

    // Shaped like a real ~/.knowl: machine-local state, and no project config.
    await fs.mkdir(path.join(FAKE_HOME, '.knowl', 'workspaces'), { recursive: true });
    await fs.mkdir(path.join(FAKE_HOME, '.knowl', 'diagnostics'), { recursive: true });
    await fs.writeFile(path.join(FAKE_HOME, '.knowl', 'repos.json'), '[]', 'utf8');
    await fs.writeFile(path.join(FAKE_HOME, '.knowl', 'resume.db'), '', 'utf8');
    await fs.mkdir(UNDER_HOME, { recursive: true });

    await fs.mkdir(path.join(REAL, '.knowl'), { recursive: true });
    await fs.writeFile(path.join(REAL, '.knowl', 'config.json'), JSON.stringify({ version: 1 }), 'utf8');
    await fs.mkdir(NESTED, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(BASE, { recursive: true, force: true }).catch(() => {});
  });

  it('does not resolve a home directory holding machine-local state as a project root', async () => {
    await expect(findProjectRoot(UNDER_HOME)).rejects.toThrow(/No Knowl project found/);
  });

  it('still resolves a real project from a nested working directory', async () => {
    expect(await findProjectRoot(NESTED)).toBe(REAL);
  });

  it('leaves a machine-local .knowl out of the sweep that upgrades every repository', async () => {
    const found = await discoverRepos({ roots: [BASE], record: false });
    const roots = found.map(entry => entry.root);
    expect(roots).toContain(REAL);
    expect(roots).not.toContain(FAKE_HOME);
  });
});

/**
 * A git worktree is a checkout of the same repository, and it must reach the same memory.
 *
 * `.knowl/` is gitignored, so `git worktree add` -- which materialises tracked files only --
 * produces a checkout with no marker anywhere in it. When the worktree is placed outside the
 * main checkout, the ancestor walk has nothing to find and every command fails with
 * `No Knowl project found`. Measured 2026-08-16 against 5.4.0: `knowl doctor` reported
 * NOT READY and `knowl query` exited non-zero inside a worktree under the system temp
 * directory.
 *
 * That is the whole of the parallel-agent case. `isolation: "worktree"` on Claude Code's Agent
 * tool, this repository's own `docs/audit-lanes.md`, and every orchestrator that fans agents
 * out across isolated checkouts all produce exactly this shape -- so the agents that most need
 * shared memory were the ones guaranteed not to have it.
 *
 * The fallback runs only after the ordinary walk fails, which is what keeps a Knowl project
 * nested inside a larger git repository resolving to itself rather than jumping out to the
 * enclosing repository's main worktree (K-09).
 */
function git(cwd: string, args: string[]) {
  // Per-invocation identity: `git config` run in a fixture searches upward and lands in the
  // nearest enclosing repository, which for a fixture is this one. `-c` writes no file.
  const result = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd, encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

describe('a git worktree of an initialized repository', () => {
  let base = '';
  let main = '';
  let outside = '';
  let nestedWorktree = '';

  beforeEach(async () => {
    base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-worktree-')));
    main = path.join(base, 'main');
    outside = path.join(base, 'trees', 'agent-1');
    nestedWorktree = path.join(main, '.agents', 'agent-2');

    await fs.mkdir(main, { recursive: true });
    git(main, ['init', '--initial-branch=main']);
    await fs.writeFile(path.join(main, 'README.md'), '# fixture\n', 'utf8');
    await fs.writeFile(path.join(main, '.gitignore'), '.knowl/\n', 'utf8');
    git(main, ['add', '.']);
    git(main, ['commit', '-m', 'init']);

    // The marker, deliberately never committed -- which is the real situation.
    await fs.mkdir(path.join(main, '.knowl'), { recursive: true });
    await fs.writeFile(path.join(main, '.knowl', 'config.json'), JSON.stringify({ version: 1 }), 'utf8');

    git(main, ['worktree', 'add', '-b', 'agent-1', outside]);
    git(main, ['worktree', 'add', '-b', 'agent-2', nestedWorktree]);
  });

  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true }).catch(() => {});
  });

  it('carries no marker of its own, which is the premise of the bug', async () => {
    await expect(fs.access(path.join(outside, '.knowl', 'config.json'))).rejects.toThrow();
  });

  it('resolves to the main checkout when the worktree sits outside it', async () => {
    expect(await findProjectRoot(outside)).toBe(main);
  });

  it('resolves from a nested directory inside that worktree', async () => {
    const deep = path.join(outside, 'src', 'deep');
    await fs.mkdir(deep, { recursive: true });
    expect(await findProjectRoot(deep)).toBe(main);
  });

  it('still resolves a worktree placed inside the main checkout by the ordinary walk', async () => {
    expect(await findProjectRoot(nestedWorktree)).toBe(main);
  });

  it('does not invent a project for a worktree whose main checkout has no marker', async () => {
    await fs.rm(path.join(main, '.knowl'), { recursive: true, force: true });
    await expect(findProjectRoot(outside)).rejects.toThrow(/No Knowl project found/);
  });

  it('resolves the same way through the synchronous resolver', async () => {
    // `assertDatabasePresentForCommand` treats null as "not a project, nothing to check", so a
    // sync resolver that gave up here would silently skip the missing-database guard in exactly
    // the checkouts the async resolver had just started serving.
    expect(findProjectRootSync(outside)).toBe(main);
  });

  it('does not adopt an enclosing repository when the start path is simply not a project', async () => {
    // A plain checkout with no Knowl project anywhere must still fail, or the fallback would
    // turn "not initialized" into "silently borrowed somebody else's store".
    const plain = path.join(base, 'plain');
    await fs.mkdir(plain, { recursive: true });
    git(plain, ['init', '--initial-branch=main']);
    await expect(findProjectRoot(plain)).rejects.toThrow(/No Knowl project found/);
  });

  /**
   * `GIT_DIR` outranks `cwd`, and git exports it into every hook it runs.
   *
   * So a subprocess of `git commit` -- husky, lint-staged, or Knowl's own agent hook fired from
   * one -- inherits a `GIT_DIR` naming a repository that has nothing to do with the directory it
   * is standing in. Asking `git rev-parse --git-common-dir` there answers about the inherited
   * repository, and the directory silently reads and writes memory that is not its own. That is
   * worse than the miss the fallback was added to cure: a wrong answer, delivered confidently.
   */
  it('ignores an inherited GIT_DIR naming an unrelated repository', async () => {
    const unrelated = path.join(base, 'unrelated', 'deep');
    await fs.mkdir(unrelated, { recursive: true });

    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(main, '.git');
    try {
      expect(mainWorktreeRoot(unrelated)).toBeNull();
      await expect(findProjectRoot(unrelated)).rejects.toThrow(/No Knowl project found/);
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
  });

  /**
   * The miss branch is `agent-hook`'s ordinary case -- it fires in every directory the agent
   * visits, most of which are not repositories at all -- and it runs as a fresh process
   * hundreds of times a session, so a ~22ms `git` spawn there is unamortisable overhead on the
   * one command whose cost was deliberately engineered down to 175ms.
   *
   * A linked worktree writes `.git` as a FILE; a main checkout writes a DIRECTORY. Refusing to
   * spawn git without that marker keeps the cost on the path that needs it and off the path
   * that does not.
   */
  it('answers null without consulting git when no linked-worktree marker is present', async () => {
    const bare = path.join(base, 'not-a-repo', 'deep');
    await fs.mkdir(bare, { recursive: true });
    expect(mainWorktreeRoot(bare)).toBeNull();

    // The main checkout is a repository, and still not a linked worktree.
    expect(mainWorktreeRoot(main)).toBeNull();
  });
});

/**
 * Resolving sideways into the main checkout gave the `knowl init` guard a case its message was
 * never written for.
 *
 * The guard exists for a subpackage NESTED inside an initialized repository, and every line of
 * it assumes that: "is inside", "run knowl commands from anywhere under", "move it outside that
 * repository first". A linked worktree placed beside the main checkout is none of those -- it is
 * not inside, you no longer need to be under the main checkout to reach the memory, and it is
 * already outside, so the escape hatch names something the user has done. Refusing is still
 * right; describing it wrongly is not.
 */
describe('knowl init inside a git worktree of an initialized repository', () => {
  let base = '';
  let main = '';
  let worktree = '';

  beforeEach(async () => {
    base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-init-worktree-')));
    main = path.join(base, 'main');
    worktree = path.join(base, 'trees', 'agent-1');

    await fs.mkdir(main, { recursive: true });
    git(main, ['init', '--initial-branch=main']);
    await fs.writeFile(path.join(main, '.gitignore'), '.knowl/\n', 'utf8');
    git(main, ['add', '.']);
    git(main, ['commit', '-m', 'init']);
    await fs.mkdir(path.join(main, '.knowl'), { recursive: true });
    await fs.writeFile(path.join(main, '.knowl', 'config.json'), JSON.stringify({ version: 1 }), 'utf8');
    git(main, ['worktree', 'add', '-b', 'agent-1', worktree]);
  });

  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true }).catch(() => {});
  });

  it('refuses, and says the worktree already reaches that memory', async () => {
    const result = initIn(worktree, path.join(base, 'home'));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('is a git worktree of the Knowl repository at');
    expect(result.stderr).toContain(main);
    // The nested-subpackage wording is false here and must not be what the user sees.
    expect(result.stderr).not.toContain('is inside the Knowl repository at');
    expect(result.stderr).not.toContain('move it outside that repository first');
    // It must still refuse to build the second store.
    await expect(fs.access(path.join(worktree, '.knowl', 'config.json'))).rejects.toThrow();
  });
});

/**
 * `knowl init` has to read the marker the same way, and it was the one command that did not.
 *
 * It asked whether the `.knowl` *directory* existed and, if it did, routed to the upgrade
 * path -- which begins by reading `.knowl/config.json`. A directory without that file is not
 * an exotic state: an interrupted first init leaves one, and so does a removal that got
 * partway, which is the normal outcome on Windows where `fs.rm(recursive)` rejects on a held
 * libSQL file *after* it has already unlinked the file's siblings. The user then saw a bare
 * `ENOENT ... .knowl/config.json` naming a file they never had, and every re-run of the one
 * command that should repair it produced the same error.
 */
const CLI = path.resolve('./dist/index.js');

function initIn(cwd: string, home: string) {
  return spawnSync(process.execPath, [CLI, 'init', '--yes'], {
    cwd, encoding: 'utf8', env: { ...process.env, KNOWL_HOME: home },
  });
}

describe('knowl init against a .knowl directory that is not a project', () => {
  let root = '';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-init-marker-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('finishes a half-initialized repository instead of failing on the config it never wrote', async () => {
    const repoDir = path.join(root, 'repo');
    // Exactly what a rejected recursive remove leaves behind: the directory, minus the file.
    await fs.mkdir(path.join(repoDir, '.knowl'), { recursive: true });

    const result = initIn(repoDir, path.join(root, 'home'));

    expect(result.stderr).not.toContain('ENOENT');
    expect(result.status).toBe(0);
    await expect(fs.access(path.join(repoDir, '.knowl', 'config.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(repoDir, '.knowl', 'knowl.db'))).resolves.toBeUndefined();
  });

  it('refuses to turn the machine Knowl home into a project', async () => {
    // The K-51 directory itself. Reading the marker as config.json is what makes init willing
    // to write into a `.knowl` it did not create, so the one `.knowl` that must never become a
    // repository has to be named explicitly rather than protected by an accident.
    const home = path.join(root, 'home', '.knowl');
    await fs.mkdir(path.join(home, 'workspaces'), { recursive: true });
    await fs.writeFile(path.join(home, 'repos.json'), '{"repos":[]}', 'utf8');

    const result = initIn(path.join(root, 'home'), home);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Knowl home/i);
    await expect(fs.access(path.join(home, 'config.json'))).rejects.toThrow();
  });
});
