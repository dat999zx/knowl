import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../src/store/database.js';
import { ensureGlobalStore, upgradeExistingGlobalStore } from '../../src/store/global-store.js';
import { globalStorePath } from '../../src/core/paths.js';

// A fresh HOME per test: on Windows `closeDb` cannot always unlock global.db, so a shared one would
// leave the previous test's store behind and invert the "does not exist" assertion.
let counter = 0;
let HOME = '';

describe('upgradeExistingGlobalStore (what init --all runs)', () => {
  beforeEach(async () => {
    counter += 1;
    HOME = path.resolve(`./.knowl-upgrade-global-home-${counter}`);
    process.env.KNOWL_HOME = HOME;
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
  });

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb().catch(() => {});
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
  });

  it('creates nothing when there is no global store, so a sweep never starts one', async () => {
    expect(await upgradeExistingGlobalStore()).toBe(false);
    await expect(fs.access(globalStorePath())).rejects.toThrow();
    await expect(fs.access(HOME)).rejects.toThrow();
  });

  it('opens a store that already exists and reports it', async () => {
    await ensureGlobalStore();
    expect(await upgradeExistingGlobalStore()).toBe(true);
    await expect(fs.access(globalStorePath())).resolves.toBeUndefined();
  });
});
