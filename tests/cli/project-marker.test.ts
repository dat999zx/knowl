import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findProjectRoot } from '../../src/core/config.js';
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
