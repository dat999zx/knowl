import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import {
  createLocalEmbeddingProvider, getVectorSearchConfig, resetLocalEmbeddingPipeline,
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
