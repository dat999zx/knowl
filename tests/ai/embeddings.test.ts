import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { createLocalEmbeddingProvider } from '../../src/ai/embeddings.js';

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
