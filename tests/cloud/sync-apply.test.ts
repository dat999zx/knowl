import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getClient } from '../../src/store/database.js';
import { withTeamStore } from '../../src/cloud/team-store.js';
import { applySyncRows } from '../../src/cloud/sync-apply.js';
import type { SyncAtom, SyncRow } from '../../src/cloud/sync-contract.js';
import { encodeVector } from '../../src/cloud/vector-codec.js';
import { decodeVector as decodeStored } from '../../src/store/vector.js';

const HOME = path.resolve('./.knowl-sync-apply-home');
const ROOT = path.resolve('./.knowl-sync-apply-root');

const wipe = (dir: string) =>
  fs.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 }).catch(() => {});

/** A replica per test: a libSQL file cannot be removed and recreated in one process. */
const inStore = <T>(id: string, run: () => Promise<T>) => withTeamStore(`ws-${id}`, ROOT, run);

function atom(overrides: Partial<SyncAtom> = {}): SyncAtom {
  return {
    id: 'atom-1',
    category: 'decision',
    title: 'Use Postgres',
    content: 'We chose Postgres over MySQL.',
    status: 'active',
    freshness: 'fresh',
    confidence: 0.9,
    tags: ['db'],
    contentHash: 'hash-1',
    originRepo: 'github.com/acme/web',
    authorUserId: 'user-1',
    supersededById: null,
    version: 1,
    visibility: 'workspace',
    review: null,
    publishedAt: '2026-08-09T10:00:00.000Z',
    createdAt: '2026-08-09T10:00:00.000Z',
    updatedAt: '2026-08-09T10:00:00.000Z',
    ...overrides,
  };
}

const countItems = async (): Promise<number> =>
  Number((await getClient().execute('SELECT COUNT(*) AS n FROM knowledge_items')).rows[0].n);

describe('applySyncRows', () => {
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

  it('inserts an atom with the server\'s own id, version and timestamps', async () => {
    // The replica must reproduce the server's rows exactly. Generating local ids or stamping
    // local times would make the same atom a different atom on every machine, and content
    // dedup across stores keys on contentHash.
    const row = await inStore('insert', async () => {
      await applySyncRows([{ op: 'upsert', seq: '1', item: atom() }]);
      const result = await getClient().execute({
        sql: 'SELECT * FROM knowledge_items WHERE id = ?',
        args: ['atom-1'],
      });
      return result.rows[0];
    });

    expect(String(row.id)).toBe('atom-1');
    expect(Number(row.version)).toBe(1);
    expect(String(row.origin_repo)).toBe('github.com/acme/web');
    expect(String(row.content_hash)).toBe('hash-1');
    expect(String(row.created_at)).toBe('2026-08-09T10:00:00.000Z');
  });

  it('accepts an atom whose contentHash is null, as the server really sends', async () => {
    // Not hypothetical: every row of the server-generated snapshot-page fixture carries null.
    const hash = await inStore('null-hash', async () => {
      await applySyncRows([{ op: 'upsert', seq: '1', item: atom({ contentHash: null }) }]);
      const result = await getClient().execute({
        sql: 'SELECT content_hash FROM knowledge_items WHERE id = ?',
        args: ['atom-1'],
      });
      return result.rows[0].content_hash;
    });

    expect(hash).toBeNull();
  });

  it('supplies the NOT NULL columns the server leaves out', async () => {
    // confidence and tier are NOT NULL locally but optional in the payload. Defaulting them at
    // apply time is what keeps a perfectly ordinary atom from failing the whole page.
    const row = await inStore('defaults', async () => {
      await applySyncRows([{ op: 'upsert', seq: '1', item: atom({ confidence: undefined, tier: undefined }) }]);
      const result = await getClient().execute({
        sql: 'SELECT confidence, tier FROM knowledge_items WHERE id = ?',
        args: ['atom-1'],
      });
      return result.rows[0];
    });

    expect(Number(row.confidence)).toBe(1);
    expect(String(row.tier)).toBe('asserted');
  });

  it('is idempotent: applying the same page twice changes nothing', async () => {
    // Replay is the NORMAL case, not an edge case -- the watermark advances only when a
    // traversal completes, so any interruption re-delivers pages already applied.
    const rows: SyncRow[] = [{ op: 'upsert', seq: '1', item: atom() }];

    const count = await inStore('idempotent', async () => {
      await applySyncRows(rows);
      await applySyncRows(rows);
      return countItems();
    });

    expect(count).toBe(1);
  });

  it('updates in place when the server sends a newer version', async () => {
    const title = await inStore('update', async () => {
      await applySyncRows([{ op: 'upsert', seq: '1', item: atom() }]);
      await applySyncRows([{ op: 'upsert', seq: '2', item: atom({ version: 2, title: 'Use Postgres 16' }) }]);
      const result = await getClient().execute({
        sql: 'SELECT title FROM knowledge_items WHERE id = ?',
        args: ['atom-1'],
      });
      return String(result.rows[0].title);
    });

    expect(title).toBe('Use Postgres 16');
  });

  it('applies a delete, so a retraction does not live on every laptop forever', async () => {
    const count = await inStore('delete', async () => {
      await applySyncRows([{ op: 'upsert', seq: '1', item: atom() }]);
      await applySyncRows([{ op: 'delete', seq: '2', id: 'atom-1', deletedAt: '2026-08-09T11:00:00.000Z' }]);
      return countItems();
    });

    expect(count).toBe(0);
  });

  it('tolerates a delete for an atom it never had', async () => {
    // Reachable on a first sync from a non-zero watermark, and after a resync. A throw here
    // would wedge every later page behind a row that is already in the desired state.
    const outcome = await inStore('delete-missing', () =>
      applySyncRows([{ op: 'delete', seq: '1', id: 'never-seen', deletedAt: '2026-08-09T11:00:00.000Z' }]));

    expect(outcome.deleted).toBe(0);
  });

  it('stores evidence alongside the atom, linked and with a relationship', async () => {
    // relationship is NOT NULL with a CHECK constraint locally, and the payload may omit it.
    const stored = await inStore('evidence', async () => {
      await applySyncRows([{ op: 'upsert', seq: '1', item: atom({
        evidence: [{ id: 'ev-1', type: 'file', locator: 'src/db.ts', excerpt: 'createClient' }],
      }) }]);
      const evidence = await getClient().execute('SELECT * FROM evidence');
      const link = await getClient().execute('SELECT * FROM knowledge_evidence');
      return { evidence: evidence.rows[0], link: link.rows[0], count: evidence.rows.length };
    });

    expect(stored.count).toBe(1);
    expect(String(stored.evidence.type)).toBe('file');
    expect(String(stored.evidence.locator)).toBe('src/db.ts');
    // Falls back to the atom's own updatedAt rather than a local clock: the replica must be the
    // same rows on every machine, so nothing here may be stamped with when this laptop synced.
    expect(String(stored.evidence.observed_at)).toBe('2026-08-09T10:00:00.000Z');
    expect(String(stored.link.relationship)).toBe('supports');
    expect(String(stored.link.knowledge_item_id)).toBe('atom-1');
  });

  it('rewrites evidence wholesale, so a retracted citation disappears', async () => {
    // The server's set is authoritative. Diffing would leave a citation the author removed
    // attached to the atom on every replica that had already seen it.
    const locators = await inStore('evidence-rewrite', async () => {
      await applySyncRows([{ op: 'upsert', seq: '1', item: atom({
        evidence: [
          { id: 'ev-1', type: 'file', locator: 'src/db.ts' },
          { id: 'ev-2', type: 'file', locator: 'src/gone.ts' },
        ],
      }) }]);
      await applySyncRows([{ op: 'upsert', seq: '2', item: atom({
        version: 2,
        evidence: [{ id: 'ev-1', type: 'file', locator: 'src/db.ts' }],
      }) }]);
      const result = await getClient().execute(
        `SELECT e.locator FROM evidence e
         JOIN knowledge_evidence ke ON ke.evidence_id = e.id
         WHERE ke.knowledge_item_id = 'atom-1'`,
      );
      return result.rows.map(row => String(row.locator));
    });

    expect(locators).toEqual(['src/db.ts']);
  });

  it('applies all rows in one transaction, so an interrupted page leaves nothing behind', async () => {
    // The watermark advances only after the apply commits. A partial apply would put rows in
    // the replica that the watermark says were never delivered -- invisible until they went
    // stale and nothing ever refreshed them.
    const count = await inStore('atomic', async () => {
      await applySyncRows([{ op: 'upsert', seq: '1', item: atom() }]);
      await expect(applySyncRows([
        { op: 'upsert', seq: '2', item: atom({ id: 'atom-2' }) },
        { op: 'upsert', seq: '3', item: atom({ id: 'atom-3', title: null as unknown as string }) },
      ])).rejects.toThrow();
      return countItems();
    });

    expect(count).toBe(1);
  });
});

describe('vectors that arrive with a row', () => {
  const PROFILE = { provider: 'local', model: 'granite', dtype: 'q8', pooling: 'cls' as const };
  const CONTEXT = { profile: PROFILE, fingerprint: 'fp-local', dimensions: 4 };
  const VECTOR = [0.25, -0.5, 0.75, 1];

  it('stores a received vector under the LOCAL fingerprint', async () => {
    await inStore('vec-store', async () => {
      const outcome = await applySyncRows(
        [{ op: 'upsert', seq: '1', item: atom({ id: 'a', vector: encodeVector(VECTOR) }) }],
        CONTEXT,
      );

      // Nothing left for the local embedder: the vector arrived and was kept.
      expect(outcome.needEmbedding).toEqual([]);

      const row = await getClient().execute({
        sql: 'SELECT profile_fingerprint, dimensions, vector FROM knowledge_embeddings WHERE knowledge_item_id = ?',
        args: ['a'],
      });
      // The LOCAL fingerprint, not the server's: this client only connected because the profiles
      // match, so the vector belongs to the local space and local search must be able to filter
      // it like any other row.
      expect(String(row.rows[0]!.profile_fingerprint)).toBe('fp-local');
      expect(Number(row.rows[0]!.dimensions)).toBe(4);
      expect(Array.from(decodeStored(row.rows[0]!.vector)!)).toEqual(VECTOR);
    });
  });

  it('reports a row that arrived without one, rather than inventing a vector', async () => {
    await inStore('vec-absent', async () => {
      const outcome = await applySyncRows(
        [{ op: 'upsert', seq: '1', item: atom({ id: 'b' }) }],
        CONTEXT,
      );

      // Every row looks like this while a workspace is mid-reindex. Not a failure -- the atom is
      // stored and text-searchable, and the local embedder closes the gap.
      expect(outcome.needEmbedding).toEqual(['b']);
    });
  });

  it('refuses a vector of the wrong width rather than storing noise', async () => {
    await inStore('vec-width', async () => {
      const outcome = await applySyncRows(
        [{ op: 'upsert', seq: '1', item: atom({ id: 'c', vector: encodeVector([1, 2, 3, 4, 5, 6]) }) }],
        CONTEXT,
      );

      // The replica's column has no width constraint, so a 6-dim vector in a 4-dim store would
      // rank as noise forever. Falling back to a local embed is the recoverable direction.
      expect(outcome.needEmbedding).toEqual(['c']);
      const row = await getClient().execute({
        sql: 'SELECT 1 FROM knowledge_embeddings WHERE knowledge_item_id = ?', args: ['c'],
      });
      expect(row.rows).toHaveLength(0);
    });
  });

  it('stores nothing when the caller asked for no vectors, which is the pre-vector behaviour', async () => {
    await inStore('vec-off', async () => {
      const outcome = await applySyncRows(
        [{ op: 'upsert', seq: '1', item: atom({ id: 'd', vector: encodeVector(VECTOR) }) }],
      );
      expect(outcome.needEmbedding).toEqual(['d']);
    });
  });
});
