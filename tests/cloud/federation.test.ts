import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { teamStorePath, withTeamStore } from '../../src/cloud/team-store.js';
import { releaseClient } from '../../src/store/connection-pool.js';
import { applySyncRows } from '../../src/cloud/sync-apply.js';
import { queryFederated } from '../../src/workspace/federated-query.js';
import { resolveWorkspace } from '../../src/workspace/resolve.js';
import { initDb, closeDb } from '../../src/store/database.js';
import type { ProjectConfig } from '../../src/core/types.js';
import type { SyncAtom } from '../../src/cloud/sync-contract.js';

const HOME = path.resolve('./.knowl-federation-home');
const ROOT = path.resolve('./.knowl-federation-root');
const WS = 'ws-fed';

const config: ProjectConfig = {
  version: 1,
  cloud: {
    apiHost: 'https://api.knowl.test', workspaceId: WS, workspaceName: 'Acme',
    repo: 'github.com/acme/web', remote: 'origin',
  },
};

function atom(id: string, originRepo: string, title: string): SyncAtom {
  return {
    id, category: 'decision', title, content: `${title} — deployment rollback procedure`,
    status: 'active', freshness: 'fresh', contentHash: `hash-${id}`, originRepo,
    authorUserId: 'u1', supersededById: null, version: 1, visibility: 'workspace', review: null,
    publishedAt: '2026-08-09T10:00:00.000Z', createdAt: '2026-08-09T10:00:00.000Z',
    updatedAt: '2026-08-09T10:00:00.000Z',
  };
}

async function seedReplica(): Promise<void> {
  await withTeamStore(WS, ROOT, async () => {
    await applySyncRows([
      { op: 'upsert', seq: '1', item: atom('t1', 'github.com/acme/api', 'API rollback procedure') },
      { op: 'upsert', seq: '2', item: atom('t2', 'github.com/acme/infra', 'Infra rollback procedure') },
    ]);
  });
}

describe('federation with the cloud replica', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    for (const dir of [HOME, ROOT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await fs.writeFile(path.join(ROOT, '.knowl', 'config.json'), JSON.stringify({ version: 1 }), 'utf8');
    await initDb(ROOT);
    await closeDb();
  });
  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb().catch(() => {});
    for (const dir of [HOME, ROOT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  const run = async () => {
    const workspace = (await resolveWorkspace(ROOT, config))!;
    await initDb(ROOT);
    try {
      return await queryFederated({ workspace, query: 'rollback procedure', limit: 5 });
    } finally {
      await closeDb();
    }
  };

  it('returns nothing from the cloud before the first pull, without failing', async () => {
    const result = await run();

    expect(result.groups.flatMap(group => group.items)).toEqual([]);
    expect(result.skipped.some(entry => entry.reason === 'absent')).toBe(true);
  });

  it('groups each team row under the repo that wrote it, not under one peer name', async () => {
    // The replica is one store holding many repos' rows. Grouping it as a single peer would
    // file an infra decision under a name no repo has, and the whole point of the grouped
    // shape is that a reader can see who owns each row without reading a field.
    await seedReplica();

    const result = await run();
    const repos = result.groups.map(group => group.repo).sort();

    expect(repos).toContain('github.com/acme/api');
    expect(repos).toContain('github.com/acme/infra');
  });

  it('marks team rows remote, so a reader can tell them from a store on disk', async () => {
    await seedReplica();

    const items = (await run()).groups.flatMap(group => group.items);

    expect(items.length).toBeGreaterThan(0);
    expect(items.every(item => item.remote === true)).toBe(true);
  });

  it('keeps the response grouped once the cloud contributes', async () => {
    await seedReplica();
    expect((await run()).shape).toBe('grouped');
  });

  it('reports an unreadable replica as skipped rather than failing the query', async () => {
    // The rule every peer already follows: a store this process cannot read costs the caller
    // a notice, never their answer.
    await seedReplica();
    // Released before the file is corrupted, and this is the whole test rather than tidiness.
    // Seeding pools a connection to the replica; overwriting the file underneath it leaves that
    // handle serving the pages it already has. On Windows the pool had let go by this point and
    // the next open read the garbage, so the assertion passed; on Linux and macOS it had not, the
    // query answered from the live handle, and nothing was skipped. The test was measuring pool
    // state on one platform and file contents on another.
    await releaseClient(teamStorePath(WS));
    await fs.writeFile(path.join(HOME, 'cloud', WS, 'knowledge.db'), 'not a database', 'utf8');

    const result = await run();
    expect(result.skipped.some(entry => entry.repo === WS)).toBe(true);
  });
});
