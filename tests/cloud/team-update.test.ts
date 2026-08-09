import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withTeamStore } from '../../src/cloud/team-store.js';
import { writeSyncState } from '../../src/cloud/sync-state.js';
import { teamUpdateNotice } from '../../src/cloud/team-update.js';

const HOME = path.resolve('./.knowl-team-update-home');
const ROOT = path.resolve('./.knowl-team-update-root');
const WS = 'ws-notice';

const setWatermark = (since: string | null) => withTeamStore(WS, ROOT, () => writeSyncState({
  apiHost: 'https://api.knowl.dev', since, cursor: null,
  lastSyncedAt: '2026-08-09T12:00:00.000Z', lastError: null,
}));

const notice = (seenSeq: string | null) =>
  teamUpdateNotice({ workspaceId: WS, configRoot: ROOT, seenSeq });

describe('teamUpdateNotice', () => {
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

  it('says nothing when the replica has not moved', async () => {
    // A notice that fires on every query is one the agent stops reading, and this one asks it
    // to consider re-querying -- so the noise is not free.
    await setWatermark('10');
    expect(await notice('10')).toBeNull();
  });

  it('says nothing before the first sync', async () => {
    // Its own workspace id, deliberately. `beforeEach` cannot guarantee a clean slate here: on
    // Windows the replica's `-shm` sidecar stays locked well after close, so the `fs.rm` above
    // silently fails and a previous test's watermark survives into this one -- the same lock
    // behaviour `dropTeamStore` documents. An id no other test touches is what makes "no sync
    // state at all" the actual precondition rather than the hoped-for one.
    expect(await teamUpdateNotice({
      workspaceId: 'ws-notice-never-synced', configRoot: ROOT, seenSeq: null,
    })).toBeNull();
  });

  it('speaks the first time a session sees a replica that already has content', async () => {
    // A session that starts after a pull has seen nothing yet. Silence here would mean the
    // agent never learns team knowledge is present at all.
    await setWatermark('10');
    const result = await notice(null);

    expect(result?.seq).toBe('10');
    expect(result?.notice).toContain('TEAM UPDATE');
  });

  it('speaks when the watermark has advanced since the session last looked', async () => {
    await setWatermark('25');
    const result = await notice('10');

    expect(result?.seq).toBe('25');
    expect(result?.notice).toContain('TEAM UPDATE');
  });

  it('compares watermarks as numbers, not as strings', async () => {
    // '9' > '10' lexicographically. Comparing as text makes the notice fire backwards for
    // every workspace that crosses a digit boundary -- and go silent afterwards.
    await setWatermark('10');
    expect(await notice('9')).not.toBeNull();

    await setWatermark('9');
    expect(await notice('10')).toBeNull();
  });

  it('handles a sequence beyond 2^53 without losing precision', async () => {
    // The watermark is a bigint by contract. `Number()` on these two gives the same value.
    await setWatermark('9007199254740993');
    expect(await notice('9007199254740992')).not.toBeNull();
  });
});
