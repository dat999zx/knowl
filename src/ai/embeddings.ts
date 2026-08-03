import path from 'node:path';
import fsPromises from 'node:fs/promises';
import { ProjectConfig } from '../core/types.js';
import { KnowledgeEmbedder } from '../store/vector-index.js';
import { fingerprintProfile, resolveVectorProfile, type VectorPooling } from '../core/vector-profile.js';
import { noteModelLoad } from '../core/startup-trace.js';

type TransformersPipeline = (texts: string[], options: { pooling: VectorPooling; normalize: boolean }) => Promise<{
  data: Float32Array | number[];
  dims: number[];
}>;

/**
 * The most characters of one item that get embedded.
 *
 * Attention is quadratic in sequence length, so a single very long item is expensive on
 * its own however small the batch. ~8k characters is roughly 2k tokens, which is past the
 * point where more text sharpens a knowledge atom's vector.
 */
const MAX_EMBED_CHARS = 8_000;

/** Most items in one forward pass, whatever the arithmetic below allows. */
const MAX_EMBED_BATCH = 32;

/**
 * Budget for `items × longest²`, in characters.
 *
 * Attention allocates `batch × heads × seq × seq`, so cost is driven by the longest text
 * in a batch, not the average -- everything shorter is padded up to it. At this budget a
 * batch peaks around 200 MB.
 */
const ATTENTION_BUDGET = 64_000_000;

/**
 * Group texts into forward passes that cannot exhaust memory.
 *
 * Sizing by item count alone is what broke: reindex handed over a 500-row database page
 * as one batch, and against a model with a large context window -- where nothing gets
 * truncated -- 498 items of ~969 tokens asked onnxruntime for 22 GB in a single
 * allocation. The batch has to be sized against the text, not the row count.
 *
 * Indices are carried through so results can be written back in the caller's order.
 */
export function planEmbeddingBatches(texts: string[]): Array<Array<{ index: number; text: string }>> {
  const batches: Array<Array<{ index: number; text: string }>> = [];
  let current: Array<{ index: number; text: string }> = [];
  let longest = 0;

  for (let index = 0; index < texts.length; index++) {
    const text = (texts[index] ?? '').slice(0, MAX_EMBED_CHARS);
    const nextLongest = Math.max(longest, text.length);
    const wouldExceed = (current.length + 1) * nextLongest * nextLongest > ATTENTION_BUDGET;

    // `current.length > 0` keeps a single over-budget text as its own batch rather than
    // dropping it: it is already clipped to MAX_EMBED_CHARS, so one is affordable.
    if (current.length > 0 && (wouldExceed || current.length >= MAX_EMBED_BATCH)) {
      batches.push(current);
      current = [];
      longest = 0;
    }

    current.push({ index, text });
    longest = Math.max(longest, text.length);
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

export interface LocalEmbeddingProviderOptions {
  loadPipeline?: (model: string, dtype: string, cacheDir: string) => Promise<TransformersPipeline>;
  /**
   * Fires when the pipeline has to be built, which is every fresh process -- not only when
   * something is fetched. `cached` distinguishes the two, because a caller that announces
   * "Downloading..." on every run is describing work that is not happening.
   */
  onFirstLoad?: (details: { model: string; cacheDir: string; cached: boolean }) => void;
}

let localPipeline: TransformersPipeline | null = null;
let localPipelineKey: string | null = null;

/** Drop the in-process pipeline. Tests need it; nothing in the product does. */
export function resetLocalEmbeddingPipeline(): void {
  localPipeline = null;
  localPipelineKey = null;
}

export function isVectorSearchEnabled(config: ProjectConfig): boolean {
  return config.search?.vector?.enabled === true;
}

export function getVectorSearchConfig(config: ProjectConfig) {
  const profile = resolveVectorProfile(config);
  return {
    enabled: config.search?.vector?.enabled === true,
    provider: profile.provider,
    model: profile.model,
    dtype: profile.dtype,
    pooling: profile.pooling,
    cacheDir: config.search?.vector?.cacheDir,
  };
}

export async function createLocalEmbeddingProvider(
  config: ProjectConfig,
  projectRoot: string,
  options: LocalEmbeddingProviderOptions = {}
): Promise<KnowledgeEmbedder> {
  const vector = getVectorSearchConfig(config);
  if (!vector.enabled) {
    throw new Error('Vector search is not enabled. Set search.vector.enabled to true first.');
  }
  if (vector.provider !== 'local') {
    throw new Error(`Unsupported vector provider: ${vector.provider}`);
  }

  const cacheDir = vector.cacheDir || path.join(projectRoot, '.knowl', 'models');
  const pipelineKey = `${vector.model}:${vector.dtype}:${vector.pooling}:${cacheDir}`;

  if (!localPipeline || localPipelineKey !== pipelineKey) {
    // Whether the weights are already on disk, so a caller can say "loading" rather than
    // "downloading". Same location write-time embedding checks before deciding it can embed.
    const cached = await fsPromises.access(path.join(cacheDir, ...vector.model.split('/')))
      .then(() => true)
      .catch(() => false);
    options.onFirstLoad?.({ model: vector.model, cacheDir, cached });
    // How long building the pipeline actually costs, recorded rather than assumed. The model
    // was blamed for stalls it cannot cause -- serve never loads one during startup -- and the
    // only way that claim gets settled is a number per process, per model, cold and warm.
    const loadStartedAt = Date.now();
    if (options.loadPipeline) {
      localPipeline = await options.loadPipeline(vector.model, vector.dtype, cacheDir);
    } else {
      const transformers = await import('@huggingface/transformers');
      transformers.env.cacheDir = cacheDir;
      localPipeline = await transformers.pipeline('feature-extraction', vector.model, {
        dtype: vector.dtype as any,
      }) as TransformersPipeline;
    }
    noteModelLoad(vector.model, cached, Date.now() - loadStartedAt);
    localPipelineKey = pipelineKey;
  }

  return {
    provider: 'local',
    model: vector.model,
    pooling: vector.pooling,
    profileFingerprint: fingerprintProfile(resolveVectorProfile(config)),
    embed: async (texts: string[]) => {
      const vectors: number[][] = [];
      for (const batch of planEmbeddingBatches(texts)) {
        const output = await localPipeline!(batch.map(entry => entry.text), {
          // Per-model, not a constant: MiniLM is mean-pooled while both Granite R2
          // models and BGE are CLS-pooled. Using the wrong one produces plausible
          // vectors that rank badly, with nothing to notice at runtime.
          pooling: vector.pooling,
          normalize: true,
        });
        const dimensions = output.dims[1];
        const data = Array.from(output.data) as number[];
        batch.forEach((entry, index) => {
          vectors[entry.index] = data.slice(index * dimensions, (index + 1) * dimensions);
        });
      }
      return vectors;
    },
  };
}
