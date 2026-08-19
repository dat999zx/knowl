import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitArgs } from '../git-identity.js';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { cloudStatus, formatCloudStatus } from '../../src/cloud/status.js';
import { stagePublish } from '../../src/cloud/publish.js';
import { withTeamStore } from '../../src/cloud/team-store.js';
import { writeSyncState } from '../../src/cloud/sync-state.js';
import type { ProjectConfig } from '../../src/core/types.js';

const API_HOST = 'https://api.status.test';

// Identity on every invocation, never `git config` -- see `tests/git-identity.ts`.
const git = (cwd: string, args: string[]) => spawnSync('git', gitArgs(args), { cwd, encoding: 'utf8' });

// Fresh directories per test, for the Windows reason `publish-push.test.ts` documents.
let run = 0;
let ORIGIN: string;
let CLONE: string;
let WS: string;
let connected: ProjectConfig;
let id: string;

describe('cloudStatus', () => {
  beforeEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll();

    run += 1;
    ORIGIN = path.resolve(`./.knowl-status-origin-${run}`);
    CLONE = path.resolve(`./.knowl-status-clone-${run}`);
    WS = `ws-status-${run}`;
    connected = {
      version: 1,
      cloud: {
        apiHost: API_HOST, workspaceId: WS, workspaceName: 'Acme',
        repo: 'github.com/acme/web', remote: 'origin',
      },
    };

    await fs.mkdir(ORIGIN, { recursive: true });
    git(ORIGIN, ['init', '-q', '-b', 'main']);
    await fs.writeFile(path.join(ORIGIN, 'a.txt'), 'one', 'utf8');
    git(ORIGIN, ['add', '.']);
    git(ORIGIN, ['commit', '-qm', 'one']);
    git(process.cwd(), ['clone', '-q', ORIGIN, CLONE]);

    await fs.mkdir(path.join(CLONE, '.knowl'), { recursive: true });
    await fs.writeFile(path.join(CLONE, '.knowl', 'config.json'), JSON.stringify({ version: 1 }), 'utf8');
    await initDb(CLONE);
    await getClient().execute('DELETE FROM knowledge_items');
    await getClient().execute('DELETE FROM cloud_published');
    const projectId = (await repo.createProject(CLONE, 'status')).id;
    const decision = await storeKnowledgeItemDeduped(projectId, {
      category: 'decision', title: 'Deploys roll back by tag',
      content: 'A failed deploy rolls back to the previous tag, never to a branch.',
    });
    id = decision.item.id;
    await getClient().execute("UPDATE knowledge_items SET origin_repo = 'github.com/acme/web'");
    await closeDb();
  });

  afterEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll();
    for (const dir of [ORIGIN, CLONE]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('says the repo is not connected, and still answers the auth half', async () => {
    // The disconnected variant carries auth because that is the one situation where "I ran
    // knowl cloud login and status still says nothing" is otherwise unanswerable.
    const status = await cloudStatus(CLONE, { version: 1 });

    expect(status.connected).toBe(false);
    expect(status).toMatchObject({ signedIn: false, identity: null });
    expect(formatCloudStatus(status)).toMatch(/not connected/i);
  });

  it('splits staged atoms into new and corrections', async () => {
    const { recordPushed, restageForPublish, stageForPublish } = await import('../../src/cloud/ledger.js');
    await initDb(CLONE);
    try {
      await stageForPublish(['fresh'], WS, 'main');
      await stageForPublish(['known'], WS, 'main');
      await recordPushed('known', WS, 3, { contentHash: null, lifecycleHash: null });
      await restageForPublish(['known'], WS, 'main');
    } finally { await closeDb(); }

    const status = await cloudStatus(CLONE, connected) as Extract<Awaited<ReturnType<typeof cloudStatus>>, { connected: true }>;

    expect(status.staged).toBe(2);
    expect(status.stagedNew).toBe(1);
    expect(status.stagedCorrections).toBe(1);
  });

  it('separates staged atoms that can still be sent from ones a newer write retired', async () => {
    // knowl#104. A staged atom superseded AFTERWARDS keeps `stage_state = 'pending'`, so it goes
    // on being counted. Reporting one number a user cannot reconcile against what a push reports
    // reads as "the push is broken" rather than "one of these was replaced".
    const { stageForPublish } = await import('../../src/cloud/ledger.js');
    await initDb(CLONE);
    try {
      const now = new Date().toISOString();
      for (const [id, itemStatus] of [['live', 'active'], ['retired', 'superseded']] as const) {
        await getClient().execute({
          sql: `INSERT INTO knowledge_items (id, category, title, content, status, created_at, updated_at)
                VALUES (?, 'fact', ?, 'body', ?, ?, ?)`,
          args: [id, `Atom ${id}`, itemStatus, now, now],
        });
      }
      await stageForPublish(['live', 'retired'], WS, 'main');
    } finally { await closeDb(); }

    const status = await cloudStatus(CLONE, connected) as Extract<Awaited<ReturnType<typeof cloudStatus>>, { connected: true }>;

    // `staged` stays the whole queue -- the ledger records intent and this command does not edit
    // it -- but the half that a push can actually move is now nameable.
    expect(status.staged).toBe(2);
    expect(status.stagedSendable).toBe(1);
    expect(status.stagedInactive).toBe(1);
  });

  it('reports every staged atom as sendable when none has been retired', async () => {
    const { stageForPublish } = await import('../../src/cloud/ledger.js');
    await initDb(CLONE);
    try { await stageForPublish(['only'], WS, 'main'); } finally { await closeDb(); }

    const status = await cloudStatus(CLONE, connected) as Extract<Awaited<ReturnType<typeof cloudStatus>>, { connected: true }>;

    // A staged id whose row is gone entirely is NOT counted as retired: it is missing, which the
    // push already reports its own way, and calling it superseded would name the wrong remedy.
    expect(status.staged).toBe(1);
    expect(status.stagedInactive).toBe(0);
  });

  it('reports the signed-in identity from the credential cache, without a network call', async () => {
    const home = path.resolve(`./.knowl-status-home-${run}`);
    process.env.KNOWL_HOME = home;
    try {
      const { writeCredential } = await import('../../src/cloud/credentials.js');
      await writeCredential(API_HOST, {
        accessToken: 'a', refreshToken: 'r',
        expiresAt: '2099-01-01T00:00:00.000Z',
        sessionId: 's', identity: { email: 'dev@example.com', displayName: 'Dev' },
      });

      const original = globalThis.fetch;
      globalThis.fetch = (() => { throw new Error('status must not reach the network'); }) as typeof fetch;
      try {
        const status = await cloudStatus(CLONE, connected);
        expect(status.signedIn).toBe(true);
        expect(status.identity).toEqual({ email: 'dev@example.com', displayName: 'Dev' });
        expect(formatCloudStatus(status)).toContain('dev@example.com');
      } finally { globalThis.fetch = original; }
    } finally {
      delete process.env.KNOWL_HOME;
      await fs.rm(home, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('says identity unknown for a credential written before the cache existed', async () => {
    const home = path.resolve(`./.knowl-status-home-old-${run}`);
    process.env.KNOWL_HOME = home;
    try {
      const { writeCredential } = await import('../../src/cloud/credentials.js');
      await writeCredential(API_HOST, {
        accessToken: 'a', refreshToken: 'r',
        expiresAt: '2099-01-01T00:00:00.000Z', sessionId: 's',
      });

      const status = await cloudStatus(CLONE, connected);
      expect(status.identity).toBeNull();
      expect(formatCloudStatus(status)).toMatch(/identity unknown/i);
    } finally {
      delete process.env.KNOWL_HOME;
      await fs.rm(home, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('always names when the next auto-pull is due, because unknown must not read as not-due', async () => {
    const status = await cloudStatus(CLONE, connected) as Extract<Awaited<ReturnType<typeof cloudStatus>>, { connected: true }>;
    expect(status.nextSyncDueAt).not.toBeNull();
  });

  it('reports the workspace, the role and how stale the replica is', async () => {
    await withTeamStore(WS, CLONE, () => writeSyncState({
      apiHost: API_HOST, since: '7', cursor: null,
      lastSyncedAt: '2026-08-09T12:00:00.000Z', lastError: null, role: 'editor',
    }));

    const status = await cloudStatus(CLONE, connected);

    expect(status).toMatchObject({
      connected: true, workspace: 'Acme', role: 'editor',
      lastSyncedAt: '2026-08-09T12:00:00.000Z', lastError: null,
    });
    const text = formatCloudStatus(status);
    expect(text).toContain('editor');
    expect(text).toContain('2026-08-09T12:00:00.000Z');
  });

  it('reports what is staged and what is holding it', async () => {
    // The line that stops staged work being silently forgotten. A developer who staged on a
    // branch and moved on has no other prompt -- the atoms are in a table nobody reads.
    git(CLONE, ['checkout', '-qb', 'feature/rollback']);
    await stagePublish({ projectRoot: CLONE, config: connected, ids: [id], apply: true });

    const text = formatCloudStatus(await cloudStatus(CLONE, connected));

    expect(text).toContain('1 staged');
    expect(text).toContain('feature/rollback');
  });

  it('tells a feature branch its staged work is ready, because the branch no longer holds it', async () => {
    // Until 2026-08-13 this line printed the publish gate's refusal. Publishing is ungated now,
    // so that sentence would be false twice over: it names a blocker that is gone, and it sends
    // the reader off to change branch and pull for a push that would have worked.
    git(CLONE, ['checkout', '-qb', 'feature/rollback']);
    await stagePublish({ projectRoot: CLONE, config: connected, ids: [id], apply: true });

    const text = formatCloudStatus(await cloudStatus(CLONE, connected));

    expect(text).toContain('Ready to send. Run knowl cloud push.');
    expect(text).not.toMatch(/not main|no unpublish|Pull first/i);
  });

  it('warns that sending is irreversible whenever anything is staged', async () => {
    // A product requirement, not a nicety. `knowl cloud retract` now wires the server's delete
    // verb, so this no longer says publishing cannot be undone -- but undoing means a hard delete
    // and a tombstone barring the id forever, which is not the same as a mistake being cheap.
    await stagePublish({ projectRoot: CLONE, config: connected, ids: [id], apply: true });
    const text = formatCloudStatus(await cloudStatus(CLONE, connected));
    expect(text).toMatch(/irreversible/i);
    expect(text).toContain('knowl cloud retract');
  });

  it('says nothing about irreversibility when nothing is staged', async () => {
    // The warning has to mean something. Printed on every run it becomes furniture, and the one
    // time it matters nobody reads it.
    expect(formatCloudStatus(await cloudStatus(CLONE, connected))).not.toMatch(/irreversible/i);
  });

  it('makes no network call', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error('status must not reach the network'); }) as typeof fetch;
    try { await expect(cloudStatus(CLONE, connected)).resolves.toBeDefined(); }
    finally { globalThis.fetch = original; }
  });
});
