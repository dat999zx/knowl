import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import { globalStorePath, knowlHome } from '../../src/core/paths.js';
import { ensureGlobalStore } from '../../src/store/global-store.js';
import { ConfigError, ProjectNotFoundError } from '../../src/core/errors.js';
import { GLOBAL_REPO_IDENTITY, resolveCloudTarget, scopeNotice, shouldUseGlobalStore } from '../../src/cli/cloud-target.js';
import { resolveRepoIdentity } from '../../src/cloud/repo-identity.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

let testCount = 0;

/** A directory that is a Knowl project, so `findProjectRoot` resolves it. */
async function makeProject(root: string): Promise<string> {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
  return root;
}

describe('cloud commands addressing the machine store', () => {
  const saved = process.env.KNOWL_HOME;
  let HOME = '';
  let SCRATCH = '';

  beforeEach(async () => {
    const id = testCount++;
    HOME = path.join(os.tmpdir(), `knowl-cloudscope-home-${id}`);
    SCRATCH = path.join(os.tmpdir(), `knowl-cloudscope-work-${id}`);
    process.env.KNOWL_HOME = HOME;
    await closeDb().catch(() => {});
    await releaseAll().catch(() => {});
    for (const d of [HOME, SCRATCH]) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(SCRATCH, { recursive: true });
  });

  afterEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll().catch(() => {});
    for (const d of [HOME, SCRATCH]) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
    if (saved === undefined) delete process.env.KNOWL_HOME; else process.env.KNOWL_HOME = saved;
  });

  // -- the seam that makes a root enough ------------------------------------

  it('opens the global store when handed the machine home, not a project db beneath it', async () => {
    // `loadConfig` already substitutes `~/.knowl/config.json` for this same root. Without the
    // matching substitution here a caller handing the home to both gets a config from one place
    // and a database from another -- in practice `~/.knowl/.knowl/knowl.db`, which is nobody's
    // store and fails to open. That pair is what lets every cloud entry point keep taking a root.
    await ensureGlobalStore();
    await initDb(knowlHome());

    // Asserted through what is on disk rather than an internal getter: opening succeeds, and the
    // store it would otherwise have reached for is never created. Before this, `initDb` here
    // resolved `<home>/.knowl/knowl.db` and threw on open.
    const strayProjectDb = path.join(knowlHome(), '.knowl', 'knowl.db');
    await expect(fs.access(globalStorePath())).resolves.toBeUndefined();
    await expect(fs.access(strayProjectDb)).rejects.toThrow();
  });

  it('carries the cloud ledger, so the machine store can stage like a project', async () => {
    await ensureGlobalStore();
    await initDb(knowlHome());
    // Reading it at all is the assertion: a missing table throws instead of returning no rows.
    const rows = await getClient().execute('SELECT item_id, remote_workspace FROM cloud_published');
    expect(rows.rows).toHaveLength(0);
  });

  // -- which store a command acts on ----------------------------------------

  it('acts on the machine store when --global is passed', async () => {
    const target = await resolveCloudTarget({ global: true }, SCRATCH);
    expect(target.scope).toBe('global');
    expect(path.resolve(target.root)).toBe(path.resolve(knowlHome()));
    expect(target.inferred).toBe(false);
    expect(scopeNotice(target)).toBe('');
  });

  it('acts on the project when there is one, even with a machine store present', async () => {
    await ensureGlobalStore();
    const project = await makeProject(path.join(SCRATCH, 'repo'));
    const target = await resolveCloudTarget({}, project);
    expect(target.scope).toBe('project');
    expect(path.resolve(target.root)).toBe(path.resolve(project));
    expect(scopeNotice(target)).toBe('');
  });

  it('falls back to the machine store when there is no project, and says so', async () => {
    await ensureGlobalStore();
    const target = await resolveCloudTarget({}, SCRATCH);
    expect(target.scope).toBe('global');
    expect(target.inferred).toBe(true);
    expect(scopeNotice(target)).toContain('--global');
  });

  it('refuses rather than inventing a scope when there is no project and no machine store', async () => {
    await expect(resolveCloudTarget({}, SCRATCH)).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('publishes under a readable name rather than the directory it happens to live in', () => {
    // Left to the ordinary fallback, the machine store connects under its DIRECTORY name, which
    // in a real install is `.knowl`: unreadable in a workspace listing, and the same string for
    // every person, so two people connecting their machine stores to one workspace collide.
    const fallback = resolveRepoIdentity(knowlHome());
    expect(fallback.source).toBe('directory');
    expect(fallback.identity).toBe(path.basename(knowlHome()));
    expect(GLOBAL_REPO_IDENTITY).toMatch(/^[a-z][a-z0-9-]*$/);

    // Fixed, not derived from the machine: one person's laptop and desktop hold one set of
    // personal defaults, and a hostname would split them into two repos foreign to each other.
    expect(resolveRepoIdentity(knowlHome(), { repo: GLOBAL_REPO_IDENTITY }).identity)
      .toBe(GLOBAL_REPO_IDENTITY);
  });

  it('answers globally only for a missing project, never for a broken one', () => {
    // The safety property of this module, tested on the predicate rather than through
    // `resolveCloudTarget`: `findProjectRoot` raises exactly ONE error type, so a widened catch
    // cannot be reached end-to-end -- verified by mutation, where broadening the guard to `catch
    // (error)` passed every behavioural test in this file. A guard nothing can fail is a guard
    // that quietly stops holding.
    //
    // A config that will not parse is an error ABOUT a project. Answering it from someone's
    // personal defaults would look like it worked, which is worse than refusing.
    expect(shouldUseGlobalStore(new ProjectNotFoundError('/nowhere'), true)).toBe(true);
    expect(shouldUseGlobalStore(new ProjectNotFoundError('/nowhere'), false)).toBe(false);

    for (const other of [new ConfigError('config.json is not valid JSON'), new Error('EACCES'), 'a string', null]) {
      expect(shouldUseGlobalStore(other, true)).toBe(false);
    }
  });
});
