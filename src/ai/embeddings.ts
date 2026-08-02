import path from 'node:path';
import fsPromises from 'node:fs/promises';
import { ProjectConfig } from '../core/types.js';
import { KnowledgeEmbedder } from '../store/vector-index.js';

/**
 * Chosen by measurement, on the corpus this actually searches.
 *
 * The candidate list is the part that matters. An earlier pass tested five
 * models recalled from memory - all 2021-2023 - and reported a confident
 * winner. Enumerating the registry found 537 plausible ONNX candidates, and the
 * model below beat that "winner" by 72%. A search engine ranks by accumulated
 * popularity, which accumulates with age, so it structurally cannot surface a
 * recent release. Rigor downstream cannot repair a biased candidate list.
 *
 * Measured over the REAL 60k-message transcript archive, 20 known-item queries
 * phrased in words the target message does not use:
 *
 *   ranker                        @1    @3    @10   MRR
 *   BM25 alone                    5%    15%   15%   0.092
 *   semantic alone (this model)   5%    30%   45%   0.230
 *   BM25 + semantic, RRF fused    5%    35%   65%   0.227   <- what ships
 *
 * recall@10 is the metric that matters here, not @1: the consumer is an agent
 * that reads every returned snippet, not a human clicking the first link.
 *
 * On a curated 363-atom corpus the same models score far higher (0.493 for the
 * previous pick) - a proxy corpus flatters everything, so decisions get made on
 * the real one.
 *
 * Changing this is safe: embeddings are keyed by provider+model and searched
 * with that as a filter, so vectors written by a previous model become
 * ineligible rather than being compared across model spaces. It is not FREE -
 * re-embedding 60k messages took ~2.5 hours locally.
 */
const DEFAULT_LOCAL_EMBEDDING_MODEL = 'Snowflake/snowflake-arctic-embed-m-v2.0';
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

/**
 * Retrieval models are trained ASYMMETRICALLY: the query gets an instruction
 * prefix the document does not. Arctic wants `query: `, E5 wants `query: `,
 * Nomic wants `search_query: ` against `search_document: `. Omitting it is the
 * same class of silent mistake as the wrong pooling - the model still returns
 * vectors, they are just measurably worse, and nothing reports a problem.
 *
 * Keyed by model family, overridable in config for a model this does not know.
 */
const QUERY_PREFIXES: Array<[RegExp, string]> = [
  [/arctic-embed-\w*-v2/i, 'query: '],
  [/arctic-embed/i, 'Represent this sentence for searching relevant passages: '],
  [/\be5-|multilingual-e5/i, 'query: '],
  [/nomic-embed|modernbert-embed/i, 'search_query: '],
  [/bge-\w+-en|mxbai-embed/i, 'Represent this sentence for searching relevant passages: '],
];

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
  return /granite|e5-|gte-|arctic|mxbai|bge-\w+-en/i.test(model) ? 'cls' : 'mean';
}

/** The instruction a query carries and a document does not. Empty for symmetric models. */
function queryPrefixFor(model: string | undefined, configured: string | undefined): string {
  if (typeof configured === 'string') return configured;
  if (!model) return '';
  return QUERY_PREFIXES.find(([pattern]) => pattern.test(model))?.[1] ?? '';
}

export function getVectorSearchConfig(config: ProjectConfig) {
  const vector = config.search?.vector;
  return {
    enabled: vector?.enabled === true,
    provider: vector?.provider || 'local',
    model: vector?.model || DEFAULT_LOCAL_EMBEDDING_MODEL,
    dtype: vector?.dtype || DEFAULT_LOCAL_EMBEDDING_DTYPE,
    pooling: poolingFor(vector?.model, vector?.pooling),
    queryPrefix: queryPrefixFor(vector?.model, vector?.queryPrefix),
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
    /**
     * A QUERY, not a document. Separate entry point rather than a flag, because
     * the asymmetry is invisible at the call site otherwise and every caller
     * that forgets it silently loses accuracy instead of failing.
     */
    embedQuery: async (text: string) => {
      const output = await localPipeline!([vector.queryPrefix + text], { pooling: vector.pooling, normalize: true });
      return Array.from(output.data).slice(0, output.dims[output.dims.length - 1]);
    },
  };
}
