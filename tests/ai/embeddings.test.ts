import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import {
  createLocalEmbeddingProvider, getVectorSearchConfig, planEmbeddingBatches, resetLocalEmbeddingPipeline,
} from '../../src/ai/embeddings.js';
import type { ProjectConfig } from '../../src/core/types.js';

function config(vector: Record<string, unknown>): ProjectConfig {
  return { version: 1, search: { vector: { enabled: true, ...vector } } } as unknown as ProjectConfig;
}

describe('local embeddings', () => {
  it('reports the first local model load and caches subsequent providers', async () => {
    const onFirstLoad = vi.fn();
    const loadPipeline = vi.fn(async () => async () => ({ data: [1], dims: [1, 1] }));
    const config = {
      ...DEFAULT_CONFIG,
      search: {
        vector: {
          ...DEFAULT_CONFIG.search!.vector!,
          model: 'unit-test-model',
        },
      },
    };
    const root = path.resolve('.knowl-embeddings-test');

    await createLocalEmbeddingProvider(config, root, { loadPipeline, onFirstLoad });
    await createLocalEmbeddingProvider(config, root, { loadPipeline, onFirstLoad });

    expect(loadPipeline).toHaveBeenCalledTimes(1);
    expect(onFirstLoad).toHaveBeenCalledTimes(1);
  });
});

describe('local embedding provider pooling', () => {
  it('passes cls pooling to the pipeline for a cls preset', async () => {
    resetLocalEmbeddingPipeline();
    const seen: Array<{ pooling: string; normalize: boolean }> = [];

    const embedder = await createLocalEmbeddingProvider(
      config({ preset: 'granite-small-en-r2' }),
      '/tmp/knowl-pooling-test',
      {
        loadPipeline: async () => (async (texts: string[], options: any) => {
          seen.push(options);
          return { data: new Float32Array(texts.length * 2).fill(0.5), dims: [texts.length, 2] };
        }) as any,
      },
    );

    await embedder.embed(['hello']);

    expect(seen).toEqual([{ pooling: 'cls', normalize: true }]);
    expect(embedder.pooling).toBe('cls');
  });

  it('passes mean pooling for the historical MiniLM config', async () => {
    resetLocalEmbeddingPipeline();
    const seen: Array<{ pooling: string }> = [];

    const embedder = await createLocalEmbeddingProvider(
      config({ model: 'Xenova/all-MiniLM-L6-v2', dtype: 'q8' }),
      '/tmp/knowl-pooling-test-2',
      {
        loadPipeline: async () => (async (texts: string[], options: any) => {
          seen.push(options);
          return { data: new Float32Array(texts.length * 2).fill(0.5), dims: [texts.length, 2] };
        }) as any,
      },
    );

    await embedder.embed(['hello']);

    expect(seen[0].pooling).toBe('mean');
    expect(embedder.pooling).toBe('mean');
  });

  it('resolves the preset model through getVectorSearchConfig', () => {
    const resolved = getVectorSearchConfig(config({ preset: 'bge-small-en' }));
    expect(resolved.model).toBe('Xenova/bge-small-en-v1.5');
    expect(resolved.pooling).toBe('cls');
  });
});

describe('embedding batch planning', () => {
  /** What attention allocates, in the same units the planner budgets in. */
  const cost = (batch: Array<{ text: string }>) =>
    batch.length * Math.max(...batch.map(entry => entry.text.length)) ** 2;

  it('never plans a batch that can exhaust memory, however many items arrive', () => {
    // The shape that broke it in the field: a whole 500-row reindex page of long items,
    // handed to the model as one forward pass. 498 x 969 tokens asked for 22 GB.
    const texts = Array.from({ length: 498 }, (_, i) => `item ${i} `.padEnd(4_000, 'x'));
    const batches = planEmbeddingBatches(texts);

    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) expect(cost(batch)).toBeLessThanOrEqual(64_000_000);
    // Every item still gets embedded, exactly once.
    expect(batches.flat()).toHaveLength(498);
    expect(new Set(batches.flat().map(entry => entry.index)).size).toBe(498);
  });

  it('packs short texts densely and long ones sparsely', () => {
    const short = planEmbeddingBatches(Array.from({ length: 200 }, () => 'x'.repeat(200)));
    const long = planEmbeddingBatches(Array.from({ length: 200 }, () => 'x'.repeat(4_000)));

    // Cost is driven by the longest text in a batch, since the rest are padded up to it.
    expect(short[0].length).toBeGreaterThan(long[0].length);
    expect(short[0].length).toBeLessThanOrEqual(32);
  });

  it('clips one very long item rather than dropping it or blowing the budget', () => {
    const batches = planEmbeddingBatches(['y'.repeat(500_000), 'short']);

    expect(batches.flat()).toHaveLength(2);
    expect(batches[0][0].text.length).toBe(8_000);
    // The clipped giant travels alone; nothing is padded up to half a megabyte.
    expect(batches[0]).toHaveLength(1);
  });

  it('keeps the caller ordering so vectors line up with their items', () => {
    const texts = Array.from({ length: 100 }, (_, i) => `item ${i}`);
    const flat = planEmbeddingBatches(texts).flat();
    expect(flat.map(entry => entry.index)).toEqual(texts.map((_, i) => i));
  });

  it('handles an empty request', () => {
    expect(planEmbeddingBatches([])).toEqual([]);
  });
});

describe('local embedder batching', () => {
  it('splits one embed() call across forward passes and returns vectors in order', async () => {
    resetLocalEmbeddingPipeline();
    const passes: number[] = [];

    const embedder = await createLocalEmbeddingProvider(
      config({ preset: 'granite-small-en-r2' }),
      '/tmp/knowl-batching-test',
      {
        loadPipeline: async () => (async (texts: string[]) => {
          passes.push(texts.length);
          // One dimension per text, valued by its first character, so ordering is checkable.
          return { data: texts.map(text => text.charCodeAt(0)), dims: [texts.length, 1] };
        }) as any,
      },
    );

    const texts = Array.from({ length: 120 }, (_, i) => String.fromCharCode(65 + (i % 26)).repeat(4_000));
    const vectors = await embedder.embed(texts);

    // Several passes, none of them the whole request.
    expect(passes.length).toBeGreaterThan(1);
    expect(Math.max(...passes)).toBeLessThan(texts.length);
    expect(passes.reduce((sum, n) => sum + n, 0)).toBe(texts.length);

    // One vector per input, still aligned with the input that produced it.
    expect(vectors).toHaveLength(texts.length);
    expect(vectors.map(vector => vector[0])).toEqual(texts.map(text => text.charCodeAt(0)));
  });
});
