import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, getConfigRoot, getProjectRoot, initDb, openProjectScope, withProjectScope } from '../../src/store/database.js';
import { poolSize, releaseAll } from '../../src/store/connection-pool.js';
import { createKnowledgeItem } from '../../src/store/repository.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

// A fresh pair per test rather than one pair cleaned between them. Windows holds the `-shm` and
// `-wal` sidecars after close, so the `rm` that is supposed to reset a shared fixture routinely
// fails and is swallowed -- and every assertion here is about which rows are in which FILE, so
// a fixture carrying the previous test's rows fails for a reason that has nothing to do with the
// code. `.knowl-` prefixed, so global teardown sweeps them.
let FIRST = '';
let SECOND = '';
let counter = 0;

const dbOf = (root: string) => path.join(root, '.knowl', 'knowl.db');

async function makeRepo(root: string) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, {
    ...DEFAULT_CONFIG,
    search: { vector: { ...DEFAULT_CONFIG.search?.vector, enabled: false } },
  });
}

/**
 * The titles in one project's database file, read through a connection of this test's own.
 *
 * Deliberately not `getDb()` or the pool: the thing under test is which FILE a write reached,
 * and asking the same layer that chose the file would assert nothing.
 */
async function titlesIn(root: string): Promise<string[]> {
  const client = createClient({ url: `file:${dbOf(root)}` });
  try {
    const result = await client.execute('SELECT title FROM knowledge_items ORDER BY title');
    return result.rows.map(row => String(row.title));
  } finally {
    client.close();
  }
}

describe('two projects open in one process', () => {
  beforeEach(async () => {
    await closeDb();
    await releaseAll();
    counter += 1;
    FIRST = path.resolve(`./.knowl-scoped-first-${counter}-test`);
    SECOND = path.resolve(`./.knowl-scoped-second-${counter}-test`);
    for (const dir of [FIRST, SECOND]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    for (const dir of [FIRST, SECOND]) await makeRepo(dir);
  });

  afterEach(async () => {
    await closeDb();
    await releaseAll();
    for (const dir of [FIRST, SECOND]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  // The defect this pins, reproduced on 2026-09-05: `initDb` overwrites one module-global
  // context, so opening a second project silently repointed the first one's writes. The row
  // landed in the second project's file, the first project's store stayed empty, and nothing
  // anywhere said so.
  it('writes through the first handle into the first project, not the second', async () => {
    const first = await openProjectScope(FIRST);
    const second = await openProjectScope(SECOND);

    try {
      await first.run(async () => {
        await createKnowledgeItem('project-first', {
          category: 'fact', title: 'Belongs to the first project', content: 'Written through the first handle.',
        });
      });

      expect(await titlesIn(FIRST)).toEqual(['Belongs to the first project']);
      expect(await titlesIn(SECOND)).toEqual([]);
    } finally {
      await first.release();
      await second.release();
    }
  });

  it('keeps each handle pointed at its own project, in whatever order they are used', async () => {
    const first = await openProjectScope(FIRST);
    const second = await openProjectScope(SECOND);

    try {
      // Interleaved on purpose: a handle that resolved its database once and cached it would
      // pass a test that used each one only once, in order.
      await second.run(async () => {
        await createKnowledgeItem('project-second', {
          category: 'fact', title: 'Second, written first', content: 'Written through the second handle.',
        });
      });
      await first.run(async () => {
        await createKnowledgeItem('project-first', {
          category: 'fact', title: 'First, written second', content: 'Written through the first handle.',
        });
      });

      expect(await titlesIn(FIRST)).toEqual(['First, written second']);
      expect(await titlesIn(SECOND)).toEqual(['Second, written first']);
    } finally {
      await first.release();
      await second.release();
    }
  });

  it('carries the project and config root of the handle whose body is running', async () => {
    const first = await openProjectScope(FIRST);
    const second = await openProjectScope(SECOND);

    try {
      // `resolveWriteDefaults` stamps `origin_repo` from the config root and auto-staging reads
      // it for a cloud pointer, so a handle that moved only the database would write into one
      // project and label it with another's name.
      await first.run(async () => {
        expect(getProjectRoot()).toBe(FIRST);
        expect(getConfigRoot()).toBe(FIRST);
      });
      await second.run(async () => {
        expect(getProjectRoot()).toBe(SECOND);
        expect(getConfigRoot()).toBe(SECOND);
      });
    } finally {
      await first.release();
      await second.release();
    }
  });

  // The second half of the defect: `closeDb` releases the WHOLE pool, so one consumer finishing
  // used to tear down every other open handle in the process. Reproduced as
  // `DatabaseError: Database has not been initialized. Run initDb() first.` thrown by the
  // handle that had done nothing wrong.
  it('leaves the other handle working after one of them is released', async () => {
    const first = await openProjectScope(FIRST);
    const second = await openProjectScope(SECOND);

    try {
      await first.release();

      await second.run(async () => {
        await createKnowledgeItem('project-second', {
          category: 'fact', title: 'Still open', content: 'The surviving handle still writes.',
        });
      });

      expect(await titlesIn(SECOND)).toEqual(['Still open']);
    } finally {
      await second.release();
    }
  });

  it('releases only its own database, and is safe to release twice', async () => {
    const first = await openProjectScope(FIRST);
    const second = await openProjectScope(SECOND);
    expect(poolSize()).toBe(2);

    await first.release();
    await first.release();
    expect(poolSize()).toBe(1);

    await second.release();
    expect(poolSize()).toBe(0);
  });

  it('refuses to run a body after it has been released, rather than running it somewhere else', async () => {
    const scope = await openProjectScope(FIRST);
    await scope.release();

    expect(() => scope.run(async () => {})).toThrow(/has been released/);
  });

  it('opens, runs and releases in one call', async () => {
    await withProjectScope(FIRST, async () => {
      await createKnowledgeItem('project-first', {
        category: 'fact', title: 'Through the one-shot form', content: 'Written inside withProjectScope.',
      });
    });

    expect(await titlesIn(FIRST)).toEqual(['Through the one-shot form']);
    // Stronger than an empty read: the other project's database was never even created, so the
    // scope reached exactly one file.
    expect(await fs.access(dbOf(SECOND)).then(() => true, () => false)).toBe(false);
    expect(poolSize()).toBe(0);
  });

  // Two sessions in one folder is the ordinary case for a gateway, and a refcount is the only
  // thing standing between that and one of them closing the connection the other is using.
  it('keeps the connection alive while a second handle on the same project holds it', async () => {
    const one = await openProjectScope(FIRST);
    const two = await openProjectScope(FIRST);

    try {
      await one.release();

      await two.run(async () => {
        await createKnowledgeItem('project-first', {
          category: 'fact', title: 'Shared connection', content: 'The second handle still writes.',
        });
      });

      expect(await titlesIn(FIRST)).toEqual(['Shared connection']);
    } finally {
      await two.release();
    }
  });

  // The CLI and the MCP server both call `initDb` once and then read the ambient context for the
  // rest of the process. A scope must be invisible to them, in both directions.
  it('never disturbs the process-wide context a one-shot caller depends on', async () => {
    await initDb(FIRST);
    const ambient = getClient();

    const scope = await openProjectScope(SECOND);
    try {
      await scope.run(async () => {
        expect(getClient()).not.toBe(ambient);
      });

      // The identity is the assertion: a reassigned global would be a different object here.
      expect(getClient()).toBe(ambient);
      expect(getProjectRoot()).toBe(FIRST);
    } finally {
      await scope.release();
    }

    expect(getClient()).toBe(ambient);
    await closeDb();
  });

  it('does not release a database the process-wide context is still using', async () => {
    await initDb(FIRST);
    const ambient = getClient();

    const scope = await openProjectScope(FIRST);
    await scope.run(async () => { expect(getClient()).toBe(ambient); });
    await scope.release();

    // `releaseClient` here would close the connection `initDb` handed the CLI, and the next
    // ambient statement would fail on a closed client rather than on anything the caller did.
    await getClient().execute('SELECT 1');
    await closeDb();
  });
});
