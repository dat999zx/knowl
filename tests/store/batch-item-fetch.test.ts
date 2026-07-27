import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { initDb, closeDb, getClient } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { decodeVector, searchKnowledgeEmbeddings, upsertKnowledgeEmbedding } from '../../src/store/vector.js';

const TEST_ROOT = path.resolve('./.knowl-test-batch-fetch');

async function seed(projectId: string, title: string, vector: number[], status?: 'active' | 'rejected') {
  const item = await repo.createKnowledgeItem(projectId, { category: 'fact', title, content: `${title} body` });
  if (status) await repo.updateKnowledgeItem(item.id, { status } as any);
  await upsertKnowledgeEmbedding({
    knowledgeItemId: item.id,
    provider: 'test',
    model: 'test-model',
    dimensions: vector.length,
    vector,
  });
  return item;
}

describe('batch item fetch', () => {
  let projectId: string;

  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
    const project = await repo.createProject(TEST_ROOT, 'batch fetch fixture');
    projectId = project.id;
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('returns every requested item keyed by id, and omits unknown ids', async () => {
    const first = await repo.createKnowledgeItem(projectId, { category: 'fact', title: 'alpha', content: 'a' });
    const second = await repo.createKnowledgeItem(projectId, { category: 'decision', title: 'beta', content: 'b' });

    const found = await repo.getKnowledgeItems([first.id, second.id, 'does-not-exist']);

    expect(found.size).toBe(2);
    expect(found.get(first.id)?.title).toBe('alpha');
    expect(found.get(second.id)?.title).toBe('beta');
    expect(found.has('does-not-exist')).toBe(false);
  });

  it('returns an empty map for no ids without querying', async () => {
    expect((await repo.getKnowledgeItems([])).size).toBe(0);
  });
});

describe('vector search after scoring is decoupled from fetching', () => {
  let projectId: string;

  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
    const project = await repo.createProject(TEST_ROOT, 'vector fixture');
    projectId = project.id;
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('orders by similarity and honours the limit', async () => {
    await seed(projectId, 'exact', [1, 0, 0]);
    await seed(projectId, 'near', [0.9, 0.1, 0]);
    await seed(projectId, 'far', [0, 1, 0]);

    const results = await searchKnowledgeEmbeddings(projectId, {
      vector: [1, 0, 0],
      provider: 'test',
      model: 'test-model',
      limit: 2,
    });

    expect(results.map(result => result.item.title)).toEqual(['exact', 'near']);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('applies the status filter after scoring, so a rejected top match is excluded', async () => {
    // The rejected item is the *closest* vector. Filtering happens after scoring now, so this
    // guards against the batching change accidentally returning it or dropping the next best.
    await seed(projectId, 'rejected-best', [1, 0, 0], 'rejected');
    await seed(projectId, 'active-second', [0.8, 0.2, 0]);

    const results = await searchKnowledgeEmbeddings(projectId, {
      vector: [1, 0, 0],
      provider: 'test',
      model: 'test-model',
      limit: 5,
    });

    const titles = results.map(result => result.item.title);
    expect(titles).not.toContain('rejected-best');
    expect(titles).toContain('active-second');
  });

  it('still reads vectors written in the legacy JSON-text encoding', async () => {
    // Rows written before vectors were packed as float32 BLOBs are plain JSON text. SQLite keeps
    // both storage classes in one column, so no migration runs and old rows must keep working
    // until something reindexes them.
    const legacy = await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'legacy encoded',
      content: 'stored as json text',
    });
    await getClient().execute({
      sql: `INSERT INTO knowledge_embeddings (knowledge_item_id, provider, model, dimensions, vector, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [legacy.id, 'test', 'test-model', 3, JSON.stringify([0, 1, 0]), new Date().toISOString()],
    });

    const results = await searchKnowledgeEmbeddings(projectId, {
      vector: [0, 1, 0],
      provider: 'test',
      model: 'test-model',
      limit: 3,
    });

    const legacyHit = results.find(result => result.item.id === legacy.id);
    expect(legacyHit).toBeDefined();
    expect(legacyHit!.score).toBeCloseTo(1, 5);
  });

  it('decodes both encodings to the same vector', () => {
    const packed = Float32Array.from([0.5, -0.25, 0.125]);
    const asBlob = new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength);

    expect(decodeVector(asBlob)).toEqual([0.5, -0.25, 0.125]);
    expect(decodeVector(JSON.stringify([0.5, -0.25, 0.125]))).toEqual([0.5, -0.25, 0.125]);
    expect(decodeVector('not json')).toBeNull();
  });

  it('scores identical vectors as more similar than orthogonal ones', async () => {
    await seed(projectId, 'aligned', [0, 0, 1]);

    const results = await searchKnowledgeEmbeddings(projectId, {
      vector: [0, 0, 1],
      provider: 'test',
      model: 'test-model',
      limit: 1,
    });

    expect(results[0].item.title).toBe('aligned');
    expect(results[0].score).toBeCloseTo(1, 5);
  });
});
