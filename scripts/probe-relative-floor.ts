/**
 * Direction 1 of #169: is there a RELATIVE signal where an absolute cosine provably fails?
 *
 * `preset-floor-sweep.md` closed direction 2 and established the finding underneath it: the
 * on-topic/off-topic overlap is not a property of `granite-small-en-r2`, it is a property of
 * embedding cosine as a relevance signal for this corpus. Five models, three cosine scales, two
 * pooling strategies, a 13x parameter spread -- all fail on the same class of query, a TECHNICAL
 * question about a subject the store does not hold. So no absolute threshold can work, and the
 * only direction left with evidence behind it is a signal that is not an absolute cosine.
 *
 * This measures every candidate at once, from one run, by recording the whole top-10 cosine
 * vector per query instead of only its maximum. Every relative signal below is then a pure
 * function of that vector plus the corpus's own self-similarity, so a new candidate costs an
 * arithmetic expression rather than another hour of embedding.
 *
 * THE CANDIDATES, and why each is here:
 *   absolute    -- the shipped signal. Baseline, known to fail. Present so the table has a floor.
 *   margin      -- c0 - c1. The issue's own first suggestion.
 *   ratio       -- c0 / c1.
 *   marginMean  -- c0 - mean(rest). `per-model-floor.md` measured this against the GENERAL junk
 *                  class and found it overlapped; re-run here against the technical class, which
 *                  is the population that actually matters.
 *   z           -- (c0 - mean(rest)) / std(rest). Same provenance, same caveat.
 *   selfExcess  -- c0 - p95(self-similarity).
 *   selfNorm    -- (c0 - p50self) / (p95self - p50self).
 *   selfRatio   -- c0 / p50(self-similarity).
 *
 * The three `self*` candidates are the ones this probe exists for. Every other candidate on the
 * list is relative to the QUERY's own result page; those are relative to the CORPUS, measured at
 * index time from vectors the store already has. That is the property `preset-floor-sweep.md`
 * says is missing -- "a fixed absolute cosine does not transfer between corpora" -- and none of
 * the page-relative candidates supply it, because a peaked page is exactly what a query that
 * finds nothing also produces.
 *
 * METHOD follows `sweep-preset-floor.ts` so the two are comparable: a fresh scratch store per
 * preset, the same 50 semantic-suite fixtures, the same 135 on-topic cases, `relevanceFloor:
 * null` so nothing abstains before it is measured, and the quantity read from
 * `explanation.contributions.semantic` -- the clamped raw cosine, before `rescaleSemantic`.
 *
 * TWO DEPARTURES, both asked for by `preset-floor-sweep.md`'s own closing caution ("not enough
 * to calibrate a relative rule against ... needs a larger technical junk set"):
 *   - OFF_TOPIC_TECHNICAL is 50 probes, not 15.
 *   - Self-similarity is sampled over all C(50,2) = 1,225 fixture pairs, exhaustively rather
 *     than by sampling, because at 50 fixtures the exhaustive set is cheaper than a sampler.
 *
 * Usage: npx tsx scripts/probe-relative-floor.ts [--presets a,b] [--json out.json]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/core/config.js';
import { createLocalEmbeddingProvider } from '../src/ai/embeddings.js';
import { reindexKnowledgeEmbeddings } from '../src/store/vector-index.js';
import { closeDb, initDb } from '../src/store/database.js';
import * as repo from '../src/store/repository.js';
import { rankKnowledge } from '../src/store/agent-query.js';
import { VECTOR_PRESETS, PRESET_IDS, relevanceFloorFor } from '../src/core/vector-profile.js';

/**
 * 50 technical probes, each naming a domain absent from the fixture list.
 *
 * The fixtures are generic backend-SaaS: soft-delete, postgres, redis, jwt, rate limiting,
 * deploys, flags, migrations, logs, metrics, tracing, alerting, retention, queues, tests, CI,
 * secrets, CDN, image resize, search, email, webhooks, pagination, idempotency, timezones,
 * uploads, sessions, passwords, API versioning, billing. Anything adjacent to those is excluded
 * on purpose -- kafka rebalancing, SQL window functions and CDN cache headers would each flatter
 * a floor rather than test it, because a high cosine there is arguably correct.
 *
 * What is left is the hazard #169 actually reproduces: same register as the corpus, different
 * subject. Mobile, gamedev, graphics, ML training, embedded, compilers, audio, typesetting,
 * plotting, robotics, bioinformatics, GIS, HDL, kernel, codecs, numerical methods, CAD.
 */
const OFF_TOPIC_TECHNICAL = [
  'kubernetes ingress nginx tls renewal', // #169's own reproduction case, kept verbatim
  'swiftui view modifier order breaks animation',
  'unity shader graph vertex displacement node',
  'pytorch dataloader num_workers deadlock on fork',
  'arduino i2c pullup resistor value selection',
  'css grid subgrid browser support fallback',
  'llvm loop unrolling pass ordering',
  'blender uv unwrap seam placement',
  'rust borrow checker lifetime elision rules',
  'ffmpeg concat demuxer keyframe alignment',
  'latex natbib bibliography citation style',
  'godot signal connection in the editor',
  'matplotlib colorbar tick label formatting',
  'ableton sidechain compression routing',
  'verilog blocking versus nonblocking assignment',
  'android jetpack compose recomposition scope',
  'core data faulting versus prefetching',
  'vulkan descriptor set layout binding',
  'unreal blueprint tick group ordering',
  'opengl framebuffer multisample resolve',
  'cuda warp divergence occupancy tradeoff',
  'transformer attention head pruning schedule',
  'gradient checkpointing memory recompute tradeoff',
  'lora rank selection for finetuning',
  'onnx opset mismatch on export',
  'stm32 dma circular buffer half transfer',
  'freertos task priority inversion mutex',
  'can bus arbitration bit timing',
  'spi clock polarity phase mode',
  'jtag boundary scan chain debug',
  'gcc inline assembly clobber list',
  'antlr grammar left recursion elimination',
  'wasm linear memory growth trap',
  'garbage collector write barrier card table',
  'register allocation graph coloring spill',
  'reverb impulse response convolution tail',
  'fft window function spectral leakage',
  'midi clock jitter sync drift',
  'typst layout box model versus latex',
  'inkscape path boolean difference node',
  'ggplot facet wrap free scales',
  'd3 force simulation collision radius',
  'ros2 node lifecycle transition callback',
  'slam loop closure pose graph optimization',
  'inverse kinematics jacobian singularity',
  'blast e value alignment threshold',
  'variant calling read depth filter',
  'geotiff reprojection resampling nearest',
  'shapefile attribute join spatial index',
  'quantum circuit transpilation gate depth',
];

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = flag('--presets')?.split(',').map(s => s.trim()).filter(Boolean);
const jsonOut = flag('--json');
const presets = (only ?? PRESET_IDS.filter(id => id !== 'custom')) as Array<keyof typeof VECTOR_PRESETS>;

const suite = JSON.parse(
  await fs.readFile(path.resolve('docs/evals/semantic-suite.json'), 'utf-8'),
) as {
  fixtures: Array<{ id: string; category: any; title: string; content: string; tags?: string[] }>;
  cases: Array<{ query: string }>;
};

const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const stdev = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

/** Every judged candidate's RAW cosine, best first. Floor disabled so nothing abstains first. */
async function topCosines(projectId: string, query: string, embedder: any): Promise<number[]> {
  const rows = await rankKnowledge(projectId, {
    query,
    status: 'active',
    limit: 10,
    vector: {
      enabled: true,
      profileFingerprint: embedder.profileFingerprint,
      embedding: await embedder.embedQuery(query),
      relevanceFloor: null,
    },
  });
  return (rows as any[])
    .filter(row => !row.explanation?.uncalibrated)
    .map(row => row.explanation?.contributions?.semantic ?? 0)
    .sort((a, b) => b - a);
}

/** Which fixture the top hit was, so contamination is visible rather than silent. */
async function topHitId(projectId: string, query: string, embedder: any): Promise<string> {
  const rows = await rankKnowledge(projectId, {
    query,
    status: 'active',
    limit: 1,
    vector: {
      enabled: true,
      profileFingerprint: embedder.profileFingerprint,
      embedding: await embedder.embedQuery(query),
      relevanceFloor: null,
    },
  });
  return (rows as any[])[0]?.title ?? '(none)';
}

type SelfSim = { p50: number; p90: number; p95: number; p99: number; max: number };

/** Every candidate signal, as a pure function of one page's cosines and the corpus baseline. */
function signals(c: number[], self: SelfSim): Record<string, number> {
  const top = c[0] ?? 0;
  const rest = c.slice(1);
  const restMean = mean(rest);
  const restStd = stdev(rest);
  return {
    absolute: top,
    margin: top - (c[1] ?? 0),
    ratio: (c[1] ?? 0) > 0 ? top / (c[1] as number) : 0,
    marginMean: top - restMean,
    z: restStd > 0 ? (top - restMean) / restStd : 0,
    selfExcess: top - self.p95,
    selfNorm: self.p95 - self.p50 > 0 ? (top - self.p50) / (self.p95 - self.p50) : 0,
    selfRatio: self.p50 > 0 ? top / self.p50 : 0,
  };
}

/**
 * P(a random on-topic query scores above a random junk one), ties counted as half.
 *
 * The single number that answers "does this signal separate at all", independent of where any
 * threshold would go. 0.5 is a coin flip; 1.0 is perfect separation. Reported beside the gap
 * because the gap alone hides HOW BADLY a signal fails -- two signals can both have a negative
 * gap while one is nearly separating and the other is noise.
 */
function auc(positives: number[], negatives: number[]): number {
  let wins = 0;
  for (const p of positives) for (const n of negatives) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (positives.length * negatives.length || 1);
}

const SIGNAL_NAMES = ['absolute', 'margin', 'ratio', 'marginMean', 'z', 'selfExcess', 'selfNorm', 'selfRatio'];

const baseConfig = await loadConfig(process.cwd());
const results: any[] = [];

for (const id of presets) {
  const preset = VECTOR_PRESETS[id];
  if (!preset) throw new Error(`Unknown preset: ${id}`);
  console.error(`\n--- ${id} (${preset.model}, ${preset.sizeMb}MB, pooling ${preset.pooling}) ---`);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), `knowl-relfloor-${id}-`));
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await initDb(root);
  const project = await repo.createProject(root, `relfloor ${id}`);
  for (const fixture of suite.fixtures) await repo.createKnowledgeItem(project.id, fixture as any);

  const config = {
    ...baseConfig,
    search: {
      ...baseConfig.search,
      vector: {
        ...(baseConfig.search?.vector as object),
        enabled: true,
        provider: 'local',
        preset: id,
        model: preset.model,
        dtype: preset.dtype,
        pooling: preset.pooling,
      },
    },
  } as any;

  const embedder = await createLocalEmbeddingProvider(config, root, {
    onFirstLoad: ({ cached }) => console.error(cached ? '  loading weights...' : '  DOWNLOADING weights...'),
  });
  const indexed = await reindexKnowledgeEmbeddings(project.id, embedder);
  console.error(`  embedded ${indexed.indexed} fixtures`);

  /*
   * The corpus's own similarity distribution, from the same text the index holds.
   *
   * `embed` rather than `embedQuery`, because these are documents and `embedQuery` prepends a
   * per-model query prefix -- comparing a prefixed vector against unprefixed ones would measure
   * the prefix as much as the corpus. Vectors come back normalized, so the dot product IS the
   * cosine and no division is needed.
   */
  const fixtureVectors = await embedder.embed(
    suite.fixtures.map(f => [f.title, f.content, ...(f.tags ?? [])].join(' ')),
  );
  const pairs: number[] = [];
  for (let i = 0; i < fixtureVectors.length; i++) {
    for (let j = i + 1; j < fixtureVectors.length; j++) {
      let dot = 0;
      for (let k = 0; k < fixtureVectors[i].length; k++) dot += fixtureVectors[i][k] * fixtureVectors[j][k];
      pairs.push(dot);
    }
  }
  pairs.sort((a, b) => a - b);
  const self: SelfSim = {
    p50: quantile(pairs, 0.5),
    p90: quantile(pairs, 0.9),
    p95: quantile(pairs, 0.95),
    p99: quantile(pairs, 0.99),
    max: pairs[pairs.length - 1],
  };
  console.error(`  self-similarity over ${pairs.length} pairs: p50 ${self.p50.toFixed(4)} p95 ${self.p95.toFixed(4)} max ${self.max.toFixed(4)}`);

  const onTopic: number[][] = [];
  for (const testCase of suite.cases) onTopic.push(await topCosines(project.id, testCase.query, embedder));
  const technical: Array<{ probe: string; cosines: number[]; topHit: string }> = [];
  for (const probe of OFF_TOPIC_TECHNICAL) {
    technical.push({
      probe,
      cosines: await topCosines(project.id, probe, embedder),
      topHit: await topHitId(project.id, probe, embedder),
    });
  }
  console.error(`  scored ${onTopic.length} on-topic and ${technical.length} technical probes`);

  const perSignal: Record<string, any> = {};
  for (const name of SIGNAL_NAMES) {
    const on = onTopic.map(c => signals(c, self)[name]);
    const off = technical.map(t => signals(t.cosines, self)[name]);
    const onMin = Math.min(...on);
    const offMax = Math.max(...off);
    perSignal[name] = {
      onMin,
      offMax,
      gap: onMin - offMax,
      // How many REAL queries fall at or below the single worst piece of junk. The size of the
      // overlap a threshold would have to live inside, which the gap sign alone does not show.
      onTopicUnderWorstJunk: on.filter(v => v <= offMax).length,
      auc: auc(on, off),
    };
  }

  results.push({
    preset: id,
    model: preset.model,
    shippedFloor: relevanceFloorFor(preset.model),
    selfSimilarity: self,
    signals: perSignal,
    worstTechnical: [...technical]
      .sort((a, b) => b.cosines[0] - a.cosines[0])
      .slice(0, 5)
      .map(t => ({ probe: t.probe, cosine: t.cosines[0], matched: t.topHit })),
    raw: { onTopic, technical },
  });

  // Left on disk deliberately. `closeDb` releases the handle asynchronously on Windows, so an
  // immediate unlink races it and throws EBUSY after the measurement has already succeeded --
  // losing the whole run to cleanup. `sweep-preset-floor.ts` leaves its scratch dirs too; the
  // OS temp sweep collects them.
  await closeDb();
}

console.log('\n## AUC per signal (1.0 = perfect separation, 0.5 = coin flip)\n');
console.log(`| preset | ${SIGNAL_NAMES.join(' | ')} |`);
console.log(`| --- | ${SIGNAL_NAMES.map(() => '---').join(' | ')} |`);
for (const row of results) {
  console.log(`| ${row.preset} | ${SIGNAL_NAMES.map(n => row.signals[n].auc.toFixed(3)).join(' | ')} |`);
}

console.log('\n## Gap = min(on-topic) - max(technical junk); positive means a threshold exists\n');
console.log(`| preset | ${SIGNAL_NAMES.join(' | ')} |`);
console.log(`| --- | ${SIGNAL_NAMES.map(() => '---').join(' | ')} |`);
for (const row of results) {
  console.log(`| ${row.preset} | ${SIGNAL_NAMES.map(n => row.signals[n].gap.toFixed(4)).join(' | ')} |`);
}

console.log('\n## Overlap: how many of 135 real queries score at or below the worst junk\n');
console.log(`| preset | ${SIGNAL_NAMES.join(' | ')} |`);
console.log(`| --- | ${SIGNAL_NAMES.map(() => '---').join(' | ')} |`);
for (const row of results) {
  console.log(`| ${row.preset} | ${SIGNAL_NAMES.map(n => String(row.signals[n].onTopicUnderWorstJunk)).join(' | ')} |`);
}

console.log('\n## Worst technical probes, with the fixture they matched (contamination check)\n');
for (const row of results) {
  console.log(`\n**${row.preset}** (self p50 ${row.selfSimilarity.p50.toFixed(4)}, p95 ${row.selfSimilarity.p95.toFixed(4)})`);
  for (const w of row.worstTechnical) console.log(`- ${w.cosine.toFixed(4)} \`${w.probe}\` -> ${w.matched}`);
}

if (jsonOut) {
  await fs.writeFile(jsonOut, JSON.stringify({ generatedFrom: 'scripts/probe-relative-floor.ts', results }, null, 2));
  console.error(`\nwrote ${jsonOut}`);
}
