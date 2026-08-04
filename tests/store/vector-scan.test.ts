import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { fingerprintProfile } from '../../src/core/vector-profile.js';
import {
  cosineSimilarity, searchKnowledgeEmbeddings, upsertKnowledgeEmbedding,
} from '../../src/store/vector.js';
import { localStore } from '../../src/store/store-handle.js';

const ROOT = path.resolve('./.knowl-test-vector-scan');
const FP = fingerprintProfile({ provider: 'local', model: 'a/b', dtype: 'q8', pooling: 'cls' });
const DIM = 16;

let projectId: string;

/**
 * Deterministic, non-degenerate, and not unit length -- so a plain dot product would mis-rank.
 * Components stay positive so every pair has a positive cosine, which keeps the `score <= 0`
 * rule out of the fixtures that are not about it.
 */
function vectorFor(seed: number): number[] {
  let state = (seed * 2654435761) >>> 0 || 1;
  const scale = 0.5 + (seed % 7);
  return Array.from({ length: DIM }, () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return (0.05 + (state / 4294967296)) * scale;
  });
}

async function seed(count: number, options: { tagEvery?: number } = {}) {
  const client = getClient();
  await client.execute('DELETE FROM knowledge_embeddings');
  await client.execute('DELETE FROM knowledge_items');
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: `item ${index}`,
      content: `body ${index}`,
      tags: options.tagEvery && index % options.tagEvery === 0 ? ['keep'] : ['other'],
    });
    ids.push(item.id);
    await upsertKnowledgeEmbedding({
      projectId, knowledgeItemId: item.id, provider: 'local', model: 'a/b',
      profileFingerprint: FP, dimensions: DIM, vector: vectorFor(index),
    });
  }
  return ids;
}

/** The ranking the old JavaScript scan produced, computed here from the stored rows. */
async function expectedRanking(query: number[], limit: number): Promise<string[]> {
  const rows = await getClient().execute(
    `SELECT e.knowledge_item_id AS id, e.vector AS vector FROM knowledge_embeddings e
     JOIN knowledge_items i ON i.id = e.knowledge_item_id WHERE i.status = 'active'`,
  );
  const scored = rows.rows.map((row: any) => {
    const view = row.vector instanceof ArrayBuffer
      ? new Float32Array(row.vector)
      : ArrayBuffer.isView(row.vector)
        ? new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4)
        : Float32Array.from(JSON.parse(String(row.vector)));
    return { id: String(row.id), score: cosineSimilarity(query, view) };
  }).filter(candidate => candidate.score > 0);
  scored.sort((left, right) => right.score - left.score);
  return scored.slice(0, limit).map(candidate => candidate.id);
}

/** Records every statement this connection runs, and how many rows each one handed back. */
function traceClient() {
  const client: any = getClient();
  const original = client.execute.bind(client);
  const seen: Array<{ sql: string; rows: number }> = [];
  client.execute = async (statement: any) => {
    const sql = typeof statement === 'string' ? statement : statement.sql;
    const result = await original(statement);
    seen.push({ sql, rows: result?.rows?.length ?? 0 });
    return result;
  };
  return { seen, restore: () => { client.execute = original; } };
}

describe('the vector scan', () => {
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'vector scan fixture')).id;
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('never reads a stored vector into this process', async () => {
    await seed(40);
    const query = vectorFor(3);

    const trace = traceClient();
    try {
      await searchKnowledgeEmbeddings(projectId, { vector: query, profileFingerprint: FP, limit: 5 });
    } finally {
      trace.restore();
    }

    const scans = trace.seen.filter(statement => /FROM knowledge_embeddings/.test(statement.sql));
    expect(scans).toHaveLength(1);
    // The whole point: the cosine is computed by SQLite, so the vector column is never selected.
    expect(scans[0].sql).toContain('vector_distance_cos');
    expect(scans[0].sql).not.toMatch(/e\.vector AS vector/);
    // And the scan hands back one page, not the store.
    expect(scans[0].rows).toBeLessThanOrEqual(Math.max(5 * 4, 32));
  });

  it('returns the same items in the same order as scoring every row in JavaScript', async () => {
    await seed(60);
    for (const seedIndex of [1, 7, 23, 41]) {
      const query = vectorFor(seedIndex);
      const results = await searchKnowledgeEmbeddings(projectId, { vector: query, profileFingerprint: FP, limit: 10 });
      expect(results.map(result => result.item.id)).toEqual(await expectedRanking(query, 10));
    }
  });

  it('filters tags before the cap, not after it', async () => {
    // One tagged item in every ten, so a page of the ranking is mostly untagged.
    await seed(60, { tagEvery: 10 });
    const results = await searchKnowledgeEmbeddings(projectId, {
      vector: vectorFor(5), profileFingerprint: FP, tags: ['keep'], limit: 6,
    });
    expect(results).toHaveLength(6);
    for (const result of results) expect(result.item.tags).toContain('keep');
  });

  it('still searches a store holding the legacy JSON-text encoding', async () => {
    const ids = await seed(30);
    // Rewrite three rows the way this module wrote them before the packed blob.
    for (const index of [4, 11, 26]) {
      await getClient().execute({
        sql: 'UPDATE knowledge_embeddings SET vector = ? WHERE knowledge_item_id = ?',
        args: [JSON.stringify(vectorFor(index)), ids[index]],
      });
    }

    const query = vectorFor(11);
    const results = await searchKnowledgeEmbeddings(projectId, { vector: query, profileFingerprint: FP, limit: 10 });
    // The row whose vector IS the query has to come first, and it is one of the legacy ones.
    expect(results[0].item.id).toBe(ids[11]);
    expect(results.map(result => result.item.id)).toEqual(await expectedRanking(query, 10));
  });

  it('finds a legacy row that appears after searches have already run on this connection', async () => {
    // The hazard a cached probe cannot see. An earlier version of this file asked once per
    // connection whether every row was a packed blob and trusted the answer; a row written
    // afterwards by another process on an older build then stayed invisible to semantic
    // search while `findEmbeddedItemIds` still called its item embedded.
    const ids = await seed(20);
    await searchKnowledgeEmbeddings(projectId, { vector: vectorFor(1), profileFingerprint: FP, limit: 5 });

    await getClient().execute({
      sql: 'UPDATE knowledge_embeddings SET vector = ? WHERE knowledge_item_id = ?',
      args: [JSON.stringify(vectorFor(2)), ids[2]],
    });

    const results = await searchKnowledgeEmbeddings(projectId, { vector: vectorFor(2), profileFingerprint: FP, limit: 5 });
    expect(results[0].item.id).toBe(ids[2]);
    expect(results[0].score).toBeCloseTo(1, 5);
  });

  it('scores a legacy JSON row and a packed one to the same number', async () => {
    const ids = await seed(6);
    const packed = await searchKnowledgeEmbeddings(projectId, { vector: vectorFor(3), profileFingerprint: FP, limit: 6 });
    const before = packed.find(result => result.item.id === ids[3])!.score;

    await getClient().execute({
      sql: 'UPDATE knowledge_embeddings SET vector = ? WHERE knowledge_item_id = ?',
      args: [JSON.stringify(vectorFor(3)), ids[3]],
    });
    const legacy = await searchKnowledgeEmbeddings(projectId, { vector: vectorFor(3), profileFingerprint: FP, limit: 6 });
    expect(legacy.find(result => result.item.id === ids[3])!.score).toBeCloseTo(before, 5);
  });

  it('falls back to the decoder rather than failing when a stored value is unreadable', async () => {
    const ids = await seed(12);
    // A value no vector function can parse: the row this module used to score as 0 and skip.
    await getClient().execute({
      sql: 'UPDATE knowledge_embeddings SET vector = ? WHERE knowledge_item_id = ?',
      args: ['not a vector at all', ids[5]],
    });

    const trace = traceClient();
    let results;
    try {
      results = await searchKnowledgeEmbeddings(projectId, { vector: vectorFor(1), profileFingerprint: FP, limit: 10 });
    } finally {
      trace.restore();
    }

    // The search still answers, and the unreadable row is simply absent.
    expect(results.length).toBeGreaterThan(0);
    expect(results.map(result => result.item.id)).not.toContain(ids[5]);
    // It got there by trying SQL, failing, and decoding instead.
    expect(trace.seen.some(statement => /e\.vector AS vector/.test(statement.sql))).toBe(true);

    // And the next search on this connection does not repeat the failed statement.
    const second = traceClient();
    try {
      await searchKnowledgeEmbeddings(projectId, { vector: vectorFor(1), profileFingerprint: FP, limit: 10 });
    } finally {
      second.restore();
    }
    expect(second.seen.some(statement => /vector_distance_cos/.test(statement.sql))).toBe(false);

    // The downgrade belongs to that connection and not to the store: repair the row, reopen,
    // and SQL scoring is back. This also keeps the fixture usable for the tests below.
    await getClient().execute({ sql: 'DELETE FROM knowledge_embeddings WHERE knowledge_item_id = ?', args: [ids[5]] });
    await closeDb();
    await initDb(ROOT);

    const third = traceClient();
    try {
      await searchKnowledgeEmbeddings(projectId, { vector: vectorFor(1), profileFingerprint: FP, limit: 10 });
    } finally {
      third.restore();
    }
    expect(third.seen.some(statement => /vector_distance_cos/.test(statement.sql))).toBe(true);
  });

  it('drops a vector that scores zero rather than returning it', async () => {
    const ids = await seed(10);
    await upsertKnowledgeEmbedding({
      projectId, knowledgeItemId: ids[0], provider: 'local', model: 'a/b',
      profileFingerprint: FP, dimensions: DIM, vector: new Array(DIM).fill(0),
    });
    const results = await searchKnowledgeEmbeddings(projectId, { vector: vectorFor(1), profileFingerprint: FP, limit: 10 });
    expect(results.map(result => result.item.id)).not.toContain(ids[0]);
  });

  it('returns nothing for a zero-magnitude query', async () => {
    await seed(5);
    const results = await searchKnowledgeEmbeddings(projectId, {
      vector: new Array(DIM).fill(0), profileFingerprint: FP, limit: 5,
    });
    expect(results).toEqual([]);
  });

  it('pages without losing or repeating a row when scores tie', async () => {
    const client = getClient();
    await client.execute('DELETE FROM knowledge_embeddings');
    await client.execute('DELETE FROM knowledge_items');
    // 80 items sharing one vector: every score is identical, so only the tiebreak keeps
    // OFFSET paging honest. Only one in eight carries the tag, forcing several pages.
    const tagged: string[] = [];
    for (let index = 0; index < 80; index++) {
      const keep = index % 8 === 0;
      const item = await repo.createKnowledgeItem(projectId, {
        category: 'fact', title: `tied ${index}`, content: 'tied body', tags: keep ? ['keep'] : ['other'],
      });
      if (keep) tagged.push(item.id);
      await upsertKnowledgeEmbedding({
        projectId, knowledgeItemId: item.id, provider: 'local', model: 'a/b',
        profileFingerprint: FP, dimensions: DIM, vector: vectorFor(1),
      });
    }

    const results = await searchKnowledgeEmbeddings(projectId, {
      vector: vectorFor(1), profileFingerprint: FP, tags: ['keep'], limit: 10,
    });
    const returned = results.map(result => result.item.id);
    expect(new Set(returned).size).toBe(returned.length);
    expect(returned.every(id => tagged.includes(id))).toBe(true);
    expect(returned).toHaveLength(10);
  });

  it('scores a peer store through the handle it was given', async () => {
    await seed(12);
    const store = localStore();
    const results = await searchKnowledgeEmbeddings(
      projectId, { vector: vectorFor(4), profileFingerprint: FP, limit: 3 }, store,
    );
    expect(results).toHaveLength(3);
    expect(results[0].item.id).toBeTruthy();
  });
});
