import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';
import { isKnowlProjectGuidanceCurrent } from '../../src/core/agents-guidance.js';
import { resetWriteOwnershipCache } from '../../src/store/write-ownership.js';
import { recordKnownRepo } from '../../src/core/repo-registry.js';
import { formatSweepReport, sweepRepos } from '../../src/cli/upgrade-all.js';

const HOME = path.resolve('./.knowl-sweep-home');
const BASE = path.resolve('./.knowl-sweep');
const A = path.join(BASE, 'alpha');
const B = path.join(BASE, 'beta');
const MISSING = path.join(BASE, 'never-created');

async function makeRepo(root: string): Promise<void> {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
  await initDb(root);
  await repo.createProject(root, path.basename(root));
  await closeDb();
}

describe('upgrade --all sweep', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    for (const dir of [HOME, BASE]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await makeRepo(A);
    await makeRepo(B);
  });

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, BASE]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('upgrades and repairs every repository it is given', async () => {
    expect(await isKnowlProjectGuidanceCurrent(A)).toBe(false);
    expect(await isKnowlProjectGuidanceCurrent(B)).toBe(false);

    const results = await sweepRepos([A, B], {});

    expect(results.map(result => result.root)).toEqual([A, B]);
    expect(await isKnowlProjectGuidanceCurrent(A)).toBe(true);
    expect(await isKnowlProjectGuidanceCurrent(B)).toBe(true);
  });

  it('keeps going when one repository fails, and marks only that one', async () => {
    // The whole point of a sweep is that repository four still gets upgraded when repository
    // two is broken.
    const results = await sweepRepos([A, MISSING, B], {});

    expect(results.map(result => result.root)).toEqual([A, MISSING, B]);
    expect(results[1].error).toBeTruthy();
    expect(results[1].ready).toBe(false);
    expect(await isKnowlProjectGuidanceCurrent(B)).toBe(true);
  });

  it('snapshots a repository before changing it', async () => {
    // `upgrade` runs schema migrations, and snapshots already exist and are cheap.
    await sweepRepos([A], {});

    const snapshots = await fs.readdir(path.join(A, '.knowl', 'snapshots'));
    expect(snapshots.filter(entry => entry.endsWith('.db'))).toHaveLength(1);
  });

  it('skips the snapshot when it is turned off', async () => {
    await sweepRepos([A], { snapshot: false });

    await expect(fs.readdir(path.join(A, '.knowl', 'snapshots'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports an empty repository ready, and still reports what is missing from it', async () => {
    // Reversed deliberately. This used to assert NOT READY, on the reasoning that a sweep
    // calling an empty repo READY would hide the one thing it exists to report. But the
    // finding is reported either way -- it is in `warnings` and in `unfixable`, and the
    // report prints both under the repository -- so the verdict was not carrying it. What
    // the verdict did instead was tell someone who had just run `knowl init` that their
    // install was broken, and put a permanent NOT READY beside every new repo in the sweep
    // table until it happened to acquire knowledge. NOT READY has to mean broken, or the
    // rows that are genuinely broken stop standing out.
    const results = await sweepRepos([A], {});

    expect(results[0].ready).toBe(true);
    expect(results[0].unfixable.join(' ')).toMatch(/no knowledge stored yet/i);
    expect(results[0].warnings.join(' ')).toMatch(/no knowledge stored yet/i);
  });

  it('sweeps every discovered repository from the command line', { timeout: 120_000 }, async () => {
    // One spawn covering the whole path: discovery from the registry, the per-repo loop, the
    // report, and the exit code. The unit tests above cover the branches.
    const CLI = path.resolve('./dist/index.js');
    const run = (args: string[], cwd: string) => spawnSync(process.execPath, [CLI, ...args], {
      cwd, encoding: 'utf-8', env: { ...process.env, KNOWL_HOME: HOME, KNOWL_NO_UPDATE_CHECK: '1' },
    });

    // Registered the way real repos are: by being upgraded once.
    expect(run(['upgrade'], A).status).toBe(0);
    expect(run(['upgrade'], B).status).toBe(0);

    const swept = run(['upgrade', '--all'], BASE);

    expect(swept.stdout).toContain('KNOWL SWEEP');
    expect(swept.stdout).toContain(A);
    expect(swept.stdout).toContain(B);
    // Both repos are empty of knowledge. That is a WARN -- reported per repository in the
    // table below each row -- not a breakage, so the sweep counts them ready and exits 0.
    // This used to assert "0 of 2", which meant a machine full of healthy new repositories
    // reported zero ready and left nothing to distinguish the one that was actually broken.
    expect(swept.stdout).toMatch(/2 of 2 repositories ready/);
    expect(swept.stdout).toMatch(/no knowledge stored yet/i);
    expect(swept.status).toBe(0);
  });

  it('lists what a sweep would visit without touching anything', { timeout: 120_000 }, async () => {
    // A command that snapshots and upgrades every repository on the machine needs a way to
    // answer "which repositories is that, exactly?" before it runs.
    const CLI = path.resolve('./dist/index.js');
    const run = (args: string[], cwd: string) => spawnSync(process.execPath, [CLI, ...args], {
      cwd, encoding: 'utf-8', env: { ...process.env, KNOWL_HOME: HOME, KNOWL_NO_UPDATE_CHECK: '1' },
    });

    // Registered directly rather than by running `upgrade`, which would itself write the
    // guidance this test asserts is still missing afterwards.
    await recordKnownRepo(A);

    const planned = run(['upgrade', '--all', '--dry-run'], BASE);

    expect(planned.status).toBe(0);
    expect(planned.stdout).toContain(A);
    expect(planned.stdout).toMatch(/dry run/i);
    // Nothing changed: no snapshot, and the guidance a real sweep would have written is
    // still missing.
    await expect(fs.readdir(path.join(A, '.knowl', 'snapshots'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await isKnowlProjectGuidanceCurrent(A)).toBe(false);
  });

  it('says which registry entries it forgot instead of quietly sweeping fewer repos', async () => {
    // The live hazard: `~/.knowl/repos.json` on this machine carries a scratch path that a
    // sweep would snapshot and migrate. A registry line is dropped the moment the filesystem
    // says it is not a repository -- and dropping it in silence is how a sweep comes to visit
    // three repos when the user believes it visits four.
    const CLI = path.resolve('./dist/index.js');
    // Marker only, no database: this fixture exists to be un-made, and an open libSQL file
    // cannot be removed on Windows -- which is the same lock global teardown exists for.
    const gone = path.join(BASE, 'was-a-repo');
    await fs.mkdir(path.join(gone, '.knowl'), { recursive: true });
    await saveConfig(gone, { ...DEFAULT_CONFIG });
    await recordKnownRepo(A);
    await recordKnownRepo(gone);
    await fs.rm(path.join(gone, '.knowl'), { recursive: true, force: true });

    const planned = spawnSync(process.execPath, [CLI, 'upgrade', '--all', '--dry-run'], {
      cwd: BASE, encoding: 'utf-8', env: { ...process.env, KNOWL_HOME: HOME, KNOWL_NO_UPDATE_CHECK: '1' },
    });

    expect(planned.status).toBe(0);
    expect(planned.stdout).toContain(`Forgot ${gone}`);
    // And the sweep list itself no longer names it.
    expect(planned.stdout.slice(planned.stdout.indexOf('Would sweep'))).not.toContain(gone);
  });

  it('refuses a sweep-only flag outside a sweep rather than ignoring it', () => {
    const CLI = path.resolve('./dist/index.js');
    const result = spawnSync(process.execPath, [CLI, 'upgrade', '--reindex'], {
      cwd: A, encoding: 'utf-8', env: { ...process.env, KNOWL_HOME: HOME, KNOWL_NO_UPDATE_CHECK: '1' },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--reindex only applies to/);
  });

  it('names the repositories still needing attention in the report', async () => {
    const report = formatSweepReport([
      { root: A, ready: true, claimedItems: 2, applied: ['guidance'], deferred: [], failed: [], unfixable: [], warnings: [] },
      { root: B, ready: false, claimedItems: 0, applied: [], deferred: ['reindex-vectors'], failed: [], unfixable: ['Knowledge integrity audit found 1 error(s)'], warnings: ['[WARN] something'] },
    ]);

    expect(report).toContain('alpha');
    expect(report).toContain('beta');
    expect(report).toMatch(/1 of 2/);
    // A deferred repair is work the user chose not to do, so it has to be visible rather
    // than silently dropped from the summary.
    expect(report).toContain('reindex-vectors');
  });
});
