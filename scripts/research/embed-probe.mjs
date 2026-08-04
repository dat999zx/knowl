// One embedding candidate, measured on one of our own suites, in its own process.
//
// Usage:
//   node scripts/research/embed-probe.mjs --model <hf-id> --dtype q8 --pooling cls
//     --prefix "query: " --suite docs/evals/semantic-suite.json --cache <dir> --out <file>
//     [--docprefix "..."] [--dims 128,256,512] [--label "..."]
//
// Run candidates ONE AT A TIME. Two models sharing the CPU produce latency numbers that
// describe the contention rather than the model.
//
// PURE SEMANTIC on purpose. `knowl eval retrieval --vector` measures the shipped ranker,
// which is `0.8 * cosine + 0.2 * lexical` -- a fusion whose lexical half is unaffected by the
// model. alpha-sweep.md measured that half carrying MRR 0.95 on its own, so an end-to-end
// number compresses every model difference into whatever BM25 could not already find. This
// probe removes the lexical half so the embedder is the only thing being scored; the shipped
// number is measured separately by the eval CLI and both are reported.
//
// Text composition, pooling, normalisation and one-text-per-forward-pass all copy
// buildKnowledgeEmbeddingText / createLocalEmbeddingProvider exactly, so a vector here is the
// vector the product would store.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    model: { type: 'string' },
    dtype: { type: 'string', default: 'q8' },
    pooling: { type: 'string', default: 'cls' },
    prefix: { type: 'string', default: '' },
    docprefix: { type: 'string', default: '' },
    suite: { type: 'string' },
    cache: { type: 'string' },
    dims: { type: 'string', default: '' },       // comma-separated MRL truncations, '' = native only
    out: { type: 'string' },
    label: { type: 'string', default: '' },
  },
});

const suite = JSON.parse(fs.readFileSync(values.suite, 'utf8'));
const fixtures = suite.fixtures ?? [];
const cases = suite.cases ?? [];

// src/store/vector-index.ts buildKnowledgeEmbeddingText
const docText = f => {
  const tags = f.tags?.length ? `\nTags: ${f.tags.join(', ')}` : '';
  const reasoning = f.reasoning ? `\nReasoning: ${f.reasoning}` : '';
  return `${f.title}\n${f.content}${reasoning}${tags}`;
};

let peakRss = 0;
const noteRss = () => { peakRss = Math.max(peakRss, process.memoryUsage.rss()); };

const transformers = await import('@huggingface/transformers');
transformers.env.cacheDir = values.cache;
// Offline would be nicer but a fresh candidate has to be fetched once; the cache dir is a
// COPY under the worktree, never the machine's real one.

const loadStart = performance.now();
const pipe = await transformers.pipeline('feature-extraction', values.model, { dtype: values.dtype });
const loadMs = performance.now() - loadStart;
noteRss();

// `last` is not one of transformers.js's pooling modes and not one of ours either
// (VectorPooling is 'mean' | 'cls'). jina-embeddings-v5 requires it, so it is done by hand
// here purely to find out whether the model would be worth the provider change. Nothing in
// the product can produce these vectors today.
const embedOne = async text => {
  if (values.pooling === 'last') {
    const out = await pipe([text], { pooling: 'none', normalize: false });
    const [, seq, width] = out.dims;
    const row = Array.from(out.data).slice((seq - 1) * width, seq * width);
    let norm = 0;
    for (const x of row) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    return row.map(x => x / norm);
  }
  const out = await pipe([text], { pooling: values.pooling, normalize: true });
  const width = out.dims[out.dims.length - 1];
  return Array.from(out.data).slice(0, width);
};

// --- corpus ---------------------------------------------------------------
const corpusStart = performance.now();
const docVectors = [];
for (const f of fixtures) {
  docVectors.push(await embedOne(values.docprefix + docText(f)));
  noteRss();
}
const corpusMs = performance.now() - corpusStart;
const nativeDims = docVectors[0]?.length ?? 0;

// --- queries --------------------------------------------------------------
// Every distinct query string, embedded once, timed individually. p50/p95 over these is the
// embedQuery latency a caller actually pays.
const queries = [...new Set(cases.map(c => c.query))];
const queryVectors = new Map();
const queryLatencies = [];
for (const q of queries) {
  const t0 = performance.now();
  const v = await embedOne(values.prefix + q);
  queryLatencies.push(performance.now() - t0);
  queryVectors.set(q, v);
  noteRss();
}

// --- scoring --------------------------------------------------------------
const truncate = (v, d) => {
  if (!d || d >= v.length) return v;
  const head = v.slice(0, d);
  let norm = 0;
  for (const x of head) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return head.map(x => x / norm);
};
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

function scoreAt(dims) {
  const docs = docVectors.map(v => truncate(v, dims));
  const ids = fixtures.map(f => f.id);
  const perTier = new Map();
  const rows = [];
  let goldCosineSum = 0, goldCosineN = 0;

  for (const testCase of cases) {
    const qv = truncate(queryVectors.get(testCase.query), dims);
    const ranked = docs
      .map((dv, i) => ({ id: ids[i], score: dot(qv, dv) }))
      .sort((a, b) => b.score - a.score);

    const expected = new Set(testCase.expectedItemIds);
    // Same definitions as src/store/retrieval-evaluation.ts.
    const matching = k => ranked.slice(0, k).filter(r => expected.has(r.id)).length / Math.max(1, expected.size);
    const first = ranked.findIndex(r => expected.has(r.id));
    const row = {
      tier: testCase.tier ?? 'untiered',
      r3: matching(3),
      r10: matching(Math.max(10, testCase.limit ?? 10)),
      rr: first < 0 ? 0 : 1 / (first + 1),
      forbidden: ranked.slice(0, testCase.limit ?? 10).filter(r => testCase.mustNotReturn?.includes(r.id)).length,
    };
    rows.push(row);
    for (const g of expected) {
      const hit = ranked.find(r => r.id === g);
      if (hit) { goldCosineSum += hit.score; goldCosineN++; }
    }
    const bucket = perTier.get(row.tier) ?? [];
    bucket.push(row);
    perTier.set(row.tier, bucket);
  }

  const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  const agg = rs => ({
    cases: rs.length,
    recallAt3: mean(rs.map(r => r.r3)),
    recallAt10: mean(rs.map(r => r.r10)),
    mrr: mean(rs.map(r => r.rr)),
    forbidden: rs.reduce((a, r) => a + r.forbidden, 0),
  });

  return {
    dims: dims || nativeDims,
    overall: agg(rows),
    byTier: Object.fromEntries([...perTier].map(([t, rs]) => [t, agg(rs)])),
    meanGoldCosine: goldCosineN ? goldCosineSum / goldCosineN : 0,
  };
}

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] : 0;
};

const dimsList = values.dims ? values.dims.split(',').map(Number).filter(d => d > 0 && d <= nativeDims) : [];

// Weights actually on disk for this dtype, so the size column is measured rather than quoted
// from a model card.
function weightBytes() {
  const dir = path.join(values.cache, ...values.model.split('/'), 'onnx');
  if (!fs.existsSync(dir)) return 0;
  const wanted = values.dtype === 'fp32' ? /^model\.onnx(_data)?$/
    : values.dtype === 'fp16' ? /^model_fp16\.onnx(_data)?$/
      : values.dtype === 'q4' ? /^model_q4\.onnx(_data)?$/
        : /^model_quantized\.onnx(_data)?$/;
  return fs.readdirSync(dir).filter(f => wanted.test(f))
    .reduce((sum, f) => sum + fs.statSync(path.join(dir, f)).size, 0);
}

const result = {
  label: values.label || `${values.model}/${values.dtype}`,
  model: values.model,
  dtype: values.dtype,
  pooling: values.pooling,
  prefix: values.prefix,
  docprefix: values.docprefix,
  suite: path.basename(values.suite),
  nativeDims,
  fixtures: fixtures.length,
  cases: cases.length,
  distinctQueries: queries.length,
  loadMs: Math.round(loadMs),
  corpusMs: Math.round(corpusMs),
  msPerDoc: +(corpusMs / Math.max(1, fixtures.length)).toFixed(1),
  queryP50Ms: +pct(queryLatencies, 0.5).toFixed(1),
  queryP95Ms: +pct(queryLatencies, 0.95).toFixed(1),
  peakRssMb: +(peakRss / 1048576).toFixed(0),
  weightsMb: +(weightBytes() / 1048576).toFixed(0),
  native: scoreAt(0),
  truncations: dimsList.map(scoreAt),
};

fs.writeFileSync(values.out, JSON.stringify(result, null, 1));
console.log(`${result.label}  MRR ${result.native.overall.mrr.toFixed(4)}  R@3 ${result.native.overall.recallAt3.toFixed(4)}  R@10 ${result.native.overall.recallAt10.toFixed(4)}  q_p50 ${result.queryP50Ms}ms  rss ${result.peakRssMb}MB`);
