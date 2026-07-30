import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createManifest, readManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { defaultVisibilityOf, repoEntry, updateRepoSettings } from '../../src/workspace/repo-settings.js';

const HOME = path.resolve('./.knowl-repo-settings-home');

describe('repo settings', () => {
  beforeAll(async () => { process.env.KNOWL_HOME = HOME; await fs.rm(HOME, { recursive: true, force: true }); });
  afterAll(async () => { delete process.env.KNOWL_HOME; await fs.rm(HOME, { recursive: true, force: true }).catch(() => {}); });

  async function seed(name: string) {
    const manifest = createManifest(name, null);
    manifest.repos.push({ name: 'server' }, { name: 'notes', defaultVisibility: 'workspace' });
    await writeManifest(workspaceManifestPath(name), manifest);
    return manifest;
  }

  it('reports absent default visibility as repo, which is what every existing manifest says', async () => {
    const manifest = await seed('reads');
    expect(defaultVisibilityOf(manifest, 'server')).toBe('repo');
    expect(defaultVisibilityOf(manifest, 'notes')).toBe('workspace');
    // A name in no entry is not a member; private is the only safe answer.
    expect(defaultVisibilityOf(manifest, 'ghost')).toBe('repo');
    expect(repoEntry(manifest, 'ghost')).toBeUndefined();
  });

  it('writes only the calling repo entry and leaves its neighbours untouched', async () => {
    await seed('writes');
    await updateRepoSettings({ workspaceName: 'writes', repoName: 'server', settings: { role: 'the API server', kin: 'forks' } });

    const loaded = await readManifest(workspaceManifestPath('writes'));
    expect(repoEntry(loaded, 'server')).toMatchObject({ role: 'the API server', kin: 'forks' });
    expect(repoEntry(loaded, 'notes')).toEqual({ name: 'notes', defaultVisibility: 'workspace' });
  });

  it('refuses to edit an entry this repo does not own', async () => {
    await seed('owned');
    await expect(updateRepoSettings({ workspaceName: 'owned', repoName: 'ghost', settings: { role: 'x' } }))
      .rejects.toThrow(/not a member/i);
  });

  it('leaves an unmentioned field alone, so setting one does not clear another', async () => {
    await seed('partial');
    await updateRepoSettings({ workspaceName: 'partial', repoName: 'server', settings: { role: 'first' } });
    await updateRepoSettings({ workspaceName: 'partial', repoName: 'server', settings: { kin: 'forks' } });
    expect(repoEntry(await readManifest(workspaceManifestPath('partial')), 'server'))
      .toMatchObject({ role: 'first', kin: 'forks' });
  });

  it('clears a field when given an empty string, which is the only way to unset one', async () => {
    await seed('clears');
    await updateRepoSettings({ workspaceName: 'clears', repoName: 'notes', settings: { role: 'notes' } });
    await updateRepoSettings({ workspaceName: 'clears', repoName: 'notes', settings: { role: '' } });
    expect(repoEntry(await readManifest(workspaceManifestPath('clears')), 'notes')?.role).toBeUndefined();
  });

  it('normalizes on the way in, so a bad value cannot reach the manifest', async () => {
    await seed('normal');
    await updateRepoSettings({ workspaceName: 'normal', repoName: 'server', settings: { role: '  spread   out  ', kin: 'Bad Name' } });
    const entry = repoEntry(await readManifest(workspaceManifestPath('normal')), 'server');
    expect(entry?.role).toBe('spread out');
    expect(entry?.kin).toBeUndefined();
  });
});
