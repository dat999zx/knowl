import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveWorkspace } from '../../src/workspace/resolve.js';
import { createManifest, readManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { joinWorkspace } from '../../src/workspace/membership.js';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../../src/core/config.js';
import { resolveStorage } from '../../src/store/storage-roles.js';
import { closeDb } from '../../src/store/database.js';
import { configuredNamespaces } from '../../src/store/namespaces.js';

const HOME = path.resolve('./.knowl-resolve-home');
const A = path.resolve('./.knowl-resolve-a');
const B = path.resolve('./.knowl-resolve-b');

async function makeRepo(root: string) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
}

describe('resolveWorkspace', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await makeRepo(A);
    await makeRepo(B);
    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));
  });
  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('returns null for an unlinked repo, so callers can behave exactly as before', async () => {
    expect(await resolveWorkspace(A)).toBeNull();
  });

  it('names this repo and lists the others as peers', async () => {
    await joinWorkspace({ projectRoot: A, workspaceName: 'ws', repoName: 'a' });
    await joinWorkspace({ projectRoot: B, workspaceName: 'ws', repoName: 'b' });

    const active = await resolveWorkspace(A);
    expect(active!.repo).toBe('a');
    expect(active!.peers.map(peer => peer.name)).toEqual(['b']);
    expect(active!.peers[0].databasePath).toBe(resolveStorage(B).knowledge);
    expect(active!.peers[0].present).toBe(true);
  });

  it('marks a peer missing from this machine rather than failing', async () => {
    await joinWorkspace({ projectRoot: A, workspaceName: 'ws', repoName: 'a' });

    // Point the manifest at a path that was never checked out here, rather than deleting a
    // directory: on Windows the removal can be refused while libSQL still holds the WAL
    // sidecars, which would make this assert filesystem timing instead of the behavior.
    const manifest = await readManifest(workspaceManifestPath('ws'));
    manifest.repos.push({ name: 'b', path: path.resolve('./.knowl-resolve-never-cloned') });
    await writeManifest(workspaceManifestPath('ws'), manifest);

    const active = await resolveWorkspace(A);
    // A partial checkout is normal. Two of five repos on a laptop must keep working.
    expect(active!.peers.map(peer => peer.name)).toEqual(['b']);
    expect(active!.peers[0].present).toBe(false);
  });

  it('returns null when only one side of membership agrees', async () => {
    await saveConfig(A, { ...DEFAULT_CONFIG, workspace: { workspace: 'ws', repo: 'a' } });
    expect(await resolveWorkspace(A)).toBeNull();
  });

  it('returns null rather than throwing when the manifest is gone', async () => {
    await joinWorkspace({ projectRoot: A, workspaceName: 'ws', repoName: 'a' });
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
    // A missing manifest degrades to single-repo behavior; it must not break the repo.
    expect(await resolveWorkspace(A)).toBeNull();
  });

  it('keeps peers out of the namespace list, so implicit reads cannot fan out', async () => {
    await joinWorkspace({ projectRoot: A, workspaceName: 'ws', repoName: 'a' });
    await joinWorkspace({ projectRoot: B, workspaceName: 'ws', repoName: 'b' });

    // The structural guarantee behind v1: federation is reachable only through
    // queryFederated. If a peer reached configuredNamespaces, composeContext would inject
    // another repo's knowledge into auto-assembled context without anyone asking.
    const descriptors = configuredNamespaces(A, await loadConfig(A));
    expect(descriptors.map(entry => entry.databasePath)).not.toContain(resolveStorage(B).knowledge);
  });
});
