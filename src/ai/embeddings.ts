import path from 'node:path';
import fsPromises from 'node:fs/promises';
import { ProjectConfig } from '../core/types.js';
import { KnowledgeEmbedder } from '../store/vector-index.js';

const DEFAULT_LOCAL_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
const DEFAULT_LOCAL_EMBEDDING_DTYPE = 'q8';

type TransformersPipeline = (texts: string[], options: { pooling: 'mean'; normalize: boolean }) => Promise<{
  data: Float32Array | number[];
  dims: number[];
}>;

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
  const vector = config.search?.vector;
  return {
    enabled: vector?.enabled === true,
    provider: vector?.provider || 'local',
    model: vector?.model || DEFAULT_LOCAL_EMBEDDING_MODEL,
    dtype: vector?.dtype || DEFAULT_LOCAL_EMBEDDING_DTYPE,
    cacheDir: vector?.cacheDir,
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
  const pipelineKey = `${vector.model}:${vector.dtype}:${cacheDir}`;

  if (!localPipeline || localPipelineKey !== pipelineKey) {
    // Whether the weights are already on disk, so a caller can say "loading" rather than
    // "downloading". Same location write-time embedding checks before deciding it can embed.
    const cached = await fsPromises.access(path.join(cacheDir, ...vector.model.split('/')))
      .then(() => true)
      .catch(() => false);
    options.onFirstLoad?.({ model: vector.model, cacheDir, cached });
    if (options.loadPipeline) {
      localPipeline = await options.loadPipeline(vector.model, vector.dtype, cacheDir);
    } else {
      const transformers = await import('@huggingface/transformers');
      transformers.env.cacheDir = cacheDir;
      localPipeline = await transformers.pipeline('feature-extraction', vector.model, {
        dtype: vector.dtype as any,
      }) as TransformersPipeline;
    }
    localPipelineKey = pipelineKey;
  }

  return {
    provider: 'local',
    model: vector.model,
    embed: async (texts: string[]) => {
      const output = await localPipeline!(texts, {
        pooling: 'mean',
        normalize: true,
      });
      const dimensions = output.dims[1];
      const data = Array.from(output.data);

      return texts.map((_, index) => {
        const start = index * dimensions;
        return data.slice(start, start + dimensions);
      });
    },
  };
}
