import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { resetWriteEmbeddingCache } from '../../src/store/write-embedding.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';

const MODEL_CACHE = path.resolve('./.knowl/models');
let root = '';
let projectId = '';

async function setup(vector: Record<string, unknown> | null) {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-writeemb-'));
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.knowl', 'config.json'),
    JSON.stringify({ ...DEFAULT_CONFIG, search: vector ? { vector } : undefined }),
    'utf-8',
  );
  await initDb(root);
  projectId = (await repo.createProject(root, 'write-embedding')).id;
  resetWriteEmbeddingCache();
}

async function embeddingCount(): Promise<number> {
  try {
    return Number((await getClient().execute('SELECT count(*) c FROM knowledge_embeddings')).rows[0].c);
  } catch {
    return 0;
  }
}

describe('write-time vector indexing', () => {
  beforeEach(() => { delete process.env.KNOWL_DISABLE_WRITE_EMBEDDING; });
  afterEach(async () => {
    process.env.KNOWL_DISABLE_WRITE_EMBEDDING = '1';
    resetWriteEmbeddingCache();
    await closeDb();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('indexes a newly written atom when the model is already cached', async () => {
    await setup({ enabled: true, provider: 'local', model: 'Xenova/all-MiniLM-L6-v2', dtype: 'q8', cacheDir: MODEL_CACHE });

    expect(await embeddingCount()).toBe(0);
    const result = await storeKnowledgeItemDeduped(projectId, {
      category: 'decision', title: 'Adopt vector-first retrieval', content: 'Rank by cosine similarity with BM25 as fallback.',
    });

    expect(result.action).toBe('inserted');
    expect(await embeddingCount()).toBe(1);
  }, 120_000);

  it('never blocks a write when vector search is disabled', async () => {
    await setup({ enabled: false });

    const result = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Vectors disabled', content: 'Writes must still succeed with vector search off.',
    });

    expect(result.action).toBe('inserted');
    expect(await embeddingCount()).toBe(0);
  }, 60_000);

  it('skips silently rather than downloading when the model is not cached', async () => {
    await setup({ enabled: true, provider: 'local', model: 'Xenova/all-MiniLM-L6-v2', dtype: 'q8', cacheDir: path.join(os.tmpdir(), 'knowl-no-such-model-cache') });

    const result = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'No model cached', content: 'A first write must not stall on a multi-megabyte download.',
    });

    expect(result.action).toBe('inserted');
    expect(await embeddingCount()).toBe(0);
  }, 60_000);
});
