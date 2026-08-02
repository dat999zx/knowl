import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { createLocalEmbeddingProvider, getVectorSearchConfig, resetLocalEmbeddingPipeline } from '../../src/ai/embeddings.js';

const withModel = (model?: string, pooling?: 'mean' | 'cls') => ({
  ...DEFAULT_CONFIG,
  search: { vector: { ...DEFAULT_CONFIG.search!.vector!, model, pooling } },
});

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

  // Pooling is part of the model, not a preference. Granite run with mean
  // pooling scored MRR 0.337 on our eval corpus against 0.750 with CLS - the
  // same weights performing worse than the model it replaces, from one wrong
  // string, with nothing anywhere reporting a problem.
  it('defaults pooling to what the model family was trained for', () => {
    expect(getVectorSearchConfig(withModel('onnx-community/granite-embedding-small-english-r2-ONNX')).pooling).toBe('cls');
    expect(getVectorSearchConfig(withModel('intfloat/e5-small-v2')).pooling).toBe('cls');
    expect(getVectorSearchConfig(withModel('Snowflake/snowflake-arctic-embed-m-v2.0')).pooling).toBe('cls');
    // BGE documents CLS, and on our own corpus the two measured a tie (0.428 vs
    // 0.426), so the model card wins where measurement cannot separate them.
    expect(getVectorSearchConfig(withModel('Xenova/bge-small-en-v1.5')).pooling).toBe('cls');
    expect(getVectorSearchConfig(withModel('Xenova/all-MiniLM-L6-v2')).pooling).toBe('mean');
  });

  it('gives a query the instruction prefix its model family expects, and a document none', async () => {
    // Retrieval models are asymmetric. Sending a bare query to one trained with
    // `query: ` costs accuracy silently — the same failure shape as wrong pooling.
    resetLocalEmbeddingPipeline();
    const calls: string[][] = [];
    const provider = await createLocalEmbeddingProvider(
      withModel('Snowflake/snowflake-arctic-embed-m-v2.0'),
      path.resolve('.knowl-embeddings-test'),
      { loadPipeline: async () => (async (texts: string[]) => { calls.push(texts); return { data: [1, 0], dims: [1, 2] }; }) as any },
    );

    await provider.embed(['a stored document']);
    await provider.embedQuery!('a search');

    expect(calls[0]).toEqual(['a stored document']);
    expect(calls[1]).toEqual(['query: a search']);
  });

  it('lets config override the family default, since the mapping cannot know every model', () => {
    expect(getVectorSearchConfig(withModel('Xenova/bge-small-en-v1.5', 'cls')).pooling).toBe('cls');
    expect(getVectorSearchConfig(withModel('some/granite-shaped-name', 'mean')).pooling).toBe('mean');
  });

  it('passes the resolved pooling to the pipeline rather than a hardcoded one', async () => {
    resetLocalEmbeddingPipeline();
    const embedCall = vi.fn(async () => ({ data: [1, 0], dims: [1, 2] }));
    const provider = await createLocalEmbeddingProvider(
      withModel('onnx-community/granite-embedding-small-english-r2-ONNX'),
      path.resolve('.knowl-embeddings-test'),
      { loadPipeline: async () => embedCall as any },
    );
    await provider.embed(['anything']);

    expect(embedCall).toHaveBeenCalledWith(['anything'], expect.objectContaining({ pooling: 'cls' }));
  });
});
