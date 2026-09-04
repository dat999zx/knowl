import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../../src/core/config.js';
import { setGlobalNamespace } from '../../src/core/config.js';
import { globalStorePath } from '../../src/core/paths.js';
import { configuredNamespaces } from '../../src/store/namespaces.js';

let testCount = 0;

describe('linking a project to the global store', () => {
  const saved = process.env.KNOWL_HOME;
  let HOME = '';
  let PROJECT = '';

  beforeEach(async () => {
    const id = testCount++;
    HOME = path.join(os.tmpdir(), `knowl-link-home-${id}`);
    PROJECT = path.join(os.tmpdir(), `knowl-link-project-${id}`);
    process.env.KNOWL_HOME = HOME;
    await closeDb().catch(() => {});
    await releaseAll().catch(() => {});
    for (const dir of [HOME, PROJECT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(PROJECT, '.knowl'), { recursive: true });
    await saveConfig(PROJECT, { ...DEFAULT_CONFIG });
  });
  afterEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll().catch(() => {});
    for (const dir of [HOME, PROJECT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    if (saved === undefined) delete process.env.KNOWL_HOME; else process.env.KNOWL_HOME = saved;
  });

  it('adds the namespace on link and removes it on unlink', async () => {
    expect(configuredNamespaces(PROJECT, await loadConfig(PROJECT)).map(d => d.namespace)).not.toContain('global');

    await setGlobalNamespace(PROJECT, true);
    const linked = await loadConfig(PROJECT);
    expect(linked.memory?.global).toEqual({ enabled: true, path: globalStorePath() });
    expect(configuredNamespaces(PROJECT, linked).map(d => d.namespace)).toContain('global');
    // Linking creates the store, so the very next query has something to read.
    await expect(fs.access(globalStorePath())).resolves.toBeUndefined();

    await setGlobalNamespace(PROJECT, false);
    const unlinked = await loadConfig(PROJECT);
    expect(unlinked.memory?.global?.enabled).toBe(false);
    expect(configuredNamespaces(PROJECT, unlinked).map(d => d.namespace)).not.toContain('global');
    // Unlinking is reversible and never destroys the store.
    await expect(fs.access(globalStorePath())).resolves.toBeUndefined();
  });
});
