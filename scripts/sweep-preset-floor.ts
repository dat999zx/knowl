/**
 * The measurement issue #169 asks for, across every shipped preset at once.
 *
 * #169's finding is that `granite-small-en-r2` -- the default -- has no gap to put a floor in:
 * on-topic min 0.7637 against off-topic max 0.7644, already crossed when 0.76 was calibrated.
 * Its cheapest direction is "change the default preset", and the thing blocking that is that
 * nobody has measured whether the presets with a wider gap can hold the recall the default has.
 * A gap without recall is not an argument, so this runs both on the same corpus in one process.
 *
 * Method follows `docs/evals/per-model-floor.md`: a fresh scratch store per preset so vectors are
 * rebuilt under that model, on-topic = every case of the semantic suite, off-topic = probes with
 * no answer in those fixtures, and the quantity is `bestCosine` -- the highest RAW cosine among
 * judged candidates, which is what `scoreCandidates` actually tests. Read from
 * `explanation.contributions.semantic`, the clamped raw cosine before `rescaleSemantic` sees it.
 *
 * Two deliberate departures from that document, because they move the numbers:
 *   - The suite is 135 cases now, not the 110 it measured.
 *   - Its 15 off-topic probes were never written down verbatim -- three are quoted and the rest
 *     are an ellipsis. OFF_TOPIC below reconstructs a 15-probe set from those three plus the
 *     probes in `diagnose-offtopic-floor.ts` and `diagnose-floor-threshold.ts`.
 * So absolute cosines here are NOT comparable to that table row for row. Every preset sees an
 * identical corpus and identical probes inside one run, so the comparison BETWEEN presets holds,
 * and that is the question #169 actually asks.
 *
 * Usage: npx tsx scripts/sweep-preset-floor.ts [--presets a,b] [--json out.json]
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
import { evaluateRetrieval, type RetrievalEvaluationCase } from '../src/store/retrieval-evaluation.js';
import { VECTOR_PRESETS, PRESET_IDS, relevanceFloorFor } from '../src/core/vector-profile.js';

/**
 * Off-topic probes in two classes, and the split is the point.
 *
 * `general` is the class `per-model-floor.md` measured: consumer questions about food, sport and
 * travel. The 50 fixtures are generic backend-SaaS engineering, so this class is trivially far
 * from them and a smoke test rather than a hazard.
 *
 * `technical` is where #169 actually lives. Its reproduction case was `kubernetes ingress nginx
 * tls renewal` scoring 0.7928 against a store that knew nothing about it -- a query written in
 * the same register as the corpus, about a subject the corpus does not hold. That is the query
 * an integrator really sends, and it is the one no consumer probe can stand in for. Each of
 * these names a technical domain absent from the fixture list (iOS, gamedev, ML training,
 * embedded, compilers, 3D, media, typesetting, plotting, audio), so a hit is a false positive.
 *
 * Deliberately NOT included: kafka rebalancing, SQL window functions, CDN cache headers. Those
 * are adjacent to `queue-retry`, `db-postgres` and `cdn-assets`, so a high cosine there is
 * arguably correct and would flatter the floor rather than test it.
 */
const OFF_TOPIC_GENERAL = [
  'how do I bake sourdough bread',
  'what is the capital of Peru',
  'best hiking trails in patagonia',
  'premier league fixtures this weekend',
  'symptoms of vitamin d deficiency',
  'cheapest flights to reykjavik',
  'who won the 1998 world cup',
  'recipe for lemon drizzle cake',
  'when did the roman empire fall',
  'how to repair a bicycle tyre puncture',
  'tallest mountain in south america',
  'what temperature to roast a chicken',
  'lyrics to a nineties britpop single',
  'how long does a tortoise live',
  'best time of year to visit kyoto',
];

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
];

const OFF_TOPIC = [...OFF_TOPIC_GENERAL, ...OFF_TOPIC_TECHNICAL];

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
  cases: RetrievalEvaluationCase[];
};

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { min: s[0], p05: at(0.05), p50: at(0.5), max: s[s.length - 1] };
};

/** Best RAW cosine over judged candidates, floor disabled so nothing abstains before we see it. */
async function bestCosine(projectId: string, query: string, embedder: any): Promise<number> {
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
  let best = 0;
  for (const row of rows as any[]) {
    if (row.explanation?.uncalibrated) continue;
    best = Math.max(best, row.explanation?.contributions?.semantic ?? 0);
  }
  return best;
}

const baseConfig = await loadConfig(process.cwd());
const results: any[] = [];

for (const id of presets) {
  const preset = VECTOR_PRESETS[id];
  if (!preset) throw new Error(`Unknown preset: ${id}`);
  const startedAt = Date.now();
  console.error(`\n--- ${id} (${preset.model}, ${preset.sizeMb}MB, pooling ${preset.pooling}) ---`);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), `knowl-sweep-${id}-`));
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await initDb(root);
  const project = await repo.createProject(root, `sweep ${id}`);

  const ids = new Map<string, string>();
  for (const fixture of suite.fixtures) {
    const item = await repo.createKnowledgeItem(project.id, fixture as any);
    ids.set(fixture.id, item.id);
  }

  // The preset under test, not the repo's. `cacheDir` is left unset on purpose so weights land
  // in the shared home cache and a second run of this script downloads nothing.
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

  const onTopic: number[] = [];
  for (const testCase of suite.cases) onTopic.push(await bestCosine(project.id, testCase.query, embedder));
  const general: number[] = [];
  for (const probe of OFF_TOPIC_GENERAL) general.push(await bestCosine(project.id, probe, embedder));
  const technical: Array<{ probe: string; cosine: number }> = [];
  for (const probe of OFF_TOPIC_TECHNICAL) technical.push({ probe, cosine: await bestCosine(project.id, probe, embedder) });
  const offTopic = [...general, ...technical.map(t => t.cosine)];

  // Recall at the preset's OWN shipped floor -- the configuration a user actually runs.
  const floor = relevanceFloorFor(preset.model);
  const cases = suite.cases.map(c => ({
    ...c,
    expectedItemIds: c.expectedItemIds.map(x => ids.get(x) ?? x),
    mustNotReturn: (c.mustNotReturn ?? []).map(x => ids.get(x) ?? x),
  }));
  const evaluation = await evaluateRetrieval(cases, async (testCase) => {
    const items = (await rankKnowledge(project.id, {
      query: testCase.query,
      status: 'active',
      limit: testCase.limit,
      vector: {
        enabled: true,
        profileFingerprint: embedder.profileFingerprint,
        embedding: await embedder.embedQuery(testCase.query),
        relevanceFloor: floor,
      },
    })).map(({ explanation: _e, ...item }: any) => item);
    return { itemIds: items.map((i: any) => i.id), staleItemIds: [], latencyMs: 0, contextChars: 0 };
  });

  const on = stats(onTopic);
  const off = stats(offTopic);
  const gen = stats(general);
  const tech = stats(technical.map(t => t.cosine));
  const worstTechnical = [...technical].sort((a, b) => b.cosine - a.cosine)[0];
  const row = {
    preset: id,
    model: preset.model,
    sizeMb: preset.sizeMb,
    floor,
    onTopicMin: on.min, onTopicP05: on.p05, onTopicP50: on.p50,
    // The size of the overlap, which is the number a threshold actually has to live with:
    // how many REAL queries score at or below the single best piece of technical junk.
    onTopicUnderWorstTechnical: onTopic.filter(c => c <= tech.max).length,
    offTopicP50: off.p50, offTopicMax: off.max,
    generalMax: gen.max,
    technicalMax: tech.max,
    worstTechnicalProbe: worstTechnical.probe,
    // The gap that matters: on-topic min against the HARDEST junk, not the easiest.
    gap: on.min - off.max,
    gapVsGeneral: on.min - gen.max,
    gapVsTechnical: on.min - tech.max,
    // What the shipped floor actually does with these two populations.
    falseAbstentions: floor === null ? null : onTopic.filter(c => c < floor).length,
    junkCaught: floor === null ? null : offTopic.filter(c => c < floor).length,
    technicalJunkCaught: floor === null ? null : technical.filter(t => t.cosine < floor).length,
    recallAt3: evaluation.metrics.recallAt3,
    recallAt10: evaluation.metrics.recallAt10,
    mrr: evaluation.metrics.mrr,
    ndcg: evaluation.metrics.ndcg,
    onTopicCases: suite.cases.length,
    seconds: Math.round((Date.now() - startedAt) / 1000),
  };
  results.push(row);
  console.error(`  gap ${row.gap.toFixed(4)}  R@3 ${row.recallAt3.toFixed(4)}  MRR ${row.mrr.toFixed(4)}  (${row.seconds}s)`);

  await closeDb();
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
}

const sign = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(4)}`;

console.log(`\n## Gap, by junk class. n=${suite.cases.length} on-topic, ${OFF_TOPIC_GENERAL.length} general, ${OFF_TOPIC_TECHNICAL.length} technical\n`);
console.log('| preset | on min | general max | gap vs general | technical max | **gap vs technical** |');
console.log('| --- | --- | --- | --- | --- | --- |');
for (const r of results) {
  console.log(`| ${r.preset} | ${r.onTopicMin.toFixed(4)} | ${r.generalMax.toFixed(4)} | ${sign(r.gapVsGeneral)} | ${r.technicalMax.toFixed(4)} | **${sign(r.gapVsTechnical)}** |`);
}
console.log('\nWorst technical probe per preset:');
for (const r of results) console.log(`- ${r.preset}: \`${r.worstTechnicalProbe}\` at ${r.technicalMax.toFixed(4)}`);

console.log(`\n## Overlap size -- real queries scoring at or below the best technical junk\n`);
console.log('| preset | on p05 | on min | technical max | on-topic cases buried under it |');
console.log('| --- | --- | --- | --- | --- |');
for (const r of results) {
  const pct = (100 * r.onTopicUnderWorstTechnical / r.onTopicCases).toFixed(0);
  console.log(`| ${r.preset} | ${r.onTopicP05.toFixed(4)} | ${r.onTopicMin.toFixed(4)} | ${r.technicalMax.toFixed(4)} | **${r.onTopicUnderWorstTechnical}/${r.onTopicCases}** (${pct}%) |`);
}

console.log(`\n## What the shipped floor does with those populations\n`);
console.log('| preset | floor | false abstentions | junk caught | technical junk caught |');
console.log('| --- | --- | --- | --- | --- |');
for (const r of results) {
  console.log(`| ${r.preset} | ${r.floor ?? 'null'} | ${r.falseAbstentions ?? '-'}/${suite.cases.length} | ${r.junkCaught ?? '-'}/${OFF_TOPIC.length} | ${r.technicalJunkCaught ?? '-'}/${OFF_TOPIC_TECHNICAL.length} |`);
}
console.log(`\n## Recall at the shipped floor for each preset\n`);
console.log('| preset | size | R@3 | R@10 | MRR | nDCG | run |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const r of results) {
  console.log(`| ${r.preset} | ${r.sizeMb}MB | ${r.recallAt3.toFixed(4)} | ${r.recallAt10.toFixed(4)} | ${r.mrr.toFixed(4)} | ${r.ndcg.toFixed(4)} | ${r.seconds}s |`);
}

if (jsonOut) {
  await fs.writeFile(
    jsonOut,
    JSON.stringify({ timestamp: new Date().toISOString(), onTopicCases: suite.cases.length, offTopicProbes: OFF_TOPIC, results }, null, 2),
  );
  console.error(`\nwrote ${jsonOut}`);
}
