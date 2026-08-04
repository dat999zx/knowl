import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { recordKnownRepo } from '../../src/cli/repo-registry.js';
import { discoverRepos } from '../../src/cli/repo-discovery.js';

const HOME = path.resolve('./.knowl-discovery-home');
// Repository fixtures live *inside* a dot-named parent rather than being dot-named
// themselves: discovery deliberately skips dot-named directories, and global teardown
// deliberately sweeps `.knowl-` prefixed ones. Only nesting satisfies both.
const BASE = path.resolve('./.knowl-discovery');
const LINKED = path.join(BASE, 'linked');
const STANDALONE = path.join(BASE, 'standalone');
const SCAN_ROOT = path.join(BASE, 'scan');
const ABSENT = path.join(BASE, 'never-created');

/**
 * A repository fixture writes `.knowl/config.json`, not a bare `.knowl` directory.
 *
 * The directory alone stopped being the marker in the K-51 fix: `~/.knowl` is also called
 * `.knowl`, so a bare-directory test would admit the user's home directory to a sweep that
 * snapshots and migrates every repository it finds. What is asserted below is unchanged --
 * only what it takes to *be* a repository is.
 */
async function makeRepo(root: string): Promise<void> {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await fs.writeFile(path.join(root, '.knowl', 'config.json'), JSON.stringify({ version: 1 }), 'utf8');
}

describe('repo discovery', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    for (const dir of [HOME, BASE]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await makeRepo(LINKED);
    await makeRepo(STANDALONE);
  });

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    for (const dir of [HOME, BASE]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('finds repos named by a workspace manifest', async () => {
    const manifest = createManifest('ws', null);
    manifest.repos.push({ name: 'linked', path: LINKED });
    await writeManifest(workspaceManifestPath('ws'), manifest);

    expect((await discoverRepos({})).map(entry => entry.root)).toEqual([LINKED]);
  });

  it('finds a repo that belongs to no workspace', async () => {
    // The whole reason the registry exists: nothing outside its own directory knows about
    // an unlinked repo, so a sweep driven by manifests alone would silently skip it.
    await recordKnownRepo(STANDALONE);

    expect((await discoverRepos({})).map(entry => entry.root)).toEqual([STANDALONE]);
  });

  it('reports a repo once when a manifest and the registry both name it', async () => {
    const manifest = createManifest('ws', null);
    manifest.repos.push({ name: 'linked', path: LINKED });
    await writeManifest(workspaceManifestPath('ws'), manifest);
    await recordKnownRepo(LINKED);

    expect((await discoverRepos({})).map(entry => entry.root)).toEqual([LINKED]);
  });

  it('skips a manifest entry whose checkout is not on this machine', async () => {
    // A manifest is copied between machines by design, so it routinely names repos that do
    // not exist here. That is a partial checkout, not an error.
    const manifest = createManifest('ws', null);
    manifest.repos.push({ name: 'linked', path: LINKED });
    manifest.repos.push({ name: 'elsewhere', path: ABSENT });
    await writeManifest(workspaceManifestPath('ws'), manifest);

    expect((await discoverRepos({})).map(entry => entry.root)).toEqual([LINKED]);
  });

  it('finds unregistered repos under an explicit scan root, and remembers them', async () => {
    const nested = path.join(SCAN_ROOT, 'projects', 'api');
    await makeRepo(nested);

    const found = await discoverRepos({ roots: [SCAN_ROOT] });

    expect(found.map(entry => entry.root)).toEqual([nested]);
    // Recording what a scan found is what makes --root a one-time argument rather than
    // something to remember on every release.
    expect((await discoverRepos({})).map(entry => entry.root)).toEqual([nested]);
  });

  it('leaves no trace when told not to record, so a dry run really is one', async () => {
    const nested = path.join(SCAN_ROOT, 'projects', 'api');
    await makeRepo(nested);

    expect((await discoverRepos({ roots: [SCAN_ROOT], record: false })).map(entry => entry.root)).toEqual([nested]);
    expect(await discoverRepos({})).toEqual([]);
  });

  it('ignores the dot-named scratch directories a Knowl test run leaves behind', async () => {
    // `.knowl-*` fixtures are real Knowl repositories by every structural test, and a sweep
    // that visits them would upgrade and snapshot throwaway databases.
    await makeRepo(path.join(SCAN_ROOT, '.knowl-scratch-fixture'));
    await makeRepo(path.join(SCAN_ROOT, 'real'));

    const found = await discoverRepos({ roots: [SCAN_ROOT] });

    expect(found.map(entry => entry.root)).toEqual([path.join(SCAN_ROOT, 'real')]);
  });
});
