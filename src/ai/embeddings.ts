import path from 'node:path';
import { ProjectConfig } from '../core/types.js';
import { KnowledgeEmbedder } from '../store/vector-index.js';

const DEFAULT_LOCAL_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
const DEFAULT_LOCAL_EMBEDDING_DTYPE = 'q8';

type TransformersPipeline = (texts: string[], options: { pooling: 'mean'; normalize: boolean }) => Promise<{
  data: Float32Array | number[];
  dims: number[];
}>;

let localPipeline: TransformersPipeline | null = null;
let localPipelineKey: string | null = null;

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
  projectRoot: string
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
    const transformers = await import('@huggingface/transformers');
    transformers.env.cacheDir = cacheDir;
    localPipeline = await transformers.pipeline('feature-extraction', vector.model, {
      dtype: vector.dtype as any,
    }) as TransformersPipeline;
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
