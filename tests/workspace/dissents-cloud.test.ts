import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import { withTeamStore } from '../../src/cloud/team-store.js';
import { applySyncRows } from '../../src/cloud/sync-apply.js';
import { resolveWorkspace } from '../../src/workspace/resolve.js';
import { createDissent } from '../../src/workspace/dissents.js';
import type { ProjectConfig } from '../../src/core/config.js';
import type { SyncAtom } from '../../src/cloud/sync-contract.js';

/**
 * A dissent against an item the team replica holds is refused, not recorded. The replica is a
 * copy of rows written on other machines: a dissent filed here would never reach the owner while
 * reading as though something had been done.
 */

const HOME = path.join(os.tmpdir(), 'knowl-dissent-cloud-home');
const ROOT = path.join(os.tmpdir(), 'knowl-dissent-cloud-root');
const WS = 'ws-dissent-cloud';

const config: ProjectConfig = {
  version: 1,
  cloud: {
    apiHost: 'https://api.knowl.test', workspaceId: WS, workspaceName: 'Acme',
    repo: 'github.com/acme/web', remote: 'origin',
  },
};

function atom(id: string, originRepo: string, title: string): SyncAtom {
  return {
    id, category: 'decision', title, content: `${title} body`,
    status: 'active', freshness: 'fresh', contentHash: `hash-${id}`, originRepo,
    authorUserId: 'u1', supersededById: null, version: 1, visibility: 'workspace', review: null,
    publishedAt: '2026-08-09T10:00:00.000Z', createdAt: '2026-08-09T10:00:00.000Z',
    updatedAt: '2026-08-09T10:00:00.000Z',
  };
}

describe('createDissent against the cloud replica', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, ROOT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await fs.writeFile(path.join(ROOT, '.knowl', 'config.json'), JSON.stringify({ version: 1 }), 'utf8');
    await initDb(ROOT);
    await closeDb();
    await withTeamStore(WS, ROOT, async () => {
      await applySyncRows([{ op: 'upsert', seq: '1', item: atom('t1', 'github.com/acme/api', 'API rollback') }]);
    });
  });

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, ROOT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('refuses a cloud-owned item by name, and writes nothing', async () => {
    const workspace = (await resolveWorkspace(ROOT, config))!;
    expect(workspace.cloud?.present).toBe(true);
    await initDb(ROOT);
    await expect(createDissent({ targetItemId: 't1', claim: 'Wrong.' }, workspace))
      .rejects.toThrow(/team workspace "Acme"/);
    await closeDb();
  });
});
