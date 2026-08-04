import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const opens = vi.hoisted(() => ({ count: 0 }));

// Counts what an open actually costs. `bootstrapSchema` runs on every writable open and
// includes migrateLegacyProjectSchema, so "how many times did we open a database" is the
// number this defect is about -- not a proxy for it.
vi.mock('../../src/store/bootstrap.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/store/bootstrap.js')>();
  return {
    ...actual,
    bootstrapSchema: async (client: any, options?: any) => {
      opens.count += 1;
      return actual.bootstrapSchema(client, options);
    },
  };
});

import { closeDb, getClient, initDb, withDbPath } from '../../src/store/database.js';
import { poolSize, releaseAll } from '../../src/store/connection-pool.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

const ROOT = path.resolve('./.knowl-namespace-hop-test');
const NAMESPACE = path.join(ROOT, '.knowl', 'session.db');

describe('a namespace hop does not defeat the connection pool', () => {
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await saveConfig(ROOT, {
      ...DEFAULT_CONFIG,
      search: { vector: { ...DEFAULT_CONFIG.search?.vector, enabled: false } },
    });
  });

  afterAll(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('leaves the project connection open, and opens the namespace database once', async () => {
    // `withDbPath` called `closeDb`, which releases the WHOLE pool and WAL-checkpoints every
    // writable client in it. So a hop to the session store closed and reopened the project
    // database as well -- twice per hop, bootstrap and checkpoint included -- and the pool
    // that exists to stop exactly that was empty again by the time the hop returned. A layered
    // query walks every namespace, and the MCP server that runs it is long-lived.
    await initDb(ROOT);
    const project = getClient();
    opens.count = 0;

    await withDbPath(NAMESPACE, async () => {
      expect(getClient()).not.toBe(project);
    });

    // The identity is the assertion: a reopened connection would be a different object.
    expect(getClient()).toBe(project);
    expect(opens.count).toBe(1);
    expect(poolSize()).toBe(2);
  });

  it('opens nothing at all on a second hop to the same namespace', async () => {
    opens.count = 0;
    await withDbPath(NAMESPACE, async () => {});
    await withDbPath(NAMESPACE, async () => {});
    expect(opens.count).toBe(0);
  });

  it('still restores the previous handle when the body throws', async () => {
    const project = getClient();
    await expect(withDbPath(NAMESPACE, async () => { throw new Error('body failed'); }))
      .rejects.toThrow('body failed');
    expect(getClient()).toBe(project);
  });

  it('does not leave a handle open when nothing was open before the hop', async () => {
    await closeDb();
    await releaseAll();
    opens.count = 0;

    await withDbPath(NAMESPACE, async () => { expect(getClient()).toBeDefined(); });

    expect(() => getClient()).toThrow(/not been initialized/);
    expect(poolSize()).toBe(0);
  });
});
