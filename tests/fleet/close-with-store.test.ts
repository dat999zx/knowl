import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { fleetDbPath, openFleetDb, touchFleetSession } from '../../src/fleet/store.js';

/**
 * `closeDb` shuts the store down, and the fleet database is part of the store.
 *
 * It was not. `openFleetDb` caches its libSQL client in a module map that exactly one call site
 * drains (`knowl fleet`), while `closeDb` released only the knowledge pool -- so every hook
 * process that touched the fleet (`agent-reminder` on the prompt event, `agent-hook` on tool
 * events) exited holding a live native handle, left for process teardown to reclaim rather than
 * closed. Those are the two commands that run most often and are killed the instant they finish.
 *
 * Asserted through the client's own behaviour rather than through the module map, because the
 * map is private and a test that reached into it would pass against a `close()` that never ran:
 * a closed libSQL client rejects the next statement, an open one answers it.
 */

const HOME = path.join(os.tmpdir(), `knowl-fleet-close-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const ROOT = path.join(HOME, 'project');

describe('closeDb closes the fleet database too', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    await repo.createProject(ROOT, 'fleet-close');
  });

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb().catch(() => {});
    await releaseAll().catch(() => {});
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
  });

  it('leaves no usable fleet client behind', async () => {
    await touchFleetSession({ host: 'claude', sessionId: 's1', projectRoot: ROOT, repo: 'fleet-close' });
    const client = await openFleetDb();
    // Open: it answers.
    await expect(client.execute('SELECT 1')).resolves.toBeTruthy();

    await closeDb();

    // Closed: the same client refuses. Against the unfixed code this resolves, because nothing
    // on any hook path ever called `closeFleetDb`.
    await expect(client.execute('SELECT 1')).rejects.toThrow();
  });

  it('is idempotent, and safe when the fleet was never opened', async () => {
    // The ordinary case: most commands never touch the fleet at all, and closing twice is what
    // an error path does after a successful close.
    await expect(closeDb()).resolves.toBeUndefined();
    await expect(closeDb()).resolves.toBeUndefined();
  });

  it('hands the next caller a working client rather than the closed one', async () => {
    await touchFleetSession({ host: 'claude', sessionId: 's2', projectRoot: ROOT, repo: 'fleet-close' });
    await closeDb();

    // The cache was cleared, not poisoned: a later open in the same process reconnects.
    await initDb(ROOT);
    const reopened = await openFleetDb();
    await expect(reopened.execute('SELECT 1')).resolves.toBeTruthy();
    expect(fleetDbPath().startsWith(HOME)).toBe(true);
  });
});
