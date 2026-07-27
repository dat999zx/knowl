import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createManifest, readManifest, writeManifest } from '../../src/workspace/manifest.js';
import { assertNotNested, isLinked, joinWorkspace, leaveWorkspace } from '../../src/workspace/membership.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../../src/core/config.js';
import { closeDb } from '../../src/store/database.js';

const HOME = path.resolve('./.knowl-membership-home');
const REPO_A = path.resolve('./.knowl-membership-a');
const REPO_B = path.resolve('./.knowl-membership-b');

async function makeRepo(root: string) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
}

describe('two-sided membership', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    // Close before removing, and tolerate a failed removal: on Windows libSQL can hold the
    // WAL sidecars for a moment after close, and a leftover directory is harmless because
    // makeRepo overwrites the config the tests read.
    await closeDb();
    for (const dir of [HOME, REPO_A, REPO_B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await makeRepo(REPO_A);
    await makeRepo(REPO_B);
    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));
  });
  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    for (const dir of [HOME, REPO_A, REPO_B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('writes both sides on join', async () => {
    await joinWorkspace({ projectRoot: REPO_A, workspaceName: 'ws', repoName: 'a' });
    const manifest = await readManifest(workspaceManifestPath('ws'));
    const config = await loadConfig(REPO_A);
    expect(manifest.repos.map(repo => repo.name)).toEqual(['a']);
    expect(config.workspace).toEqual({ workspace: 'ws', repo: 'a' });
  });

  it('is not linked when only the config names the workspace', async () => {
    await saveConfig(REPO_A, { ...DEFAULT_CONFIG, workspace: { workspace: 'ws', repo: 'a' } });
    const manifest = await readManifest(workspaceManifestPath('ws'));
    expect(isLinked(REPO_A, manifest, await loadConfig(REPO_A))).toBe(false);
  });

  it('is not linked when only the manifest lists the repo', async () => {
    const manifest = createManifest('ws', null);
    manifest.repos.push({ name: 'a', path: REPO_A });
    await writeManifest(workspaceManifestPath('ws'), manifest);
    expect(isLinked(REPO_A, manifest, await loadConfig(REPO_A))).toBe(false);
  });

  it('removes both sides on leave', async () => {
    await joinWorkspace({ projectRoot: REPO_A, workspaceName: 'ws', repoName: 'a' });
    await leaveWorkspace(REPO_A);
    expect((await loadConfig(REPO_A)).workspace).toBeUndefined();
    expect((await readManifest(workspaceManifestPath('ws'))).repos).toEqual([]);
  });

  it('rejects a repo nested inside an existing member', async () => {
    const nested = path.join(REPO_A, 'packages', 'inner');
    const manifest = createManifest('ws', null);
    manifest.repos.push({ name: 'a', path: REPO_A });
    // findProjectRoot walks up, so the inner repo would resolve to the outer one --
    // wrong ownership and wrong session binding, silently.
    expect(() => assertNotNested(nested, manifest)).toThrow(/nested/i);
  });

  it('rejects a member that would contain an existing one', () => {
    const manifest = createManifest('ws', null);
    manifest.repos.push({ name: 'inner', path: path.join(REPO_A, 'packages', 'inner') });
    expect(() => assertNotNested(REPO_A, manifest)).toThrow(/contains/i);
  });

  it('refuses to reuse a retired name', async () => {
    await joinWorkspace({ projectRoot: REPO_A, workspaceName: 'ws', repoName: 'a' });
    await leaveWorkspace(REPO_A);
    await expect(joinWorkspace({ projectRoot: REPO_B, workspaceName: 'ws', repoName: 'a' }))
      .rejects.toThrow(/retired/i);
  });

  it('leaving an unlinked repo is a no-op rather than an error', async () => {
    await expect(leaveWorkspace(REPO_B)).resolves.toBeUndefined();
  });
});
