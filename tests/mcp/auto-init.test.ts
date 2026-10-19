import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  adoptProject, scaffoldProject, scaffoldTarget, serveAutoInitAllowed,
} from '../../src/mcp/auto-init.js';
import { isProjectRoot, loadConfig } from '../../src/core/config.js';
import { repoRegistryPath } from '../../src/core/repo-registry.js';
import { closeDb } from '../../src/store/database.js';
import { getProjectByRootPath } from '../../src/store/repository.js';

/**
 * The catalog-install case: `serve` launched where nobody ever ran `knowl init`, because no
 * marketplace install flow contains a step that could (OpenHands/extensions#486 was closed
 * over exactly this). Auto-init must leave a working store while staying narrower than init —
 * a server is a guest in the directory it was pointed at, so it may create its own store and
 * keep that store out of git, and nothing else.
 */
describe('serve auto-init', () => {
  let dir: string;
  /** Repo-relative, matching tests/core/repo-registry.test.ts — never the developer's ~/.knowl. */
  const HOME = path.resolve('./.knowl-autoinit-home');

  beforeEach(async () => {
    dir = '';
    process.env.KNOWL_HOME = HOME;
    await fs.mkdir(HOME, { recursive: true });
  });

  afterEach(async () => {
    await closeDb();
    // Best-effort, as every store test does it: on Windows the @libsql handle can outlive
    // closeDb briefly and EBUSY the WAL files; the per-run temp root is swept globally anyway.
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
    delete process.env.KNOWL_HOME;
    delete process.env.KNOWL_DISABLE_SERVE_AUTO_INIT;
  });

  async function freshGitDir(): Promise<string> {
    const created = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-autoinit-'));
    execFileSync('git', ['init', '-q', created]);
    return created;
  }

  it('is on by default and off when KNOWL_DISABLE_SERVE_AUTO_INIT=1', () => {
    expect(serveAutoInitAllowed()).toBe(true);
    process.env.KNOWL_DISABLE_SERVE_AUTO_INIT = '1';
    expect(serveAutoInitAllowed()).toBe(false);
  });

  /**
   * A bare cwd is not an anchor: hosts launch stdio servers from home directories and app
   * install dirs, and a store created there is permanent state nobody asked for (the K-51
   * incident). The git repository is the anchor; no repository, no store.
   */
  it('refuses a directory with no git repository to anchor on', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-autoinit-'));
    expect(await scaffoldTarget(dir)).toBeNull();
  });

  it('anchors on the git root, not the cwd it was launched from', async () => {
    dir = await freshGitDir();
    const nested = path.join(dir, 'src', 'deep');
    await fs.mkdir(nested, { recursive: true });
    expect(path.resolve((await scaffoldTarget(nested))!)).toBe(path.resolve(dir));
  });

  /**
   * knowl init's own named guard (src/cli/program.ts), kept for the dotfiles-repo case where
   * the home directory itself is under version control and the git anchor would otherwise
   * walk straight back into K-51: a store inside the real Knowl home.
   */
  it('never targets a root whose .knowl would be the machine\'s Knowl home', async () => {
    dir = await freshGitDir();
    process.env.KNOWL_HOME = path.join(dir, '.knowl');
    expect(await scaffoldTarget(dir)).toBeNull();
  });

  /**
   * A repository can ship `.knowl/skill-trust.json`, and that file is the ONLY thing standing
   * between a planted `.knowl/skills/` package and a spawned process -- the trust record and
   * the bytes it vouches for both live in the repo (src/skills/trust.ts). Proven: with the
   * two files planted and no config or database, auto-init used to make the directory a
   * project and `knowl_skill_run` executed the entrypoint with exit code 0 and no approval.
   * `knowl init` may adopt such a checkout, because a human ran it; a host process may not.
   */
  it('refuses a repository that ships its own skill-trust.json', async () => {
    dir = await freshGitDir();
    await fs.mkdir(path.join(dir, '.knowl', 'skills'), { recursive: true });
    await fs.writeFile(path.join(dir, '.knowl', 'skill-trust.json'), '{}');

    expect(await scaffoldTarget(dir)).toBeNull();
  });

  it('scaffolds a loadable project root and nothing else', async () => {
    dir = await freshGitDir();
    await scaffoldProject(dir);

    expect(await isProjectRoot(dir)).toBe(true);
    await expect(loadConfig(dir)).resolves.toBeDefined();
    // The boundary: no guidance files, no agent files — those are init's to write, on request.
    await expect(fs.access(path.join(dir, 'KNOWL.md'))).rejects.toThrow();
    await expect(fs.access(path.join(dir, 'AGENTS.md'))).rejects.toThrow();
  });

  it('scaffolding an already-initialized root changes nothing', async () => {
    dir = await freshGitDir();
    await scaffoldProject(dir);
    const before = await fs.readFile(path.join(dir, '.knowl', 'config.json'), 'utf8');
    await scaffoldProject(dir);
    expect(await fs.readFile(path.join(dir, '.knowl', 'config.json'), 'utf8')).toBe(before);
  });

  it('adoptProject registers the repo and leaves the store self-ignored', async () => {
    dir = await freshGitDir();
    await scaffoldProject(dir);

    const project = await adoptProject(dir);
    expect(project).not.toBeNull();
    expect(await getProjectByRootPath(dir)).not.toBeNull();

    // The registry assertion that can fail: the entry itself, read through the module's own
    // path helper — not the existence of some file with "repo" in its name.
    const entries: string[] = JSON.parse(await fs.readFile(repoRegistryPath(), 'utf-8')).repos;
    expect(entries.map(entry => path.resolve(entry))).toContain(path.resolve(dir));

    // venv's shape: the ignore file lives INSIDE the created directory and ignores all of it,
    // so no file the user owns is edited. The repository's own .gitignore is untouched.
    const selfIgnore = await fs.readFile(path.join(dir, '.knowl', '.gitignore'), 'utf8');
    expect(selfIgnore).toContain('*');
    await expect(fs.access(path.join(dir, '.gitignore'))).rejects.toThrow();
  });

  it('adopting twice is idempotent', async () => {
    dir = await freshGitDir();
    await scaffoldProject(dir);

    const first = await adoptProject(dir);
    const second = await adoptProject(dir);
    expect(second!.id).toBe(first!.id);

    const entries: string[] = JSON.parse(await fs.readFile(repoRegistryPath(), 'utf-8')).repos;
    expect(entries.filter(entry => path.resolve(entry) === path.resolve(dir))).toHaveLength(1);
  });
});
