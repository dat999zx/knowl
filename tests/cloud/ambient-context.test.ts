import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { withTeamStore } from '../../src/cloud/team-store.js';
import { writeSyncState } from '../../src/cloud/sync-state.js';
import { teamUpdateNotice } from '../../src/cloud/team-update.js';

const HOME = path.resolve('./.knowl-ambient-home');
const ROOT = path.resolve('./.knowl-ambient-root');
const WS = 'ws-ambient';

/** The project's own database, read through whatever context is currently active. */
const localItemCount = async (): Promise<number> =>
  Number((await getClient().execute('SELECT COUNT(*) AS n FROM knowledge_items')).rows[0].n);

describe('the replica never disturbs the caller\'s database context', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    for (const dir of [HOME, ROOT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await fs.writeFile(path.join(ROOT, '.knowl', 'config.json'), JSON.stringify({ version: 1 }), 'utf8');
  });
  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb().catch(() => {});
    for (const dir of [HOME, ROOT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('leaves a global context usable after opening the replica', async () => {
    // The MCP server calls `initDb` ONCE at startup and every later tool call reads that global
    // context. A replica helper that closed it would not fail here -- it would fail on the next
    // tool call, in a different request, with "database not initialized" and nothing pointing
    // back to the query that did it.
    await initDb(ROOT);
    try {
      expect(await localItemCount()).toBe(0);

      await withTeamStore(WS, ROOT, async () => {
        await writeSyncState({
          apiHost: 'https://api.knowl.test', since: '7', cursor: null,
          lastSyncedAt: '2026-08-09T12:00:00.000Z', lastError: null,
        });
      });

      // The assertion that matters: the caller's database still answers.
      expect(await localItemCount()).toBe(0);
    } finally {
      await closeDb();
    }
  });

  it('reads the replica from inside a live context without stealing it', async () => {
    // `teamUpdateNotice` is called while `knowl_query` is assembling its response, with the
    // project database still ambient and more work to do after it returns.
    await withTeamStore(WS, ROOT, () => writeSyncState({
      apiHost: 'https://api.knowl.test', since: '7', cursor: null,
      lastSyncedAt: '2026-08-09T12:00:00.000Z', lastError: null,
    }));

    await initDb(ROOT);
    try {
      const update = await teamUpdateNotice({ workspaceId: WS, configRoot: ROOT, seenSeq: null });

      expect(update?.seq).toBe('7');
      expect(await localItemCount()).toBe(0);
    } finally {
      await closeDb();
    }
  });
});
