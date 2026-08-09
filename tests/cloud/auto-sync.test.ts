import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withTeamStore } from '../../src/cloud/team-store.js';
import { writeSyncState } from '../../src/cloud/sync-state.js';
import { shouldAutoSync, AUTO_SYNC_INTERVAL_MS } from '../../src/cloud/auto-sync.js';

const HOME = path.resolve('./.knowl-auto-sync-home');
const ROOT = path.resolve('./.knowl-auto-sync-root');
const WS = 'ws-auto';
const NOW = Date.parse('2026-08-09T12:00:00.000Z');

const syncedAt = (iso: string | null) => withTeamStore(WS, ROOT, () => writeSyncState({
  apiHost: 'https://api.knowl.dev', since: '1', cursor: null, lastSyncedAt: iso, lastError: null,
}));

describe('shouldAutoSync', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    for (const dir of [HOME, ROOT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await fs.writeFile(path.join(ROOT, '.knowl', 'config.json'), JSON.stringify({ version: 1 }), 'utf8');
  });
  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    for (const dir of [HOME, ROOT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('syncs when the replica has never been synced', async () => {
    await syncedAt(null);
    expect(await shouldAutoSync(WS, ROOT, () => NOW)).toBe(true);
  });

  it('does not sync again inside the interval', async () => {
    // Twenty developers times several queries a turn is a lot of requests that answer
    // "nothing new". The interval is what keeps that traffic proportionate.
    await syncedAt(new Date(NOW - AUTO_SYNC_INTERVAL_MS + 1_000).toISOString());
    expect(await shouldAutoSync(WS, ROOT, () => NOW)).toBe(false);
  });

  it('syncs once the interval has passed', async () => {
    await syncedAt(new Date(NOW - AUTO_SYNC_INTERVAL_MS - 1_000).toISOString());
    expect(await shouldAutoSync(WS, ROOT, () => NOW)).toBe(true);
  });

  it('treats an unreadable replica as due rather than as up to date', async () => {
    // "I cannot tell" must not read as "no need". The failure mode of guessing wrong here is a
    // replica that silently never syncs again.
    expect(await shouldAutoSync('ws-does-not-exist', ROOT, () => NOW)).toBe(true);
  });
});
