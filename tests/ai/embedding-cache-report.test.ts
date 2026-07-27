import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalEmbeddingProvider, resetLocalEmbeddingPipeline } from '../../src/ai/embeddings.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import type { ProjectConfig } from '../../src/core/types.js';

const ROOT = path.resolve('./.knowl-embed-cache-test');
const MODEL = 'Xenova/all-MiniLM-L6-v2';

const config = (): ProjectConfig => ({
  ...DEFAULT_CONFIG,
  search: { vector: { enabled: true, provider: 'local', model: MODEL, dtype: 'q8' } },
} as ProjectConfig);

/** Never touches the network: the pipeline loader is injected. */
const fakePipeline = async () => (async () => ({ data: [0, 0, 0], dims: [1, 3] })) as never;

describe('embedding load reporting', () => {
  beforeEach(async () => {
    resetLocalEmbeddingPipeline();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
  });
  afterEach(async () => {
    resetLocalEmbeddingPipeline();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('reports cached=false when the model is not on disk', async () => {
    const seen: Array<{ cached: boolean }> = [];
    await createLocalEmbeddingProvider(config(), ROOT, {
      loadPipeline: fakePipeline,
      onFirstLoad: details => seen.push({ cached: details.cached }),
    });
    expect(seen).toEqual([{ cached: false }]);
  });

  it('reports cached=true when the model is already on disk', async () => {
    // The bug this pins: `knowl reindex --vectors` announced "Downloading local embedding
    // model" on every run, because the callback fired whenever the pipeline was not in
    // memory -- which is always in a fresh CLI process. Verified by fingerprinting the
    // cache before and after a reindex: nothing was fetched.
    await fs.mkdir(path.join(ROOT, '.knowl', 'models', ...MODEL.split('/')), { recursive: true });

    const seen: Array<{ cached: boolean }> = [];
    await createLocalEmbeddingProvider(config(), ROOT, {
      loadPipeline: fakePipeline,
      onFirstLoad: details => seen.push({ cached: details.cached }),
    });
    expect(seen).toEqual([{ cached: true }]);
  });

  it('still reports the model and cache directory alongside the flag', async () => {
    const seen: Array<{ model: string; cacheDir: string }> = [];
    await createLocalEmbeddingProvider(config(), ROOT, {
      loadPipeline: fakePipeline,
      onFirstLoad: details => seen.push({ model: details.model, cacheDir: details.cacheDir }),
    });
    expect(seen[0].model).toBe(MODEL);
    expect(seen[0].cacheDir).toBe(path.join(ROOT, '.knowl', 'models'));
  });
});
