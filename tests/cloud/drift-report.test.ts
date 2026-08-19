import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitArgs } from '../git-identity.js';
import type { CloudApi } from '../../src/cloud/api-client.js';
import type { UpdateItemBody } from '../../src/cloud/sync-contract.js';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import { recordPushed, stageForPublish } from '../../src/cloud/ledger.js';
import { reportDrift, reportReviewed } from '../../src/cloud/drift-report.js';
import { writeCredential, clearCredential } from '../../src/cloud/credentials.js';
import type { ProjectConfig } from '../../src/core/types.js';

const API_HOST = 'https://api.drift.test';

// Identity on every invocation, never `git config` -- see `tests/git-identity.ts`.
const git = (cwd: string, args: string[]) => spawnSync('git', gitArgs(args), { cwd, encoding: 'utf8' });
const headOf = (cwd: string) => git(cwd, ['rev-parse', 'HEAD']).stdout.trim();

// Fresh directories per test, for the same Windows reason `publish-push.test.ts` documents:
// libSQL can hold the database inside the clone, the `rm` is refused, and the next clone fails
// into a directory still holding the previous test's branch.
let run = 0;
let ORIGIN: string;
let CLONE: string;
let WS: string;
let connected: ProjectConfig;

const published = 'atom-published';

function capture(onSend?: (body: UpdateItemBody) => void, outcome: unknown = { status: 'updated', id: published, version: 2 }): CloudApi {
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

const conflicting = () => capture(undefined, { status: 'conflict', id: published, currentVersion: 9 });

async function commitToOrigin(name: string): Promise<void> {
  await fs.writeFile(path.join(ORIGIN, name), name, 'utf8');
  git(ORIGIN, ['add', '.']);
  git(ORIGIN, ['commit', '-qm', name]);
}

describe('reporting upward', () => {
  let base: { projectRoot: string; config: ProjectConfig };

  beforeEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll();

    run += 1;
    ORIGIN = path.resolve(`./.knowl-drift-origin-${run}`);
    CLONE = path.resolve(`./.knowl-drift-clone-${run}`);
    WS = `ws-drift-${run}`;
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
    await commitToOrigin('a.txt');
    git(process.cwd(), ['clone', '-q', ORIGIN, CLONE]);

    await fs.mkdir(path.join(CLONE, '.knowl'), { recursive: true });
    await fs.writeFile(path.join(CLONE, '.knowl', 'config.json'), JSON.stringify({ version: 1 }), 'utf8');
    await initDb(CLONE);
    await getClient().execute('DELETE FROM cloud_published');
    await stageForPublish([published], WS, 'main');
    await recordPushed(published, WS, 1, { contentHash: null, lifecycleHash: null });
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
    for (const dir of [ORIGIN, CLONE]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('refuses to report an atom this machine never published', async () => {
    // An atom absent from the ledger has no server-side counterpart, so a report about it is a
    // report about nothing -- and would 404 after spending a request to find out.
    expect(await reportDrift({ ...base, itemId: 'never-published', reason: 'gone', api: capture() }))
      .toBe('not-published');
  });

  it('refuses to report drift from a feature branch', async () => {
    // Deleting a feature locally makes the local drift check mark its atom stale -- correctly
    // for this tree, wrongly for everyone on main. Reporting it would retire knowledge that is
    // still true for every colleague.
    git(CLONE, ['checkout', '-qb', 'feature/remove-rollback']);
    expect(await reportDrift({ ...base, itemId: published, reason: 'file deleted', api: capture() }))
      .toBe('gated');
  });

  it('refuses to report drift from a checkout behind its remote', async () => {
    // The trap: three days behind, the file the team just published about is genuinely not
    // here, and "gone" is the wrong conclusion.
    await commitToOrigin('c.txt');
    git(CLONE, ['fetch', '-q']);
    expect(await reportDrift({ ...base, itemId: published, reason: 'file deleted', api: capture() }))
      .toBe('gated');
  });

  it('sends the commit it was observed at', async () => {
    // Stored, never validated -- the server has no working tree. It is what makes a bad report
    // traceable and reversible rather than anonymous and permanent.
    let body: any;
    await reportDrift({ ...base, itemId: published, reason: 'file deleted', api: capture(sent => { body = sent; }) });

    expect(body.op).toBe('needsReview');
    expect(body.reason).toBe('file deleted');
    expect(body.observedAtCommit).toBe(headOf(CLONE));
    expect(body.expectedVersion).toBeUndefined();
  });

  it('sends expectedVersion and sourceCommit when reviewing', async () => {
    // The asymmetry is the point. `needsReview` takes no version and bumps none, so a report is
    // never dropped mid-edit. `reviewed` is a positive claim about specific content, and
    // vouching for text you did not read is the failure to prevent.
    let body: any;
    await reportReviewed({ ...base, itemId: published, api: capture(sent => { body = sent; }) });

    expect(body.op).toBe('reviewed');
    expect(body.expectedVersion).toBe(1);
    expect(body.sourceCommit).toBe(headOf(CLONE));
  });

  it('refuses to review from a feature branch, the stricter of the two verbs', async () => {
    // `reviewed` clears a flag someone else raised. If anything it is the one that needs the
    // correct vantage more, not less.
    git(CLONE, ['checkout', '-qb', 'feature/remove-rollback']);
    expect(await reportReviewed({ ...base, itemId: published, api: capture() })).toBe('gated');
  });

  it('surfaces a review conflict instead of retrying', async () => {
    expect(await reportReviewed({ ...base, itemId: published, api: conflicting() })).toBe('conflict');
  });
});
