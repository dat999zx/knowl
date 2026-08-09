import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTeamStore } from '../../src/cloud/team-store.js';
import { readSyncState, writeSyncState } from '../../src/cloud/sync-state.js';

const HOME = path.resolve('./.knowl-sync-state-home');
const ROOT = path.resolve('./.knowl-sync-state-root');

const wipe = (dir: string) =>
  fs.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 }).catch(() => {});

/** A replica per test: a libSQL file cannot be removed and recreated in one process. */
const inStore = <T>(id: string, run: () => Promise<T>) => withTeamStore(`ws-${id}`, ROOT, run);

describe('sync state', () => {
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

  it('reports no state before the first sync', async () => {
    expect(await inStore('empty', () => readSyncState())).toBeNull();
  });

  it('round-trips a watermark', async () => {
    await inStore('roundtrip', () => writeSyncState({
      apiHost: 'https://api.knowl.dev',
      since: '42',
      cursor: null,
      lastSyncedAt: '2026-08-09T12:00:00.000Z',
      lastError: null,
      role: 'editor',
    }));

    expect(await inStore('roundtrip', () => readSyncState())).toEqual({
      apiHost: 'https://api.knowl.dev',
      since: '42',
      cursor: null,
      lastSyncedAt: '2026-08-09T12:00:00.000Z',
      lastError: null,
      role: 'editor',
    });
  });

  it('reads a role the write never mentioned as unknown, not as permission', async () => {
    // A replica synced by a build older than the column has no role recorded. Unknown is not
    // denied -- the push proceeds and lets the server decide -- but it must not read as a role.
    await inStore('no-role', () => writeSyncState({
      apiHost: 'https://a', since: '1', cursor: null, lastSyncedAt: null, lastError: null,
    } as never));

    expect((await inStore('no-role', () => readSyncState()))?.role).toBeNull();
  });

  it('keeps `since` a string, so a bigint above 2^53 survives the round trip', async () => {
    // 9007199254740993 is 2^53 + 1: the first integer a JS number cannot represent. Stored as
    // a number it comes back as ...992, and a watermark one short skips a commit forever.
    const huge = '9007199254740993';
    await inStore('bigint', () => writeSyncState({
      apiHost: 'https://api.knowl.dev',
      since: huge,
      cursor: null,
      lastSyncedAt: null,
      lastError: null,
    }));

    const state = await inStore('bigint', () => readSyncState());
    expect(state?.since).toBe(huge);
    expect(typeof state?.since).toBe('string');
  });

  it('overwrites rather than accumulating rows', async () => {
    const base = { apiHost: 'https://a', cursor: null, lastSyncedAt: null, lastError: null };
    await inStore('overwrite', () => writeSyncState({ ...base, since: '1' }));
    await inStore('overwrite', () => writeSyncState({ ...base, since: '2' }));

    expect((await inStore('overwrite', () => readSyncState()))?.since).toBe('2');
  });

  it('carries a mid-traversal cursor and an error string', async () => {
    await inStore('cursor', () => writeSyncState({
      apiHost: 'https://a',
      since: '10',
      cursor: 'eyJzZXEiOiIxMSJ9',
      lastSyncedAt: '2026-08-09T12:00:00.000Z',
      lastError: 'network down',
    }));

    const state = await inStore('cursor', () => readSyncState());
    expect(state?.cursor).toBe('eyJzZXEiOiIxMSJ9');
    expect(state?.lastError).toBe('network down');
  });
});
