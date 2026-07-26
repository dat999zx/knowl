import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getConfigRoot, initDb, initDbPath } from '../../src/store/database.js';

const ROOT = path.resolve('./.knowl-embedding-root-test');
// Nested two deep on purpose. The derivation being guarded against is
// dirname(dirname(dbPath)); at one level down that coincidentally equals ROOT, so a
// shallower fixture would pass whether or not the bug were fixed.
const ELSEWHERE = path.join(ROOT, 'workspaces', 'shared');

describe('config root travels with the connection', () => {
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await fs.mkdir(ELSEWHERE, { recursive: true });
    await fs.mkdir(path.join(ELSEWHERE, '.knowl'), { recursive: true });
  });
  afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('uses the project root for a normal project database', async () => {
    await initDb(ROOT);
    expect(getConfigRoot()).toBe(path.resolve(ROOT));
    await closeDb();
  });

  it('uses an explicitly supplied config root for a database outside the .knowl layout', async () => {
    await initDbPath(path.join(ELSEWHERE, 'shared.db'), { configRoot: ROOT });
    expect(getConfigRoot()).toBe(path.resolve(ROOT));
    await closeDb();
  });

  it('does not fall back to dirname(dirname(dbPath)) when a config root is supplied', async () => {
    const dbPath = path.join(ELSEWHERE, 'shared.db');
    const derived = path.dirname(path.dirname(path.resolve(dbPath)));
    expect(derived).not.toBe(path.resolve(ROOT)); // the fixture must actually distinguish them

    await initDbPath(dbPath, { configRoot: ROOT });
    expect(getConfigRoot()).toBe(path.resolve(ROOT));
    expect(getConfigRoot()).not.toBe(derived);
    await closeDb();
  });

  it('still derives a root when none is supplied, so existing callers are unaffected', async () => {
    await initDbPath(path.join(ROOT, '.knowl', 'knowl.db'));
    expect(getConfigRoot()).toBe(path.resolve(ROOT));
    await closeDb();
  });

  it('restores the previous config root after a namespace swap', async () => {
    const { withDbPath } = await import('../../src/store/database.js');
    await initDb(ROOT);
    await withDbPath(path.join(ELSEWHERE, 'other.db'), async () => {
      expect(getConfigRoot()).toBe(path.resolve(ROOT));
    });
    expect(getConfigRoot()).toBe(path.resolve(ROOT));
    await closeDb();
  });
});
