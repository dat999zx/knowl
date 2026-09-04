import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import { globalStorePath } from '../../src/core/paths.js';
import { ensureGlobalStore } from '../../src/store/global-store.js';
import { globalOnlyNamespaces } from '../../src/store/namespaces.js';

let testCount = 0;

describe('the global store', () => {
  const saved = process.env.KNOWL_HOME;
  let HOME = '';
  beforeEach(async () => {
    HOME = path.join(os.tmpdir(), `knowl-global-home-${testCount++}`);
    process.env.KNOWL_HOME = HOME;
    await closeDb().catch(() => {});
    await releaseAll().catch(() => {});
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
  });
  afterEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll().catch(() => {});
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
    if (saved === undefined) delete process.env.KNOWL_HOME; else process.env.KNOWL_HOME = saved;
  });

  it('lives beside the machine home rather than being a project at it', () => {
    // `knowl init` at ~ would put a project store at ~/.knowl/knowl.db, on top of models/,
    // cache/, repos.json and credentials.json. Its own file, not its own project.
    expect(globalStorePath()).toBe(path.join(HOME, 'global.db'));
    expect(path.basename(globalStorePath())).not.toBe('knowl.db');
  });

  it('creates the database once and reports it as present afterwards', async () => {
    const first = await ensureGlobalStore();
    expect(first.created).toBe(true);
    await expect(fs.access(first.path)).resolves.toBeUndefined();

    const second = await ensureGlobalStore();
    expect(second.created).toBe(false);
    expect(second.path).toBe(first.path);
  });

  describe('resolution with no project', () => {
    it('is empty before the store exists, and global-only after', async () => {
      expect(globalOnlyNamespaces()).toEqual([]);
      await ensureGlobalStore();
      const namespaces = globalOnlyNamespaces();
      expect(namespaces).toHaveLength(1);
      expect(namespaces[0].namespace).toBe('global');
      expect(namespaces[0].databasePath).toBe(globalStorePath());
      // Optional everywhere else; here it is the only store, so a failure to open is a real error.
      expect(namespaces[0].optional).toBeFalsy();
    });
  });
});
