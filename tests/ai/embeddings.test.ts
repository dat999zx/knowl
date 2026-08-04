import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import {
  createLocalEmbeddingProvider, EMBEDDING_LIMITS, estimateTokens, getVectorSearchConfig, planEmbeddingBatches,
  resetLocalEmbeddingPipeline,
} from '../../src/ai/embeddings.js';
import type { ProjectConfig } from '../../src/core/types.js';

function config(vector: Record<string, unknown>): ProjectConfig {
  return { version: 1, search: { vector: { enabled: true, ...vector } } } as unknown as ProjectConfig;
}

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
});

describe('local embedding provider pooling', () => {
  it('passes cls pooling to the pipeline for a cls preset', async () => {
    resetLocalEmbeddingPipeline();
    const seen: Array<{ pooling: string; normalize: boolean }> = [];

    const embedder = await createLocalEmbeddingProvider(
      config({ preset: 'granite-small-en-r2' }),
      '/tmp/knowl-pooling-test',
      {
        loadPipeline: async () => (async (texts: string[], options: any) => {
          seen.push(options);
          return { data: new Float32Array(texts.length * 2).fill(0.5), dims: [texts.length, 2] };
        }) as any,
      },
    );

    await embedder.embed(['hello']);

    expect(seen).toEqual([{ pooling: 'cls', normalize: true }]);
    expect(embedder.pooling).toBe('cls');
  });

  it('passes mean pooling for the historical MiniLM config', async () => {
    resetLocalEmbeddingPipeline();
    const seen: Array<{ pooling: string }> = [];

    const embedder = await createLocalEmbeddingProvider(
      config({ model: 'Xenova/all-MiniLM-L6-v2', dtype: 'q8' }),
      '/tmp/knowl-pooling-test-2',
      {
        loadPipeline: async () => (async (texts: string[], options: any) => {
          seen.push(options);
          return { data: new Float32Array(texts.length * 2).fill(0.5), dims: [texts.length, 2] };
        }) as any,
      },
    );

    await embedder.embed(['hello']);

    expect(seen[0].pooling).toBe('mean');
    expect(embedder.pooling).toBe('mean');
  });

  it('resolves the preset model through getVectorSearchConfig', () => {
    const resolved = getVectorSearchConfig(config({ preset: 'bge-small-en' }));
    expect(resolved.model).toBe('Xenova/bge-small-en-v1.5');
    expect(resolved.pooling).toBe('cls');
  });
});

describe('token estimation', () => {
  // Calibrated against arctic-embed-m-v2's own tokeniser over 470 real atoms: mean 1.11x
  // the true count, worst 0.88x. These assertions pin the property that matters -- that it
  // tracks token DENSITY -- rather than the calibration itself.
  it('charges a symbol about a token and a short word about a token', () => {
    expect(estimateTokens('the cat sat')).toBe(3);
    expect(estimateTokens('{"a":1}')).toBe(estimateTokens('{') + estimateTokens('"') * 2
      + estimateTokens('a') + estimateTokens(':') + estimateTokens('1') + estimateTokens('}'));
  });

  it('reports symbol-dense text as far more tokens than prose of the same length', () => {
    const prose = 'the quick brown fox jumps over a lazy dog again and again '.repeat(40);
    const json = '{"path":"src/a-b/c_1.ts","hash":"0xff","ok":true},'.repeat(47);
    expect(prose.length).toBeGreaterThan(2_000);
    expect(Math.abs(prose.length - json.length)).toBeLessThan(120);

    // The whole point of K-64: equal character counts, very unequal cost.
    expect(estimateTokens(json)).toBeGreaterThan(estimateTokens(prose) * 2);
  });

  it('is not a constant divisor of length', () => {
    expect(estimateTokens('x'.repeat(400))).not.toBe(estimateTokens('!'.repeat(400)));
  });
});

describe('embedding batch planning', () => {
  /**
   * What attention actually allocates: every sequence in a batch is padded up to the
   * longest, so the batch costs `items x longest tokens squared`.
   *
   * This replaces an identical helper that squared the longest text's CHARACTER count. The
   * old assertion was the defect (K-64) written down as a test: it passed for a batch that
   * fitted 64,000,000 char² while asking onnxruntime for however many bytes the content's
   * token density happened to imply -- 342 MB over the real corpus, 1.8 GB for one dense
   * item, against a documented ceiling of ~200 MB.
   */
  const cost = (batch: Array<{ text: string }>) =>
    batch.length * Math.max(...batch.map(entry => estimateTokens(entry.text))) ** 2;

  /**
   * The two bounds the planner promises, asserted together everywhere.
   *
   * A multi-item batch fits the throughput budget. A single item does not have to -- it is
   * the one concession, and it is bounded by the token clip rather than by whatever the
   * content happened to tokenise to.
   */
  const withinBounds = (batches: Array<Array<{ text: string }>>) => {
    for (const batch of batches) {
      expect(cost(batch)).toBeLessThanOrEqual(EMBEDDING_LIMITS.maxTokens ** 2);
      if (batch.length > 1) expect(cost(batch)).toBeLessThanOrEqual(EMBEDDING_LIMITS.attentionBudget);
      expect(batch.length).toBeLessThanOrEqual(EMBEDDING_LIMITS.maxBatch);
    }
  };

  /** Share of a plan's padded work that embeds nothing. */
  const paddingWaste = (batches: Array<Array<{ text: string }>>) => {
    let padded = 0;
    let real = 0;
    for (const batch of batches) {
      const longest = Math.max(...batch.map(entry => estimateTokens(entry.text)));
      padded += batch.length * longest;
      real += batch.reduce((sum, entry) => sum + estimateTokens(entry.text), 0);
    }
    return (padded - real) / padded;
  };

  it('never plans a batch that can exhaust memory, however many items arrive', () => {
    // The shape that broke it in the field: a whole 500-row reindex page of long items,
    // handed to the model as one forward pass. 498 x 969 tokens asked for 22 GB.
    const texts = Array.from({ length: 498 }, (_, i) => `item ${i} `.padEnd(4_000, 'x'));
    const batches = planEmbeddingBatches(texts);

    expect(batches.length).toBeGreaterThan(1);
    withinBounds(batches);
    // Every item still gets embedded, exactly once.
    expect(batches.flat()).toHaveLength(498);
    expect(new Set(batches.flat().map(entry => entry.index)).size).toBe(498);
  });

  it('holds the memory bound for token-dense text of the same length as prose', () => {
    // A character budget cannot see the difference between these two, and the JSON costs
    // roughly three times the attention. Same bounds as above, on the content that breaks
    // the character proxy.
    const json = Array.from({ length: 80 }, (_, i) =>
      `{"path":"src/store/module-${i}/write-embedding.ts","hash":"0xa1b2c3","lines":${87 + i}},`.repeat(60));
    withinBounds(planEmbeddingBatches(json));
  });

  it('packs short texts densely and long ones sparsely', () => {
    const short = planEmbeddingBatches(Array.from({ length: 200 }, () => 'x'.repeat(200)));
    const long = planEmbeddingBatches(Array.from({ length: 200 }, () => 'x'.repeat(4_000)));

    // Cost is driven by the longest text in a batch, since the rest are padded up to it.
    expect(short[0].length).toBeGreaterThan(long[0].length);
    expect(short[0].length).toBeLessThanOrEqual(32);
  });

  it('batches transcript-sized messages and refuses to batch atom-sized ones', () => {
    // K-63 and K-68 together. The old budget was inert below ~1,414 characters -- exactly
    // where batching is the whole win -- and binding above it, exactly where batching is a
    // loss: on 48 real atoms the batched plan took 16.1s against 4.7s one at a time. The
    // budget now binds the other way round.
    const messages = planEmbeddingBatches(Array.from({ length: 400 }, (_, i) => `line ${i}: a short turn in a conversation.`));
    const atoms = planEmbeddingBatches(Array.from({ length: 40 }, (_, i) => `Atom ${i}\n${'sentence about the system. '.repeat(80)}`));

    expect(Math.max(...messages.map(batch => batch.length))).toBe(32);
    expect(Math.max(...atoms.map(batch => batch.length))).toBe(1);
  });

  it('packs by length, so a long item never strands the short ones around it', () => {
    // K-66. In arrival order a single long item closes the batch it lands in and pads the
    // short ones up to its length: on the real 470-atom corpus, 80 batches with 34.7% of
    // the padded work embedding nothing. Sorted, the flattened plan is non-decreasing in
    // length, which is the property that makes a batch's members interchangeable.
    const texts = Array.from({ length: 240 }, (_, i) => (i % 8 === 0 ? 'y'.repeat(1_200) : 'x'.repeat(150)));
    const batches = planEmbeddingBatches(texts);
    const flat = batches.flat();

    expect(paddingWaste(batches)).toBeLessThan(0.05);
    const lengths = flat.map(entry => estimateTokens(entry.text));
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
    expect(flat).toHaveLength(240);
    withinBounds(batches);
  });

  it('clips one very long item rather than dropping it or blowing the budget', () => {
    const batches = planEmbeddingBatches(['y'.repeat(500_000), 'short']);
    const flat = batches.flat();

    // Position is no longer the identity -- the plan is sorted -- so the giant is found by
    // the index it carries, which is the thing the caller actually relies on.
    expect(flat).toHaveLength(2);
    const giant = flat.find(entry => entry.index === 0)!;
    expect(giant.text.length).toBe(8_000);
    // The clipped giant travels alone; nothing is padded up to half a megabyte.
    expect(batches.find(batch => batch.some(entry => entry.index === 0))).toHaveLength(1);
  });

  it('clips a token-dense item by tokens, not by characters', () => {
    // 8,000 characters of JSON is ~6,300 real tokens: a character clip lets a single item
    // ask for 1.8 GB in one forward pass, which is what "one over-budget text is
    // affordable on its own" used to wave through.
    const dense = '{"k":"v","n":1},'.repeat(4_000);
    const [entry] = planEmbeddingBatches([dense]).flat();

    expect(entry.text.length).toBeLessThan(8_000);
    expect(estimateTokens(entry.text)).toBeLessThanOrEqual(2_560);
    // Still a prefix of what was asked for -- clipped, never rewritten.
    expect(dense.startsWith(entry.text)).toBe(true);
  });

  it('plans every item exactly once, whatever the order it packs them in', () => {
    // Replaces an assertion that the flattened plan came back in arrival order. That pinned
    // the planner's internal order, which sorting legitimately changes; what callers depend
    // on is the carried `index`, and `embed` restores their order from it (asserted below).
    const texts = Array.from({ length: 100 }, (_, i) => 'z'.repeat((i % 10) * 700 + 10));
    const flat = planEmbeddingBatches(texts).flat();

    expect(flat).toHaveLength(100);
    expect([...flat.map(entry => entry.index)].sort((a, b) => a - b)).toEqual(texts.map((_, i) => i));
  });

  it('handles an empty request', () => {
    expect(planEmbeddingBatches([])).toEqual([]);
  });
});

describe('local embedder batching', () => {
  it('splits one embed() call across forward passes and returns vectors in order', async () => {
    resetLocalEmbeddingPipeline();
    const passes: number[] = [];

    const embedder = await createLocalEmbeddingProvider(
      config({ preset: 'granite-small-en-r2' }),
      '/tmp/knowl-batching-test',
      {
        loadPipeline: async () => (async (texts: string[]) => {
          passes.push(texts.length);
          // One dimension per text, valued by its first character, so ordering is checkable.
          return { data: texts.map(text => text.charCodeAt(0)), dims: [texts.length, 1] };
        }) as any,
      },
    );

    const texts = Array.from({ length: 120 }, (_, i) => String.fromCharCode(65 + (i % 26)).repeat(4_000));
    const vectors = await embedder.embed(texts);

    // Several passes, none of them the whole request.
    expect(passes.length).toBeGreaterThan(1);
    expect(Math.max(...passes)).toBeLessThan(texts.length);
    expect(passes.reduce((sum, n) => sum + n, 0)).toBe(texts.length);

    // One vector per input, still aligned with the input that produced it.
    expect(vectors).toHaveLength(texts.length);
    expect(vectors.map(vector => vector[0])).toEqual(texts.map(text => text.charCodeAt(0)));
  });

  it('returns vectors in the caller order even when the plan reorders them', async () => {
    // The safety net for length-sorted packing. Lengths here are deliberately shuffled, so
    // a plan that packs by length hands the pipeline a different order than the caller
    // used; only the carried index puts the results back.
    resetLocalEmbeddingPipeline();
    const seen: string[] = [];

    const embedder = await createLocalEmbeddingProvider(
      config({ preset: 'granite-small-en-r2' }),
      '/tmp/knowl-order-test',
      {
        loadPipeline: async () => (async (texts: string[]) => {
          seen.push(...texts);
          return { data: texts.map(text => text.length), dims: [texts.length, 1] };
        }) as any,
      },
    );

    const lengths = [30, 9_000, 120, 4_400, 7, 2_100, 60, 8_800, 15, 3_300];
    const texts = lengths.map((length, i) => String.fromCharCode(97 + i).repeat(length));
    const vectors = await embedder.embed(texts);

    // The pipeline really did see a different order -- otherwise this proves nothing.
    expect(seen.map(text => text.length)).not.toEqual(texts.map(text => Math.min(text.length, 8_000)));
    // ...and the caller still gets one vector per input, in the order it asked.
    expect(vectors).toHaveLength(texts.length);
    expect(vectors.map(vector => vector[0])).toEqual(texts.map(text => Math.min(text.length, 8_000)));
  });
});
