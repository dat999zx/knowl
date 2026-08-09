import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

const git = (cwd: string, args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });

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
    git(ORIGIN, ['config', 'user.email', 'test@example.com']);
    git(ORIGIN, ['config', 'user.name', 'Test']);
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

  it('says the repo is not connected', async () => {
    expect(await cloudStatus(CLONE, { version: 1 })).toEqual({ connected: false });
    expect(formatCloudStatus({ connected: false })).toMatch(/not connected/i);
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

  it('says publishing cannot be undone whenever anything is staged', async () => {
    // A product requirement, not a nicety. The server has a retire verb; no client path wires
    // it, so a confirmation that omits this is a confirmation that misleads.
    await stagePublish({ projectRoot: CLONE, config: connected, ids: [id], apply: true });
    expect(formatCloudStatus(await cloudStatus(CLONE, connected))).toMatch(/cannot be undone/i);
  });

  it('says nothing about irreversibility when nothing is staged', async () => {
    // The warning has to mean something. Printed on every run it becomes furniture, and the one
    // time it matters nobody reads it.
    expect(formatCloudStatus(await cloudStatus(CLONE, connected))).not.toMatch(/cannot be undone/i);
  });

  it('makes no network call', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error('status must not reach the network'); }) as typeof fetch;
    try { await expect(cloudStatus(CLONE, connected)).resolves.toBeDefined(); }
    finally { globalThis.fetch = original; }
  });
});
