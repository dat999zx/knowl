import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createLocalEmbeddingProvider, EMBEDDING_LIMITS, planEmbeddingBatches, resetLocalEmbeddingPipeline,
} from '../../src/ai/embeddings.js';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { reindexKnowledgeEmbeddings, type KnowledgeEmbedder } from '../../src/store/vector-index.js';
import type { ProjectConfig } from '../../src/core/types.js';

function config(): ProjectConfig {
  return {
    version: 1,
    search: { vector: { enabled: true, provider: 'local', model: 'unit/test-model', dtype: 'q8', pooling: 'cls', cacheDir: '/tmp/knowl-determinism' } },
  } as unknown as ProjectConfig;
}

/**
 * A pipeline that quantises per batch, the way the real q8 graph does: every output depends on
 * the longest text sharing the forward pass. It is a caricature of the mechanism, and it is the
 * mechanism -- a text embedded alone and the same text embedded beside a longer one differ.
 */
function batchSensitivePipeline() {
  return async (texts: string[]) => {
    const widest = Math.max(...texts.map(text => text.length));
    const data: number[] = [];
    for (const text of texts) {
      data.push(text.length / 100, widest / 100);
    }
    return { data, dims: [texts.length, 2] };
  };
}

describe('an atom vector does not depend on its neighbours', () => {
  it('plans one forward pass per text when asked for maxBatch 1', () => {
    const texts = Array.from({ length: 40 }, (_, index) => `short ${index}`);
    const planned = planEmbeddingBatches(texts);
    const alone = planEmbeddingBatches(texts, { maxBatch: 1 });

    // The default really does batch these -- otherwise the option would be proving nothing.
    expect(Math.max(...planned.map(batch => batch.length))).toBeGreaterThan(1);
    expect(alone).toHaveLength(texts.length);
    for (const batch of alone) expect(batch).toHaveLength(1);
    // Every text still arrives exactly once, carrying the index that puts it back in order.
    expect(alone.flat().map(entry => entry.index).sort((a, b) => a - b)).toEqual(texts.map((_, index) => index));
  });

  it('still clips a long text when batching is off', () => {
    const [[entry]] = planEmbeddingBatches(['word '.repeat(20_000)], { maxBatch: 1 });
    expect(entry.text.length).toBeLessThan('word '.repeat(20_000).length);
  });

  it('cannot be used to ask for a bigger batch than the memory bound allows', () => {
    const texts = Array.from({ length: 200 }, () => 'x');
    const batches = planEmbeddingBatches(texts, { maxBatch: 1_000 });
    expect(Math.max(...batches.map(batch => batch.length))).toBeLessThanOrEqual(EMBEDDING_LIMITS.maxBatch);
  });

  it('returns the same vector for a text whether it is embedded alone or with others', async () => {
    resetLocalEmbeddingPipeline();
    const embedder = await createLocalEmbeddingProvider(config(), '/tmp/knowl-determinism', {
      loadPipeline: async () => batchSensitivePipeline() as any,
    });

    const texts = ['a short one', 'another short one', 'a third, which is a good deal longer than the others'];
    const [aloneFirst] = await embedder.embed([texts[0]], { maxBatch: 1 });
    const together = await embedder.embed(texts, { maxBatch: 1 });
    expect(together[0]).toEqual(aloneFirst);

    // And the default path is where they diverge, which is what this option exists to avoid.
    const batched = await embedder.embed(texts);
    expect(batched[0]).not.toEqual(aloneFirst);
  });

  it('reindex asks for one text per forward pass', async () => {
    const root = path.resolve('./.knowl-test-embedding-determinism');
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
    await initDb(root);
    const projectId = (await repo.createProject(root, 'determinism fixture')).id;
    for (let index = 0; index < 6; index++) {
      await repo.createKnowledgeItem(projectId, { category: 'fact', title: `t${index}`, content: 'short body' });
    }

    const seen: Array<{ count: number; maxBatch?: number }> = [];
    const embedder: KnowledgeEmbedder = {
      provider: 'local', model: 'unit/test-model', pooling: 'cls', profileFingerprint: 'fp',
      embed: async (texts, options) => {
        seen.push({ count: texts.length, maxBatch: options?.maxBatch });
        return texts.map(() => [1, 0, 0]);
      },
      embedQuery: async () => [1, 0, 0],
    };

    await reindexKnowledgeEmbeddings(projectId, embedder);
    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) expect(call.maxBatch).toBe(1);

    await closeDb();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('write-time indexing asks for one text per forward pass', async () => {
    const root = path.resolve('./.knowl-test-embedding-determinism-write');
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
    await initDb(root);
    const projectId = (await repo.createProject(root, 'determinism write fixture')).id;
    const items = [];
    for (let index = 0; index < 4; index++) {
      items.push(await repo.createKnowledgeItem(projectId, { category: 'fact', title: `w${index}`, content: 'short body' }));
    }

    // The module builds its own embedder from config and imports the AI layer lazily, so the
    // seam is that import. Nothing here reaches a real model.
    const seen: Array<number | undefined> = [];
    vi.doMock('../../src/ai/embeddings.js', () => ({
      isVectorSearchEnabled: () => true,
      resolveModelCache: async () => ({ dir: path.join(root, 'models'), present: true }),
      createLocalEmbeddingProvider: async () => ({
        provider: 'local', model: 'unit/test-model', pooling: 'cls', profileFingerprint: 'fp',
        embed: async (texts: string[], options?: { maxBatch?: number }) => {
          seen.push(options?.maxBatch);
          return texts.map(() => [1, 0, 0]);
        },
        embedQuery: async () => [1, 0, 0],
      }),
    }));

    try {
      await fs.writeFile(path.join(root, '.knowl', 'config.json'), JSON.stringify({
        version: 1,
        search: { vector: { enabled: true, provider: 'local', model: 'unit/test-model', dtype: 'q8', pooling: 'cls' } },
      }));
      const { indexKnowledgeItemsBestEffort, resetWriteEmbeddingCache } = await import('../../src/store/write-embedding.js');
      resetWriteEmbeddingCache();
      delete process.env.KNOWL_DISABLE_WRITE_EMBEDDING;

      await indexKnowledgeItemsBestEffort(projectId, items);
      // Four items in one write is exactly the case that used to batch, and so exactly the
      // case whose vectors disagreed with the ones a reindex produced.
      expect(seen).toEqual([1]);
    } finally {
      vi.doUnmock('../../src/ai/embeddings.js');
      process.env.KNOWL_DISABLE_WRITE_EMBEDDING = '1';
      const { resetWriteEmbeddingCache } = await import('../../src/store/write-embedding.js');
      resetWriteEmbeddingCache();
      await closeDb();
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('leaves the transcript path batching, where batching is the whole win', () => {
    // 2,000 transcript-sized messages: unchanged by this option's existence.
    const messages = Array.from({ length: 2_000 }, (_, index) => `line ${index}: a short turn in a conversation.`);
    const batches = planEmbeddingBatches(messages);
    expect(Math.max(...batches.map(batch => batch.length))).toBe(EMBEDDING_LIMITS.maxBatch);
  });
});
