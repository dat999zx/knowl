import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitArgs } from '../git-identity.js';
import type { CloudApi } from '../../src/cloud/api-client.js';
import type { UpdateItemBody } from '../../src/cloud/sync-contract.js';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import { listPushed, publishedVersion, recordPushed, stageForPublish } from '../../src/cloud/ledger.js';
import { retractItem } from '../../src/cloud/retract.js';
import { writeSyncState } from '../../src/cloud/sync-state.js';
import { withTeamStore } from '../../src/cloud/team-store.js';
import { writeCredential, clearCredential } from '../../src/cloud/credentials.js';
import type { ProjectConfig } from '../../src/core/types.js';

const API_HOST = 'https://api.retract.test';
const HOME = path.resolve('./.knowl-retract-home');

// Identity on every invocation, never `git config` -- see `tests/git-identity.ts`.
const git = (cwd: string, args: string[]) => spawnSync('git', gitArgs(args), { cwd, encoding: 'utf8' });

// Fresh directories per test, for the Windows reason `publish-push.test.ts` documents: libSQL can
// hold the database inside the clone, the `rm` is refused, and the next clone fails into a
// directory still holding the previous test's branch.
let run = 0;
let ORIGIN: string;
let CLONE: string;
let WS: string;
let connected: ProjectConfig;

const published = 'atom-published';

function capture(
  onSend?: (body: UpdateItemBody) => void,
  outcome: unknown = { status: 'deleted', id: published },
): CloudApi {
  return {
    startDeviceAuthorization: async () => { throw new Error('unused'); },
    pollForToken: async () => 'pending' as const,
    refresh: async () => { throw new Error('unused'); },
    listWorkspaces: async () => [],
    fetchSyncPage: async () => { throw new Error('unused'); },
    publishItems: async () => { throw new Error('unused'); },
    updateItem: async (input: any) => { onSend?.(input.body); return { outcome }; },
  } as unknown as CloudApi;
}

describe('retracting a published atom', () => {
  let base: { projectRoot: string; config: ProjectConfig };

  beforeEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll();
    process.env.KNOWL_HOME = HOME;
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});

    run += 1;
    ORIGIN = path.resolve(`./.knowl-retract-origin-${run}`);
    CLONE = path.resolve(`./.knowl-retract-clone-${run}`);
    WS = `ws-retract-${run}`;
    connected = {
      version: 1,
      cloud: {
        apiHost: API_HOST, workspaceId: WS, workspaceName: 'Acme',
        repo: 'github.com/acme/web', remote: 'origin',
      },
    };
    base = { projectRoot: CLONE, config: connected };

    await fs.mkdir(ORIGIN, { recursive: true });
    git(ORIGIN, ['init', '-q', '-b', 'main']);
    await fs.writeFile(path.join(ORIGIN, 'a.txt'), 'a', 'utf8');
    git(ORIGIN, ['add', '.']);
    git(ORIGIN, ['commit', '-qm', 'a']);
    git(process.cwd(), ['clone', '-q', ORIGIN, CLONE]);

    await fs.mkdir(path.join(CLONE, '.knowl'), { recursive: true });
    await fs.writeFile(path.join(CLONE, '.knowl', 'config.json'), JSON.stringify({ version: 1 }), 'utf8');
    await initDb(CLONE);
    await getClient().execute('DELETE FROM cloud_published');
    await stageForPublish([published], WS, 'main');
    await recordPushed(published, WS, 3);
    await closeDb();

    await writeCredential(API_HOST, {
      accessToken: 'at', refreshToken: 'rt', sessionId: 'sess-1',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
  });

  afterEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll();
    await clearCredential(API_HOST).catch(() => {});
    delete process.env.KNOWL_HOME;
    for (const dir of [ORIGIN, CLONE, HOME]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('refuses an atom this machine never pushed', async () => {
    // No server-side row exists, so the request would be about nothing. Checked before the token,
    // so the user is never sent to log in for a remedy that could not help.
    expect(await retractItem({ ...base, itemId: 'never-published', reason: 'leak', api: capture() }))
      .toEqual({ status: 'not-published' });
  });

  it('refuses an atom that was staged but never pushed', async () => {
    await initDb(CLONE);
    await stageForPublish(['staged-only'], WS, 'main');
    await closeDb();

    expect(await retractItem({ ...base, itemId: 'staged-only', reason: 'leak', api: capture() }))
      .toEqual({ status: 'not-published' });
  });

  // The reason this command exists, and the one behaviour that must differ from `reportDrift`.
  it('works from a feature branch, unlike every other upward path', async () => {
    // A leaked name sits in the shared workspace right now. Telling the user to switch branches
    // and pull would hold the leak open for the length of a rebase.
    git(CLONE, ['checkout', '-qb', 'feature/whatever']);

    expect(await retractItem({ ...base, itemId: published, reason: 'leaked a customer name', api: capture() }))
      .toEqual({ status: 'retracted' });
  });

  it('works from a checkout behind its remote', async () => {
    // Same reasoning: being behind makes a *claim* about code untrustworthy, and makes a removal
    // no less correct.
    await fs.writeFile(path.join(ORIGIN, 'b.txt'), 'b', 'utf8');
    git(ORIGIN, ['add', '.']);
    git(ORIGIN, ['commit', '-qm', 'b']);
    git(CLONE, ['fetch', '-q']);

    expect(await retractItem({ ...base, itemId: published, reason: 'leak', api: capture() }))
      .toEqual({ status: 'retracted' });
  });

  it('sends the delete op with the ledger version and the reason', async () => {
    let sent: UpdateItemBody | undefined;
    await retractItem({ ...base, itemId: published, reason: 'leaked a token', api: capture(body => { sent = body; }) });

    // `expectedVersion` is what THIS machine last put there, not a fetched value: a mismatch is
    // precisely the signal that someone edited the atom after this machine published it.
    expect(sent).toEqual({ op: 'delete', expectedVersion: 3, reason: 'leaked a token' });
  });

  it('clears the local version on success, so a later republish cannot send a stale one', async () => {
    expect(await retractItem({ ...base, itemId: published, reason: 'leak', api: capture() }))
      .toEqual({ status: 'retracted' });

    await initDb(CLONE);
    try {
      // Null, not 3. The server row is gone; holding its old version would make the next
      // `knowl publish --id` send an expectedVersion for something that no longer exists.
      expect(await publishedVersion(published, WS)).toBeNull();
      // The row survives so status can still say this machine published it once.
      expect((await listPushed(WS)).map(record => record.itemId)).toContain(published);
    } finally {
      await closeDb();
    }
  });

  it('surfaces a conflict and leaves the ledger untouched', async () => {
    // The atom moved after this machine published it. Deleting it now would destroy an edit
    // nobody here has read, which is the whole reason the server demands a version.
    const conflicting = capture(undefined, { status: 'conflict', id: published, currentVersion: 9 });

    expect(await retractItem({ ...base, itemId: published, reason: 'leak', api: conflicting }))
      .toEqual({ status: 'conflict', currentVersion: 9 });

    await initDb(CLONE);
    try {
      // Still 3: the local record continues to match what is actually on the server.
      expect(await publishedVersion(published, WS)).toBe(3);
    } finally {
      await closeDb();
    }
  });

  it('treats a vanished atom as a conflict rather than a success', async () => {
    // The server reports a missing atom as `conflict` with `currentVersion: 0`. Reporting that as
    // "retracted" would tell the user their leak was removed by a call that removed nothing.
    const gone = capture(undefined, { status: 'conflict', id: published, currentVersion: 0 });

    expect(await retractItem({ ...base, itemId: published, reason: 'leak', api: gone }))
      .toEqual({ status: 'conflict', currentVersion: 0 });
  });

  it('refuses a reader before spending a request that could only 403', async () => {
    await withTeamStore(WS, CLONE, () => writeSyncState({
      apiHost: API_HOST, since: '1', cursor: null,
      lastSyncedAt: new Date().toISOString(), lastError: null, role: 'reader',
    }));

    expect(await retractItem({ ...base, itemId: published, reason: 'leak', api: capture() }))
      .toEqual({ status: 'forbidden', role: 'reader' });
  });

  it('lets an editor through, and a replica with no recorded role', async () => {
    // Unknown is not denied: a replica synced by a build older than the `role` column must not
    // block a legitimate editor over a column that had not been invented yet.
    expect(await retractItem({ ...base, itemId: published, reason: 'leak', api: capture() }))
      .toEqual({ status: 'retracted' });
  });
});
