import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createManifest, readManifest, writeManifest } from '../../src/workspace/manifest.js';
import { assertNotNested, isLinked, joinWorkspace, leaveWorkspace } from '../../src/workspace/membership.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../../src/core/config.js';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import { createProject } from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { resetWriteOwnershipCache } from '../../src/store/write-ownership.js';

const HOME = path.resolve('./.knowl-membership-home');

// Fresh directories per test rather than one pair reused. Removal is best-effort because
// Windows can hold libSQL's WAL sidecars briefly after close, which used to be harmless --
// makeRepo overwrote the config. It stopped being harmless once tests write knowledge: a
// surviving database carried the previous test's items into the next one's ownership count.
let counter = 0;
let REPO_A = '';
let REPO_B = '';

async function makeRepo(root: string) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
}

/** Ownership is what makes a name worth retiring, so the tests need a genuinely owned item. */
async function writeOneItem(root: string) {
  resetWriteOwnershipCache();
  await initDb(root);
  const projectId = (await createProject(root, path.basename(root))).id;
  await storeKnowledgeItemDeduped(projectId, {
    category: 'decision', title: 'Retry budget is three attempts',
    content: 'Outbound calls retry at most three times before failing the request.',
  });
  await closeDb();
  resetWriteOwnershipCache();
}

describe('two-sided membership', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    counter += 1;
    REPO_A = path.resolve(`./.knowl-membership-a${counter}`);
    REPO_B = path.resolve(`./.knowl-membership-b${counter}`);
    for (const dir of [HOME, REPO_A, REPO_B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await makeRepo(REPO_A);
    await makeRepo(REPO_B);
    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));
  });
  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
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

  it('refuses to reuse a name retired by a repo that owned knowledge', async () => {
    await joinWorkspace({ projectRoot: REPO_A, workspaceName: 'ws', repoName: 'a' });
    await writeOneItem(REPO_A);
    expect(await leaveWorkspace(REPO_A)).toEqual({ retired: true });
    await expect(joinWorkspace({ projectRoot: REPO_B, workspaceName: 'ws', repoName: 'a' }))
      .rejects.toThrow(/retired/i);
  });

  it('releases the name when the leaving repo owned nothing', async () => {
    // Retirement exists so a name cannot carry another repo's authorship to a new owner.
    // With no items there is no authorship to carry, and burning the obvious name for a
    // link made by mistake is pure cost.
    await joinWorkspace({ projectRoot: REPO_A, workspaceName: 'ws', repoName: 'a' });
    expect(await leaveWorkspace(REPO_A)).toEqual({ retired: false });
    await expect(joinWorkspace({ projectRoot: REPO_B, workspaceName: 'ws', repoName: 'a' }))
      .resolves.toBeDefined();
  });

  it('lets the repo that owns the items reclaim its own retired name', async () => {
    // Re-linking the same repo transfers nothing: the items are already its own. Without
    // this, repairing an accidental unlink meant inventing a new name and orphaning every
    // item still stamped with the old one.
    await joinWorkspace({ projectRoot: REPO_A, workspaceName: 'ws', repoName: 'a' });
    await writeOneItem(REPO_A);
    await leaveWorkspace(REPO_A);

    const manifest = await joinWorkspace({ projectRoot: REPO_A, workspaceName: 'ws', repoName: 'a' });
    expect(manifest.repos.map(entry => entry.name)).toEqual(['a']);
    expect(manifest.retiredNames).toEqual([]);
  });

  it('refuses an embedding identity the workspace does not use', async () => {
    await joinWorkspace({ projectRoot: REPO_A, workspaceName: 'ws', repoName: 'a' });
    await saveConfig(REPO_B, {
      ...DEFAULT_CONFIG,
      search: { vector: { enabled: true, provider: 'local', model: 'other/model', dtype: 'q8' } },
    });
    await expect(joinWorkspace({ projectRoot: REPO_B, workspaceName: 'ws', repoName: 'b' }))
      .rejects.toThrow(/invisible to each other/i);
  });

  it('leaving an unlinked repo is a no-op rather than an error', async () => {
    await expect(leaveWorkspace(REPO_B)).resolves.toEqual({ retired: false });
  });
});
