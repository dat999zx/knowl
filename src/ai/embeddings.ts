import path from 'node:path';
import fsPromises from 'node:fs/promises';
import { ProjectConfig } from '../core/types.js';
import { EmbedOptions, KnowledgeEmbedder } from '../store/vector-index.js';
import { fingerprintProfile, relevanceFloorFor, resolveVectorProfile, type VectorPooling } from '../core/vector-profile.js';
import { noteModelLoad } from '../core/startup-trace.js';
import { knowlHome } from '../core/paths.js';

type TransformersPipeline = (texts: string[], options: { pooling: VectorPooling; normalize: boolean }) => Promise<{
  data: Float32Array | number[];
  dims: number[];
}>;

/**
 * A cheap upper bound on how much text is worth looking at, applied before the tokeniser
 * estimate below so a pathological input never pays for a scan of itself. Not the real
 * limit -- `MAX_EMBED_TOKENS` is -- because characters are not what costs anything.
 */
const MAX_EMBED_CHARS = 8_000;

/** Most items in one forward pass, whatever the arithmetic below allows. */
const MAX_EMBED_BATCH = 32;

/**
 * The most tokens of one item that get embedded, and the real memory ceiling.
 *
 * Attention allocates `batch Ã— heads Ã— seq Ã— seq`, so the largest single allocation this
 * module can ever request is one clipped item on its own: arctic-embed-m-v2 has 12 heads
 * and fp32 scores, giving `2,048Â² Ã— 12 Ã— 4 bytes â‰ˆ 201 MB`. Nothing else here can exceed
 * that, because the batch budget below is far smaller.
 *
 * A CHARACTER clip cannot make that promise. The old limit was 8,000 characters, justified
 * in a comment as "roughly 2k tokens" -- true of English prose and wrong by 3x of the paths,
 * JSON and code that knowledge atoms are full of. Measured with arctic's own tokeniser,
 * 8,000 characters is 1,925 tokens of English and 6,283 of JSON, and the second one asks
 * for 1.8 GB in a single forward pass.
 *
 * **2,048 rather than 2,560 since 2026-08-12, and it is a PARITY decision rather than a tuning
 * one.** `knowl-cloud` clips here too, and a client-supplied vector is interchangeable with a
 * server-supplied one only if the cut is identical as well as the text -- see
 * `src/core/embed-recipe.ts`. 2,048 was chosen over raising the server to 2,560 because a
 * forward pass is priced by tokens and both sides pay it on every embed forever, where the
 * re-clip is once.
 *
 * The cost of the change, stated because it is not nothing: over the 470 real atoms measured
 * above (p99 1,808 estimated tokens, longest 2,085), 2,560 clipped none and 2,048 clips the
 * longest one. Every store built before this is stale for atoms in that range -- safe only
 * because `fingerprintProfile` hashes `EMBED_RECIPE_VERSION`, so those rows stop matching and
 * `knowl reindex --vectors` repairs them without `--force`.
 */
const MAX_EMBED_TOKENS = 2_048;

/**
 * Budget for `items Ã— longestÂ²`, in TOKENS. A THROUGHPUT bound, not the memory one.
 *
 * Batching an embedding model is not free parallelism: on CPU one 500-token sequence
 * already saturates the cores, so a batch adds padding and cache pressure and buys nothing.
 * Measured on arctic q8 with equal-length real prose, per-item cost against n=1:
 * 45 tokens 1.41x FASTER at n=32, 128 tokens 1.28x faster, 256 tokens best at n=1,
 * 512 tokens best at n=1. The crossover is around 256 tokens, and `256Â²` is the budget
 * that puts it there: 32 items at 45 tokens, 4 at 128, 1 above 256.
 *
 * That is the inversion this constant needed. In characters at 64,000,000 the budget bound
 * only above ~1,414 characters -- inert for transcript messages (p50 148 chars), where
 * batching is the whole win, and binding for atoms (p50 1,737 chars), where it is a loss.
 * On 48 real atoms through the real model: 16.1s for the old plan against 4.7s embedding
 * them one at a time, and 4.8s here. Batching atoms stopped costing anything, and the
 * 32-item batch that makes short transcript messages 2.7x faster is untouched.
 */
const ATTENTION_BUDGET = 256 * 256;

/** Letters, digits and single symbols -- see `estimateTokens`. */
const TOKEN_SEGMENT = /[A-Za-z]+|[0-9]+|[^\sA-Za-z0-9]/g;

function segmentTokens(segment: string): number {
  const first = segment.charCodeAt(0);
  if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) return Math.ceil(segment.length / 4);
  if (first >= 48 && first <= 57) return Math.ceil(segment.length / 3);
  return 1;
}

/**
 * Roughly how many tokens a text costs, without loading a tokeniser.
 *
 * Structural rather than a constant divisor. WordPiece and BPE vocabularies hold whole
 * common words but essentially never merge a punctuation mark into its neighbour, so every
 * symbol costs about one token while a run of letters costs about one per four. Paths,
 * JSON and code are mostly symbols, which is exactly why `chars / 4` fails on them.
 *
 * Measured against arctic-embed-m-v2's own tokeniser over 470 real atoms: this lands at
 * mean 1.11x the true count (p05 1.02, p95 1.20, worst 0.88x) and under-estimates 17 of
 * 470. `chars / 4` under-estimates 454 of 470 and reaches 0.48x on JSON. Over-estimating
 * costs a slightly smaller batch; under-estimating allocates the memory this budget exists
 * to bound, so the bias is deliberately on the safe side.
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  TOKEN_SEGMENT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_SEGMENT.exec(text)) !== null) tokens += segmentTokens(match[0]);
  return tokens;
}

/**
 * Clip to `MAX_EMBED_TOKENS`, cutting on a segment boundary where one exists, and report what
 * is left.
 *
 * **A first segment that alone exceeds the budget is cut mid-segment rather than dropped.**
 * Cutting only on boundaries returns `capped.slice(0, 0)` in that case -- the EMPTY STRING --
 * so the atom embeds as nothing and stores a meaningless vector, with no error anywhere.
 *
 * Reachable, and narrower than it looks. `MAX_EMBED_CHARS` pre-clips to 8,000 characters, and
 * `segmentTokens` charges a letter run `ceil(len/4)`, so the most one can ever cost is 2,000
 * tokens -- under the budget, so letters never reach this path. A DIGIT run is charged
 * `ceil(len/3)` and costs 2,667, which does. Base64, minified JSON, hashes and spaceless
 * numeric dumps are all ordinary atom content.
 *
 * Exported for tests. It is a pure string function, and reaching it through `embed()` would
 * make a model download a prerequisite for asserting a slice.
 */
export function clipToTokenBudget(text: string): { text: string; tokens: number } {
  const capped = text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS) : text;

  let tokens = 0;
  TOKEN_SEGMENT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_SEGMENT.exec(capped)) !== null) {
    const cost = segmentTokens(match[0]);
    if (tokens + cost > MAX_EMBED_TOKENS) {
      if (match.index === 0) {
        // Cut inside the segment, at the character count this segment's own rate charges the
        // whole budget for. Derived from the segment rather than assumed, because letters and
        // digits are charged at different rates and a fixed chars-per-token would be wrong for
        // one of them.
        const charsPerToken = match[0].length / cost;
        return {
          text: capped.slice(0, Math.max(1, Math.floor(MAX_EMBED_TOKENS * charsPerToken))),
          tokens: MAX_EMBED_TOKENS,
        };
      }
      return { text: capped.slice(0, match.index), tokens };
    }
    tokens += cost;
  }
  return { text: capped, tokens };
}

/** What the planner returns: the text to embed and where its vector belongs. */
export type PlannedEmbedding = { index: number; text: string };

/** The planner's constants, exported so tests can assert the bound rather than restate it. */
export const EMBEDDING_LIMITS = {
  maxTokens: MAX_EMBED_TOKENS,
  maxBatch: MAX_EMBED_BATCH,
  attentionBudget: ATTENTION_BUDGET,
} as const;

/**
 * Group texts into forward passes that cannot exhaust memory.
 *
 * Sizing by item count alone is what broke first: reindex handed over a 500-row database
 * page as one batch, and against a model with a large context window -- where nothing gets
 * truncated -- 498 items of ~969 tokens asked onnxruntime for 22 GB in a single allocation.
 * The batch has to be sized against the text, not the row count.
 *
 * Every sequence in a batch is padded up to the longest one, so a batch costs
 * `items Ã— longestÂ²` however short the rest are: one long atom landing beside 31 short ones
 * charges all 32 the long one's price. Under the old character budget that was the dominant
 * cost -- the real 470-atom corpus planned 80 batches with 34.7% of the padded work
 * embedding nothing, and 342 MB peak. It now plans 446 with 0.1%, and 161 MB.
 *
 * Almost all of that is the budget, not the sort: at a budget this size any item long
 * enough to strand its neighbours is already alone. Measured on the same corpus, sorting
 * changes padding by nothing at all (0.1% either way) and batch count by 3% (461 -> 446).
 * It earns its place on mixed input, where it packs the short items together instead of
 * letting an occasional long one close a batch early: on 2,000 transcript-sized messages
 * with one long paste in twenty, 200 forward passes in arrival order against 160 sorted,
 * for identical padded work. It also makes the plan a function of the content rather than
 * of row order, which is worth more than it sounds -- see below. Sorting is safe precisely
 * because `index` is carried: the caller's order is restored from it, not from position.
 *
 * Why order-independence matters: padding is not inert in this pipeline. A q8 graph
 * quantises per batch, so a text's vector depends on what shares its batch. The same atom
 * moved 2.78e-2 in cosine between being embedded alone and sitting in a batch of 32; in a
 * batch of 2 it moves 1.52e-2, and alone it is exact.
 *
 * "Very nearly reproduces" was the earlier claim here, and very nearly turned out not to be
 * enough. The shipped plan still batches 36 of the real corpus's 483 atoms, and swapping
 * those batched vectors for their embedded-alone counterparts changed the shipped ranker's
 * top ten for 13 of 120 real queries, and which items it returned at all for 4. The
 * knowledge path therefore asks for `maxBatch: 1` and takes exactness over nearness.
 *
 * **So does the transcript path, and the 2.7x that used to excuse it was not its number.**
 * That figure is from synthetic items of ~45 tokens. Real transcript messages are p50 169
 * characters but p90 1,980 and p99 10,005, and since cost is superlinear in length the long
 * tail is most of the wall clock and is already alone in its batch either way: 400
 * representative messages cost 575.1 s batched against 535.6 s one at a time, i.e. **0.93x**.
 * The exposure was also far worse there than on atoms -- 447 of 483 atoms are already alone,
 * but 651 of 956 real messages moved, and the shipped transcript ranker returned a different
 * top-5 membership for 42.8% of 194 real queries. Both paths now embed one text per pass.
 */
export function planEmbeddingBatches(
  texts: string[],
  /**
   * `maxBatch: 1` asks for one forward pass per text, which is the only way to get a vector
   * that does not depend on its neighbours. See `EmbedOptions`.
   */
  options: { maxBatch?: number } = {},
): PlannedEmbedding[][] {
  const maxBatch = Math.max(1, Math.min(options.maxBatch ?? MAX_EMBED_BATCH, MAX_EMBED_BATCH));

  // Stable, so items of equal length keep the caller's order and planning is deterministic.
  const entries = texts
    .map((text, index) => ({ index, ...clipToTokenBudget(text ?? '') }))
    .sort((left, right) => left.tokens - right.tokens);

  const batches: PlannedEmbedding[][] = [];
  let current: PlannedEmbedding[] = [];
  let longest = 0;

  for (const entry of entries) {
    // Ascending order means this is the batch's new longest, and every earlier member is
    // padded up to it -- which is what makes the check below the batch's true cost.
    const nextLongest = Math.max(longest, entry.tokens);
    const wouldExceed = (current.length + 1) * nextLongest * nextLongest > ATTENTION_BUDGET;

    if (current.length > 0 && (wouldExceed || current.length >= maxBatch)) {
      batches.push(current);
      current = [];
      longest = 0;
    }

    // `current.length > 0` lets a single over-budget item through as its own batch rather
    // than dropping it. Unlike before, that is now a BOUNDED concession: the item has been
    // clipped to MAX_EMBED_TOKENS, so the worst it can ask for is the 315 MB ceiling, not
    // whatever 8,000 characters of JSON happened to tokenise to.
    current.push({ index: entry.index, text: entry.text });
    longest = Math.max(longest, entry.tokens);
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * The instruction a query carries and a document does not. Empty for symmetric models.
 *
 * Keyed by model family and overridable in config, so a model this table has never heard of
 * can still be given the prefix its card documents.
 */
const QUERY_PREFIXES: Array<[RegExp, string]> = [
  [/arctic-embed-\w*-v2/i, 'query: '],
  [/arctic-embed/i, 'Represent this sentence for searching relevant passages: '],
  [/\be5-|multilingual-e5/i, 'query: '],
  [/nomic-embed|modernbert-embed/i, 'search_query: '],
  [/bge-\w+-en|mxbai-embed/i, 'Represent this sentence for searching relevant passages: '],
];

export function queryPrefixFor(model: string, config?: ProjectConfig): string {
  const configured = (config?.search?.vector as Record<string, unknown> | undefined)?.queryPrefix;
  if (typeof configured === 'string') return configured;
  if (!model) return '';
  return QUERY_PREFIXES.find(([pattern]) => pattern.test(model))?.[1] ?? '';
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

/**
 * Where this model's weights are, and where a download would put them.
 *
 * K-42: `.knowl/models` is a PER-REPO cache of model weights that are identical everywhere.
 * Measured across this machine: 2,495 MB in one repo, and two other repos holding
 * byte-identical 336 MB copies of the same eight files. Weights are not project state --
 * nothing about them varies by repository -- so they belong beside the other machine-local
 * Knowl state under `knowlHome()`, the way workspaces and the repo registry already do.
 *
 * Resolved rather than switched, deliberately. Pointing the constant at the shared location
 * would orphan every existing tree -- 2.5 GB in one repo -- and make the next query
 * re-download a model that is already on disk two directories away. Preferring whichever
 * copy EXISTS costs one `access` per provider build, adopts the shared cache for anything
 * fetched from now on, and leaves an existing repo cache working exactly as it did until
 * somebody deletes it, at which point it is refetched once into the shared location.
 *
 * An explicit `search.vector.cacheDir` still outranks both: a repo that has deliberately
 * placed its weights somewhere is not second-guessed.
 */
export async function resolveModelCache(
  config: ProjectConfig,
  projectRoot: string,
): Promise<{ dir: string; present: boolean }> {
  const vector = resolveVectorProfile(config);
  const configured = (config.search?.vector as Record<string, unknown> | undefined)?.cacheDir;
  const holdsModel = async (dir: string) =>
    fsPromises.access(path.join(dir, ...vector.model.split('/'))).then(() => true, () => false);

  if (typeof configured === 'string' && configured) {
    return { dir: configured, present: await holdsModel(configured) };
  }

  const shared = path.join(knowlHome(), 'models');
  if (await holdsModel(shared)) return { dir: shared, present: true };

  const legacy = path.join(projectRoot, '.knowl', 'models');
  if (await holdsModel(legacy)) return { dir: legacy, present: true };

  // Nowhere yet, so a fetch should land in the shared cache rather than start a new
  // per-repo copy of something every repo on this machine will want.
  return { dir: shared, present: false };
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

  // `cached` falls out of the same resolution: the directory chosen is the one holding the
  // weights whenever any of them does, so a caller can say "loading" rather than
  // "downloading". Same helper write-time embedding uses before deciding it can embed.
  const { dir: cacheDir, present: cached } = await resolveModelCache(config, projectRoot);
  const pipelineKey = `${vector.model}:${vector.dtype}:${vector.pooling}:${cacheDir}`;

  if (!localPipeline || localPipelineKey !== pipelineKey) {
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
    // Null for a model this build has not measured, which switches abstention off rather than
    // borrowing another model's number. See MODEL_RELEVANCE_FLOORS.
    relevanceFloor: relevanceFloorFor(vector.model),
    embed: async (texts: string[], options?: EmbedOptions) => {
      const vectors: number[][] = [];
      for (const batch of planEmbeddingBatches(texts, options)) {
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
    embedQuery: async (text: string) => {
      const output = await localPipeline!([queryPrefixFor(vector.model, config) + text], {
        pooling: vector.pooling,
        normalize: true,
      });
      return Array.from(output.data).slice(0, output.dims[output.dims.length - 1]) as number[];
    },
  };
}
