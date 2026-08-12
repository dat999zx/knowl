import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalEmbeddingProvider, resetLocalEmbeddingPipeline, resolveModelCache } from '../../src/ai/embeddings.js';
import { knowlHome } from '../../src/workspace/paths.js';
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
    // The reported directory used to be asserted as `<root>/.knowl/models` unconditionally.
    // That assertion is now wrong rather than merely narrow: with nothing on disk anywhere,
    // a fetch lands in the shared machine cache (K-42), and what this callback exists to
    // report is the directory the model will actually be loaded from.
    const seen: Array<{ model: string; cacheDir: string }> = [];
    await createLocalEmbeddingProvider(config(), ROOT, {
      loadPipeline: fakePipeline,
      onFirstLoad: details => seen.push({ model: details.model, cacheDir: details.cacheDir }),
    });
    expect(seen[0].model).toBe(MODEL);
    expect(seen[0].cacheDir).toBe(path.join(knowlHome(), 'models'));
  });
});

describe('embedding model cache location', () => {
  // K-42. Model weights are identical in every repository -- 2,495 MB in one repo here, and
  // two others holding byte-identical 336 MB copies of the same eight files -- so they are
  // machine-local state, not project state.
  const SHARED = path.join(knowlHome(), 'models');

  beforeEach(async () => {
    resetLocalEmbeddingPipeline();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.rm(SHARED, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.rm(SHARED, { recursive: true, force: true }).catch(() => {});
  });

  it('sends a first download to the shared machine cache, not into the repository', async () => {
    const resolved = await resolveModelCache(config(), ROOT);
    expect(resolved).toEqual({ dir: SHARED, present: false });
  });

  it('keeps using a model that is already in this repository, rather than refetching it', async () => {
    // The reason this is resolved and not switched: pointing the constant at the shared
    // location would orphan 2.5 GB and re-download a model already sitting on the disk.
    await fs.mkdir(path.join(ROOT, '.knowl', 'models', ...MODEL.split('/')), { recursive: true });

    const resolved = await resolveModelCache(config(), ROOT);

    expect(resolved).toEqual({ dir: path.join(ROOT, '.knowl', 'models'), present: true });
  });

  it('prefers the shared copy when both exist, so the repository copy can be deleted', async () => {
    await fs.mkdir(path.join(ROOT, '.knowl', 'models', ...MODEL.split('/')), { recursive: true });
    await fs.mkdir(path.join(SHARED, ...MODEL.split('/')), { recursive: true });

    expect((await resolveModelCache(config(), ROOT)).dir).toBe(SHARED);
  });

  it('lets an explicit cacheDir outrank both', async () => {
    // A repository that has deliberately placed its weights somewhere is not second-guessed.
    const explicit = path.join(ROOT, 'elsewhere');
    await fs.mkdir(path.join(SHARED, ...MODEL.split('/')), { recursive: true });
    const withCacheDir = {
      ...config(),
      search: { vector: { ...config().search!.vector!, cacheDir: explicit } },
    } as ProjectConfig;

    expect(await resolveModelCache(withCacheDir, ROOT)).toEqual({ dir: explicit, present: false });

    await fs.mkdir(path.join(explicit, ...MODEL.split('/')), { recursive: true });
    expect(await resolveModelCache(withCacheDir, ROOT)).toEqual({ dir: explicit, present: true });
  });
});
