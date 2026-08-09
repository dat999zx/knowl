import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getClient } from '../../src/store/database.js';
import { withTeamStore } from '../../src/cloud/team-store.js';
import { readSyncState } from '../../src/cloud/sync-state.js';
import { runSync } from '../../src/cloud/sync.js';
import type { CloudApi } from '../../src/cloud/api-client.js';
import type { SyncAtom, SyncPage } from '../../src/cloud/sync-contract.js';

const HOME = path.resolve('./.knowl-sync-home');
const ROOT = path.resolve('./.knowl-sync-root');
const HOST = 'https://api.knowl.dev';

const wipe = (dir: string) =>
  fs.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 }).catch(() => {});

function atom(id: string, version = 1): SyncAtom {
  return {
    id, category: 'decision', title: `Atom ${id}`, content: 'body', status: 'active',
    freshness: 'fresh', contentHash: `hash-${id}`, originRepo: 'github.com/acme/web',
    authorUserId: 'u1', supersededById: null, version, visibility: 'workspace', review: null,
    publishedAt: '2026-08-09T10:00:00.000Z', createdAt: '2026-08-09T10:00:00.000Z',
    updatedAt: '2026-08-09T10:00:00.000Z',
  };
}

/** Serves prepared pages in order and records exactly what was asked for. */
function pagingApi(pages: SyncPage[]): { api: CloudApi; asked: Array<{ since: string | null; cursor: string | null }> } {
  const asked: Array<{ since: string | null; cursor: string | null }> = [];
  const queue = [...pages];
  const api = {
    startDeviceAuthorization: async () => { throw new Error('unused'); },
    pollForToken: async () => 'pending' as const,
    refresh: async () => { throw new Error('unused'); },
    listWorkspaces: async () => [],
    fetchSyncPage: async (input: { since: string | null; cursor: string | null }) => {
      asked.push({ since: input.since, cursor: input.cursor });
      const next = queue.shift();
      if (!next) throw new Error('asked for more pages than the test prepared');
      return next;
    },
  } as unknown as CloudApi;
  return { api, asked };
}

const page = (over: Partial<SyncPage>): SyncPage => ({
  rows: [], cursor: null, nextSeq: '0', role: 'editor', resyncRequired: false, ...over,
});

const sync = (ws: string, api: CloudApi) =>
  runSync({ workspaceId: ws, apiHost: HOST, configRoot: ROOT, api, accessToken: 'token' });

const countItems = (ws: string) => withTeamStore(ws, ROOT, async () =>
  Number((await getClient().execute('SELECT COUNT(*) AS n FROM knowledge_items')).rows[0].n));

describe('runSync', () => {
  beforeAll(async () => {
    process.env.KNOWL_HOME = HOME;
    for (const dir of [HOME, ROOT]) await wipe(dir);
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await fs.writeFile(path.join(ROOT, '.knowl', 'config.json'), JSON.stringify({ version: 1 }), 'utf8');
  });
  afterAll(async () => {
    delete process.env.KNOWL_HOME;
    for (const dir of [HOME, ROOT]) await wipe(dir);
  });

  it('asks for a snapshot on the first sync, with no `since` at all', async () => {
    // An absent `since` is what selects snapshot mode. Sending `since=0` would ask for a
    // delta from a commit that never existed.
    const { api, asked } = pagingApi([page({ nextSeq: '5' })]);

    await sync('ws-first', api);

    expect(asked[0].since).toBeNull();
  });

  it('advances the watermark only when the traversal completes', async () => {
    // The load-bearing rule. `nextSeq` is constant across a traversal; committing it while a
    // cursor is still open would skip every row the later pages carried.
    const { api } = pagingApi([
      page({ rows: [{ op: 'upsert', seq: '1', item: atom('a') }], cursor: 'c1', nextSeq: '9' }),
      page({ rows: [{ op: 'upsert', seq: '2', item: atom('b') }], cursor: null, nextSeq: '9' }),
    ]);

    const result = await sync('ws-complete', api);

    expect(result.status).toBe('synced');
    const state = await withTeamStore('ws-complete', ROOT, () => readSyncState());
    expect(state?.since).toBe('9');
    expect(state?.cursor).toBeNull();
  });

  it('leaves `since` untouched and keeps the cursor when a traversal is cut short', async () => {
    const { api } = pagingApi([
      page({ rows: [{ op: 'upsert', seq: '1', item: atom('a') }], cursor: 'c1', nextSeq: '9' }),
    ]);

    const result = await runSync({
      workspaceId: 'ws-cutshort', apiHost: HOST, configRoot: ROOT, api, accessToken: 't', maxPages: 1,
    });

    expect(result.status).toBe('incomplete');
    const state = await withTeamStore('ws-cutshort', ROOT, () => readSyncState());
    expect(state?.since).toBeNull();
    expect(state?.cursor).toBe('c1');
    // The rows still landed -- applying is safe because replay is idempotent, and holding a
    // page back would mean an interrupted sync delivered nothing at all.
    expect(await countItems('ws-cutshort')).toBe(1);
  });

  it('resumes from the stored cursor rather than starting the traversal again', async () => {
    const first = pagingApi([page({ rows: [{ op: 'upsert', seq: '1', item: atom('a') }], cursor: 'c1', nextSeq: '9' })]);
    await runSync({
      workspaceId: 'ws-resume', apiHost: HOST, configRoot: ROOT, api: first.api, accessToken: 't', maxPages: 1,
    });

    const second = pagingApi([page({ cursor: null, nextSeq: '9' })]);
    await sync('ws-resume', second.api);

    expect(second.asked[0].cursor).toBe('c1');
  });

  it('wipes the replica and starts over when the server says the watermark is too old', async () => {
    // resyncRequired is not an empty page. Treating it as one would advance past commits that
    // were never delivered and leave the replica permanently short.
    const seed = pagingApi([page({ rows: [{ op: 'upsert', seq: '1', item: atom('old') }], nextSeq: '5' })]);
    await sync('ws-resync', seed.api);
    expect(await countItems('ws-resync')).toBe(1);

    const { api, asked } = pagingApi([
      page({ resyncRequired: true, nextSeq: '0' }),
      page({ rows: [{ op: 'upsert', seq: '20', item: atom('new') }], nextSeq: '20' }),
    ]);
    const result = await sync('ws-resync', api);

    expect(result.status).toBe('resynced');
    expect(asked[1].since).toBeNull();
    const ids = await withTeamStore('ws-resync', ROOT, async () =>
      (await getClient().execute('SELECT id FROM knowledge_items')).rows.map(row => String(row.id)));
    expect(ids).toEqual(['new']);
  });

  it('gives up rather than looping when the server demands a resync twice running', async () => {
    // The replica was already rebuilt from scratch, so a third attempt cannot improve it --
    // this is a server retention or sequence fault, and looping would hide it.
    const { api } = pagingApi([
      page({ resyncRequired: true, nextSeq: '0' }),
      page({ resyncRequired: true, nextSeq: '0' }),
    ]);

    await expect(sync('ws-resync-twice', api)).rejects.toThrow(/twice in a row/);
  });

  it('records the failure and leaves the watermark alone when a page throws', async () => {
    const api = {
      ...pagingApi([]).api,
      fetchSyncPage: async () => { throw new Error('network down'); },
    } as unknown as CloudApi;

    await expect(sync('ws-error', api)).rejects.toThrow('network down');

    const state = await withTeamStore('ws-error', ROOT, () => readSyncState());
    expect(state?.since).toBeNull();
    expect(state?.lastError).toContain('network down');
  });

  it('clears a stale lastError once a later sync succeeds', async () => {
    // Otherwise doctor keeps reporting a failure that has already been recovered from.
    const failing = {
      ...pagingApi([]).api,
      fetchSyncPage: async () => { throw new Error('network down'); },
    } as unknown as CloudApi;
    await expect(sync('ws-recover', failing)).rejects.toThrow('network down');

    const { api } = pagingApi([page({ nextSeq: '4' })]);
    await sync('ws-recover', api);

    const state = await withTeamStore('ws-recover', ROOT, () => readSyncState());
    expect(state?.lastError).toBeNull();
    expect(state?.since).toBe('4');
  });

  it('applies deletes so a retraction reaches the replica', async () => {
    const seed = pagingApi([page({ rows: [{ op: 'upsert', seq: '1', item: atom('a') }], nextSeq: '1' })]);
    await sync('ws-delete', seed.api);

    const { api } = pagingApi([
      page({ rows: [{ op: 'delete', seq: '2', id: 'a', deletedAt: '2026-08-09T11:00:00.000Z' }], nextSeq: '2' }),
    ]);
    const result = await sync('ws-delete', api);

    expect(result.deleted).toBe(1);
    expect(await countItems('ws-delete')).toBe(0);
  });
});
