import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertNameAvailable, createManifest, isValidRepoName, readManifest, writeManifest,
} from '../../src/workspace/manifest.js';
import { knowlHome, workspaceDir, workspaceManifestPath } from '../../src/workspace/paths.js';

const HOME = path.resolve('./.knowl-manifest-test-home');

describe('workspace paths', () => {
  beforeAll(async () => { await fs.rm(HOME, { recursive: true, force: true }); });
  afterAll(async () => { delete process.env.KNOWL_HOME; await fs.rm(HOME, { recursive: true, force: true }).catch(() => {}); });

  it('defaults to ~/.knowl and honours KNOWL_HOME', () => {
    delete process.env.KNOWL_HOME;
    expect(knowlHome()).toBe(path.join(os.homedir(), '.knowl'));
    process.env.KNOWL_HOME = HOME;
    expect(knowlHome()).toBe(path.resolve(HOME));
  });

  it('places a workspace under workspaces/<name>', () => {
    process.env.KNOWL_HOME = HOME;
    expect(workspaceDir('duckprep')).toBe(path.join(path.resolve(HOME), 'workspaces', 'duckprep'));
    expect(workspaceManifestPath('duckprep')).toBe(path.join(path.resolve(HOME), 'workspaces', 'duckprep', 'workspace.json'));
  });
});

describe('repo names', () => {
  it('accepts lowercase, digits and hyphens', () => {
    expect(isValidRepoName('server')).toBe(true);
    expect(isValidRepoName('duckprep-web-2')).toBe(true);
  });

  it('rejects anything that could be mistaken for a path or a flag', () => {
    for (const bad of ['', '-leading', 'Upper', 'has space', 'has/slash', '..', 'has.dot', 'has_underscore']) {
      expect(isValidRepoName(bad)).toBe(false);
    }
  });
});

describe('manifest', () => {
  beforeAll(async () => { process.env.KNOWL_HOME = HOME; await fs.rm(HOME, { recursive: true, force: true }); });
  afterAll(async () => { delete process.env.KNOWL_HOME; await fs.rm(HOME, { recursive: true, force: true }).catch(() => {}); });

  it('round-trips through disk', async () => {
    const manifest = createManifest('duckprep', { provider: 'local', model: 'm', dtype: 'q8' });
    manifest.repos.push({ name: 'server', path: 'D:/coding/server' });
    const target = workspaceManifestPath('duckprep');
    await writeManifest(target, manifest);
    const loaded = await readManifest(target);
    expect(loaded.name).toBe('duckprep');
    expect(loaded.repos[0].name).toBe('server');
    expect(loaded.embedding).toEqual({ provider: 'local', model: 'm', dtype: 'q8' });
  });

  it('records the client version that wrote it, so an older build can refuse', () => {
    expect(createManifest('versioned', null).minKnowlVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('defaults to linked mode', () => {
    expect(createManifest('modes', null).mode).toBe('linked');
  });

  it('rejects a duplicate repo name', () => {
    const manifest = createManifest('dup', null);
    manifest.repos.push({ name: 'server' });
    expect(() => assertNameAvailable(manifest, 'server')).toThrow(/already/i);
  });

  it('rejects a retired repo name, so re-adding cannot adopt orphaned knowledge', () => {
    const manifest = createManifest('retired', null);
    manifest.retiredNames.push('server');
    expect(() => assertNameAvailable(manifest, 'server')).toThrow(/retired/i);
  });

  it('allows a retired name when the caller has established the same repo is reclaiming it', () => {
    const manifest = createManifest('retired', null);
    manifest.retiredNames.push('server');
    expect(() => assertNameAvailable(manifest, 'server', { allowRetired: true })).not.toThrow();
    // A name already in use is still refused: reclaiming cannot displace a live member.
    manifest.repos.push({ name: 'server' });
    expect(() => assertNameAvailable(manifest, 'server', { allowRetired: true })).toThrow(/already/i);
  });

  it('rejects an invalid name before it can reach a manifest', () => {
    expect(() => assertNameAvailable(createManifest('x', null), 'Bad Name')).toThrow(/lowercase/i);
  });

  it('tolerates a manifest written before repos or retiredNames existed', async () => {
    const target = workspaceManifestPath('legacy');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify({ version: 1, name: 'legacy', minKnowlVersion: '2.4.0', embedding: null }), 'utf8');
    const loaded = await readManifest(target);
    expect(loaded.repos).toEqual([]);
    expect(loaded.retiredNames).toEqual([]);
    expect(loaded.mode).toBe('linked');
  });
});
