import path from 'node:path';
import fsPromises from 'node:fs/promises';
import { ProjectConfig } from '../core/types.js';
import { KnowledgeEmbedder } from '../store/vector-index.js';

/**
 * Chosen by measurement on a real corpus, not by leaderboard rank.
 *
 * Scored against project atoms with 17 queries phrased the way someone
 * half-remembers a thing. Every row below is from ONE session on ONE corpus
 * snapshot, because the baseline moves: bge-small scored MRR 0.662 one day and
 * 0.621 the next on a corpus that had grown by ~16 atoms, which is larger than
 * some of the gaps being judged.
 *
 *   granite-embedding-small-english-r2  @1 59%  @3 94%  MRR 0.750  <- chosen
 *   bge-small-en-v1.5                   @1 53%  @3 65%  MRR 0.621
 *   granite-embedding-97m-multilingual-r2  @1 47%  @3 76%  MRR 0.643
 *   all-MiniLM-L6-v2                    @1 29%  @3 53%  MRR 0.465
 *
 * Granite's English model finds the right atom in the top three 94% of the
 * time against bge-small's 65% - five more queries out of seventeen - for
 * about 1.3x the embedding cost. Its multilingual sibling of triple the size
 * is NOT better here: it carries 200+ languages of capacity through an
 * all-English corpus and lands inside the noise floor.
 *
 * Neither leaderboards nor parameter count predicted any of this. MTEB rank
 * would have picked all-MiniLM-L12-v2, which measured slower AND less accurate,
 * and bge-base's q8 export returns degenerate rankings (18% at every k).
 *
 * Changing this is safe: embeddings are keyed by provider+model and searched
 * with that as a filter, so vectors written by a previous model become
 * ineligible rather than being compared across model spaces.
 */
const DEFAULT_LOCAL_EMBEDDING_MODEL = 'onnx-community/granite-embedding-small-english-r2-ONNX';
const DEFAULT_LOCAL_EMBEDDING_DTYPE = 'q8';

/**
 * Pooling is part of the model, not a preference.
 *
 * Granite is trained for CLS. Run it with mean - the setting its predecessor
 * wanted - and the SAME weights on the SAME corpus score MRR 0.337 instead of
 * 0.750. That is a worse result than the model this replaces, from a model that
 * beats it, produced by one wrong string. So it travels with the model default
 * rather than being assumed, and config can override it per model.
 */
const DEFAULT_LOCAL_EMBEDDING_POOLING: PoolingMode = 'cls';

export type PoolingMode = 'mean' | 'cls';

type TransformersPipeline = (texts: string[], options: { pooling: PoolingMode; normalize: boolean }) => Promise<{
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

/**
 * The pooling a model was trained for, unless config says otherwise.
 *
 * A config that names a model but not its pooling is the common case, and
 * silently applying the wrong one costs more accuracy than the model choice
 * gained. So the mapping is explicit and the default follows the family: BGE
 * and MiniLM are trained for mean, Granite and E5 for CLS. An unrecognised
 * model keeps mean, which is what the majority of small sentence encoders on
 * the hub expect.
 */
function poolingFor(model: string | undefined, configured: string | undefined): PoolingMode {
  if (configured === 'cls' || configured === 'mean') return configured;
  if (!model) return DEFAULT_LOCAL_EMBEDDING_POOLING;
  return /granite|e5-|gte-multilingual/i.test(model) ? 'cls' : 'mean';
}

export function getVectorSearchConfig(config: ProjectConfig) {
  const vector = config.search?.vector;
  return {
    enabled: vector?.enabled === true,
    provider: vector?.provider || 'local',
    model: vector?.model || DEFAULT_LOCAL_EMBEDDING_MODEL,
    dtype: vector?.dtype || DEFAULT_LOCAL_EMBEDDING_DTYPE,
    pooling: poolingFor(vector?.model, vector?.pooling),
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
    // One text per forward pass, whatever the caller hands over.
    //
    // Two reasons, both measured. A batch pads every sequence to its longest
    // member, and real corpora are not uniform: on a real transcript queue
    // (median 169 chars, max 2,000) batches of 16 ran at 198 ms/doc against
    // 42 ms/doc one at a time. Batching here was 4.7x SLOWER than not batching.
    //
    // And a long-context model makes it fatal rather than slow. Granite R2
    // builds a global attention mask sized by the longest sequence in the
    // batch, so passing all 363 knowledge atoms in one call - which
    // reindexKnowledgeEmbeddings did - asked onnxruntime for a 52 GB buffer and
    // killed the process. Enforced here rather than at each call site, because
    // every caller that batches is one model change away from that crash.
    embed: async (texts: string[]) => {
      const vectors: number[][] = [];
      for (const text of texts) {
        const output = await localPipeline!([text], { pooling: vector.pooling, normalize: true });
        vectors.push(Array.from(output.data).slice(0, output.dims[output.dims.length - 1]));
      }
      return vectors;
    },
  };
}
