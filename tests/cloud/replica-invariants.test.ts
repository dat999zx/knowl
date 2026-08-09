import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getClient } from '../../src/store/database.js';
import { withTeamStore } from '../../src/cloud/team-store.js';
import { applySyncRows } from '../../src/cloud/sync-apply.js';
import type { SyncAtom } from '../../src/cloud/sync-contract.js';

const HOME = path.resolve('./.knowl-replica-inv-home');
const ROOT = path.resolve('./.knowl-replica-inv-root');
const WS = 'ws-inv';

const atom = (over: Partial<SyncAtom> = {}): SyncAtom => ({
  id: 'a1', category: 'decision', title: 'Title', content: 'Body', status: 'active',
  freshness: 'fresh', contentHash: 'h1', originRepo: 'github.com/acme/api', authorUserId: 'u1',
  supersededById: null, version: 1, visibility: 'workspace', review: null,
  publishedAt: '2026-08-09T10:00:00.000Z', createdAt: '2026-08-09T10:00:00.000Z',
  updatedAt: '2026-08-09T10:00:00.000Z', ...over,
});

describe('replica invariants', () => {
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

  it('holds nothing repo-private, because federation does not filter it', async () => {
    // Task 2 reads the replica WITHOUT a visibility predicate, on the grounds that the server
    // publishes nothing private. This is the assertion that makes that safe rather than
    // hopeful: a private row reaching the replica is a server bug, and it should be loud.
    const rows = await withTeamStore(WS, ROOT, async () => {
      await applySyncRows([
        { op: 'upsert', seq: '1', item: atom() },
        { op: 'upsert', seq: '2', item: atom({ id: 'a2', contentHash: 'h2' }) },
      ]);
      const result = await getClient().execute(
        "SELECT COUNT(*) AS n FROM knowledge_items WHERE visibility <> 'workspace'",
      );
      return Number(result.rows[0].n);
    });

    expect(rows).toBe(0);
  });

  it('never attributes a team row to the local repo', async () => {
    // `origin_repo` decides who may publish and who is credited. A replica row inheriting this
    // repo's name would let it be republished from here as though this repo had written it.
    const owners = await withTeamStore(WS, ROOT, async () => {
      await applySyncRows([{ op: 'upsert', seq: '1', item: atom() }]);
      const result = await getClient().execute('SELECT DISTINCT origin_repo FROM knowledge_items');
      return result.rows.map(row => String(row.origin_repo));
    });

    expect(owners).toEqual(['github.com/acme/api']);
  });
});
