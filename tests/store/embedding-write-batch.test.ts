import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { fingerprintProfile } from '../../src/core/vector-profile.js';
import { upsertKnowledgeEmbedding, upsertKnowledgeEmbeddings } from '../../src/store/vector.js';
import { reindexKnowledgeEmbeddings, type KnowledgeEmbedder } from '../../src/store/vector-index.js';

const ROOT = path.resolve('./.knowl-test-embedding-write-batch');
const FP = fingerprintProfile({ provider: 'local', model: 'a/b', dtype: 'q8', pooling: 'cls' });
const DIM = 4;

let projectId: string;

/** Every statement this connection runs, in order. */
function traceClient() {
  const client: any = getClient();
  const original = client.execute.bind(client);
  const seen: string[] = [];
  client.execute = async (statement: any) => {
    seen.push(typeof statement === 'string' ? statement : statement.sql);
    return original(statement);
  };
  return { seen, restore: () => { client.execute = original; } };
}

const countOf = (seen: string[], pattern: RegExp) => seen.filter(sql => pattern.test(sql)).length;

async function seedItems(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: `item ${index}`, content: `body ${index}`,
    });
    ids.push(item.id);
  }
  return ids;
}

function input(id: string, seed: number) {
  return {
    projectId, knowledgeItemId: id, provider: 'local', model: 'a/b',
    profileFingerprint: FP, dimensions: DIM, vector: [seed, seed + 1, seed + 2, seed + 3],
  };
}

describe('embedding writes commit as a batch', () => {
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'embedding write fixture')).id;
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    await getClient().execute('DELETE FROM knowledge_embeddings');
    await getClient().execute('DELETE FROM knowledge_items');
  });

  it('writes several vectors inside one transaction, not one commit per row', async () => {
    const ids = await seedItems(5);
    const trace = traceClient();
    try {
      await upsertKnowledgeEmbeddings(ids.map((id, index) => input(id, index)));
    } finally {
      trace.restore();
    }

    // The mechanism, not the clock: five rows, one BEGIN, one COMMIT. Every bare statement is
    // its own implicit commit, and this schema fsyncs the WAL on each one.
    expect(countOf(trace.seen, /INSERT INTO knowledge_embeddings/)).toBe(5);
    expect(countOf(trace.seen, /^BEGIN$/)).toBe(1);
    expect(countOf(trace.seen, /^COMMIT$/)).toBe(1);
    expect(trace.seen.indexOf('BEGIN')).toBeLessThan(trace.seen.findIndex(sql => /INSERT INTO knowledge_embeddings/.test(sql)));

    const stored = await getClient().execute('SELECT count(*) AS n FROM knowledge_embeddings');
    expect(Number((stored.rows[0] as any).n)).toBe(5);
  });

  it('leaves a single write on the plain path', async () => {
    const [id] = await seedItems(1);
    const trace = traceClient();
    try {
      await upsertKnowledgeEmbeddings([input(id, 1)]);
    } finally {
      trace.restore();
    }
    // One statement is already atomic and already one fsync; a transaction around it would
    // only add round trips to the path every ordinary knowledge write takes.
    expect(countOf(trace.seen, /INSERT INTO knowledge_embeddings/)).toBe(1);
    expect(countOf(trace.seen, /^BEGIN$/)).toBe(0);
  });

  it('writes nothing when any row in the batch has a bad dimension', async () => {
    const ids = await seedItems(3);
    const bad = { ...input(ids[1], 1), dimensions: DIM + 1 };
    await expect(upsertKnowledgeEmbeddings([input(ids[0], 0), bad, input(ids[2], 2)]))
      .rejects.toThrow(/do not match vector length/);

    const stored = await getClient().execute('SELECT count(*) AS n FROM knowledge_embeddings');
    expect(Number((stored.rows[0] as any).n)).toBe(0);
  });

  it('accepts an empty batch without opening a transaction', async () => {
    const trace = traceClient();
    try {
      await upsertKnowledgeEmbeddings([]);
    } finally {
      trace.restore();
    }
    expect(trace.seen).toEqual([]);
  });

  it('reindex opens one transaction per page rather than one per row', async () => {
    const ids = await seedItems(12);
    const embedder: KnowledgeEmbedder = {
      provider: 'local', model: 'a/b', pooling: 'cls', profileFingerprint: FP,
      embed: async texts => texts.map((_, index) => [index, index + 1, index + 2, index + 3]),
      embedQuery: async () => [1, 2, 3, 4],
    };

    const trace = traceClient();
    let result;
    try {
      result = await reindexKnowledgeEmbeddings(projectId, embedder);
    } finally {
      trace.restore();
    }

    expect(result.indexed).toBe(ids.length);
    expect(countOf(trace.seen, /INSERT INTO knowledge_embeddings/)).toBe(ids.length);
    // One page of 500 covers all twelve, so exactly one transaction -- and crucially not twelve.
    expect(countOf(trace.seen, /^BEGIN$/)).toBe(1);
    expect(countOf(trace.seen, /^COMMIT$/)).toBe(1);
  });

  it('still upserts one row at a time through the single-row entry point', async () => {
    const [id] = await seedItems(1);
    await upsertKnowledgeEmbedding(input(id, 7));
    await upsertKnowledgeEmbedding({ ...input(id, 9) });
    const stored = await getClient().execute('SELECT dimensions FROM knowledge_embeddings WHERE knowledge_item_id = ?', [id]);
    expect(stored.rows).toHaveLength(1);
  });
});
