import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalEmbeddingProvider, resetLocalEmbeddingPipeline } from '../../src/ai/embeddings.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import type { ProjectConfig } from '../../src/core/types.js';

/**
 * #187: federation embeds one query under several profiles, so a process now holds more than one
 * embedder at a time. It could not before — the returned embedder read a single module-level
 * pipeline slot at CALL time, so building a second provider silently repointed the first.
 */

const ROOT = path.resolve('./.knowl-pipeline-cache-test');

const config = (model: string): ProjectConfig => ({
  ...DEFAULT_CONFIG,
  search: { vector: { enabled: true, provider: 'local', model, dtype: 'q8' } },
} as ProjectConfig);

/** A pipeline that reports which model it was built for, so a swap is visible in the output. */
const pipelineFor = (model: string) => async () =>
  (async () => ({ data: [model.length, 0, 0], dims: [1, 3] })) as never;

describe('local embedding pipeline cache', () => {
  beforeEach(async () => {
    resetLocalEmbeddingPipeline();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
  });
  afterEach(async () => {
    resetLocalEmbeddingPipeline();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('keeps each embedder on its own weights after a second profile is built', async () => {
    const first = await createLocalEmbeddingProvider(config('Xenova/all-MiniLM-L6-v2'), ROOT, {
      loadPipeline: pipelineFor('Xenova/all-MiniLM-L6-v2'),
    });
    const second = await createLocalEmbeddingProvider(config('Xenova/bge-small-en-v1.5'), ROOT, {
      loadPipeline: pipelineFor('Xenova/bge-small-en-v1.5'),
    });

    // The regression: `first` answered with `second`'s pipeline once the module slot moved on.
    // Plausible vectors, wrong model, nothing to notice at runtime.
    const [a] = await first.embedQuery('anything');
    const [b] = await second.embedQuery('anything');

    expect(a).toBe('Xenova/all-MiniLM-L6-v2'.length);
    expect(b).toBe('Xenova/bge-small-en-v1.5'.length);
    expect(a).not.toBe(b);
  });

  it('builds one pipeline per profile and reuses it', async () => {
    let builds = 0;
    const counting = (model: string) => async () => {
      builds++;
      return (async () => ({ data: [model.length, 0, 0], dims: [1, 3] })) as never;
    };

    await createLocalEmbeddingProvider(config('Xenova/all-MiniLM-L6-v2'), ROOT, { loadPipeline: counting('a') });
    await createLocalEmbeddingProvider(config('Xenova/all-MiniLM-L6-v2'), ROOT, { loadPipeline: counting('a') });
    expect(builds).toBe(1);

    await createLocalEmbeddingProvider(config('Xenova/bge-small-en-v1.5'), ROOT, { loadPipeline: counting('b') });
    expect(builds).toBe(2);

    // Back to the first profile: served from the map, not rebuilt. This is what stops a mixed
    // workspace thrashing a pipeline build on every federated query.
    await createLocalEmbeddingProvider(config('Xenova/all-MiniLM-L6-v2'), ROOT, { loadPipeline: counting('a') });
    expect(builds).toBe(2);
  });

  it('gives the two profiles different fingerprints, which is what the peer filter keys on', async () => {
    const first = await createLocalEmbeddingProvider(config('Xenova/all-MiniLM-L6-v2'), ROOT, {
      loadPipeline: pipelineFor('a'),
    });
    const second = await createLocalEmbeddingProvider(config('Xenova/bge-small-en-v1.5'), ROOT, {
      loadPipeline: pipelineFor('b'),
    });

    expect(first.profileFingerprint).not.toBe(second.profileFingerprint);
  });
});
