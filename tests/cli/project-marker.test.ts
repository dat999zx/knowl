import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
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

const BASE = path.resolve('./.knowl-project-marker');
const FAKE_HOME = path.join(BASE, 'home');
const UNDER_HOME = path.join(FAKE_HOME, 'scratch', 'not-a-repo');
const REAL = path.join(BASE, 'real');
const NESTED = path.join(REAL, 'src', 'deep');

describe('what marks a directory as a Knowl project', () => {
  beforeEach(async () => {
    await fs.rm(BASE, { recursive: true, force: true }).catch(() => {});

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
    root = await fs.mkdtemp(path.resolve('./.knowl-init-marker-'));
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
