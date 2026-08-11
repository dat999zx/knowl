#!/usr/bin/env tsx
/**
 * Calibrates `governingDecisionThreshold` for an embedding preset against a real store.
 *
 * WHY THIS EXISTS. The guard's firing bar has to be per profile: a cosine means different things
 * in different embedding spaces, and unrelated items sit at ~0.84 under granite against ~0.51
 * under arctic. Choosing one shared constant would fire on nearly everything under one model and
 * nothing under another. That makes "add a preset" into "run a research pass" unless the
 * calibration is a command, which is what this is.
 *
 * WHY THE PROBES ARE NOT HAND-LABELLED. Labelling is what a first pass needs and not what a
 * recalibration can afford. This uses SELF-RETRIEVAL instead: each decision's own body, with its
 * title removed and only a middle slice kept, becomes a probe for finding that decision among all
 * the others. It is a proxy, and an optimistic one -- measured 2026-08-12, self-retrieval AUC ran
 * 0.9837 against 0.9471 on a 44-pair hand-labelled set, so it overstates discrimination by about
 * 3.7 points. What earns it its place is that the constant it produced (0.8867 for granite) landed
 * inside the 100%-precision band of that hand-labelled set. The cheap method transfers; that is
 * the finding this script depends on, and if it is ever shown not to hold for a new model, this
 * script is what stops being trustworthy.
 *
 * Usage:
 *   npx tsx scripts/calibrate-governing-decision.ts granite-small-en-r2
 *   npx tsx scripts/calibrate-governing-decision.ts bge-small-en --store ../other/.knowl/knowl.db
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { VECTOR_PRESETS, type PresetId } from '../src/core/vector-profile.js';
import { buildKnowledgeEmbeddingText } from '../src/store/vector-index.js';
import type { KnowledgeItem } from '../src/core/types.js';

const argv = process.argv.slice(2);
const presetId = argv.find(a => !a.startsWith('--')) as Exclude<PresetId, 'custom'> | undefined;
const storeArg = argv.indexOf('--store') >= 0 ? argv[argv.indexOf('--store') + 1] : '.knowl/knowl.db';

if (!presetId || !(presetId in VECTOR_PRESETS)) {
  console.error(`Usage: npx tsx scripts/calibrate-governing-decision.ts <preset> [--store <path>]`);
  console.error(`Presets: ${Object.keys(VECTOR_PRESETS).join(', ')}`);
  process.exit(1);
}
const preset = VECTOR_PRESETS[presetId];

/**
 * Below this the numbers are not worth printing as a constant.
 *
 * A threshold separates a real match from the best false one, and with a handful of decisions
 * there is no distribution of false ones to separate from. It is also the size at which the
 * z-score fallback stops being reachable at all (see MIN_POOL_FOR_Z in governing-decision.ts).
 */
const MIN_DECISIONS = 25;

const store = path.resolve(storeArg);
const db = new DatabaseSync(store);
const rows = db.prepare(`
  SELECT id, category, status, title, content, reasoning, tags
  FROM knowledge_items WHERE category = 'decision' AND status = 'active'
`).all() as Array<Record<string, string | null>>;

const asItem = (r: Record<string, string | null>): KnowledgeItem => ({
  id: r.id, category: 'decision', status: 'active',
  title: r.title ?? '', content: r.content ?? '',
  reasoning: r.reasoning ?? undefined,
  tags: r.tags ? (JSON.parse(r.tags) as string[]) : undefined,
} as KnowledgeItem);

// Bodies too short to slice cannot produce a probe that is not simply the whole document.
const decisions = rows.map(asItem).filter(d => (d.content ?? '').replace(/\s+/g, ' ').trim().length > 400);
console.error(`store: ${store}`);
console.error(`active decisions: ${rows.length} (${decisions.length} with enough body to probe)`);

if (decisions.length < MIN_DECISIONS) {
  console.error(`\nREFUSING TO CALIBRATE: ${decisions.length} usable decisions, need ${MIN_DECISIONS}.`);
  console.error(`A constant fitted to this few would be noise. Leave the preset uncalibrated --`);
  console.error(`undefined is a real answer that routes writes to the scale-free z-score fallback.`);
  process.exit(2);
}

// Text parity with production: the same builder the write path embeds through. Calibrating on
// title+content while production embeds title+content+reasoning+tags would fit the constant to
// text the guard never sees.
const CLIP = 1800;
const docOf = (d: KnowledgeItem) => buildKnowledgeEmbeddingText(d).slice(0, CLIP);
const probeOf = (d: KnowledgeItem) => {
  const body = (d.content ?? '').replace(/\s+/g, ' ').trim();
  const start = Math.floor(body.length * 0.3);
  return body.slice(start, start + CLIP);
};

const { pipeline } = await import('@huggingface/transformers');
console.error(`loading ${preset.model} (${preset.sizeMb} MB, ${preset.dtype}, ${preset.pooling})…`);
const extractor = await pipeline('feature-extraction', preset.model, { dtype: preset.dtype as never });

const unit = (v: ArrayLike<number>) => {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  return Array.from(v, x => x / n);
};
const embed = async (text: string) => unit((await extractor(text, { pooling: preset.pooling, normalize: false })).data);
const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

const pool: number[][] = [];
for (const d of decisions) pool.push(await embed(docOf(d)));
const probes: number[][] = [];
for (const d of decisions) probes.push(await embed(probeOf(d)));

// POSITIVES: the probe's own decision is the top-1, scored at that cosine. NEGATIVES: every other
// probe's best WRONG match. Both are what the guard actually fires on, so the threshold is fitted
// to the decision it will really make rather than to an abstract similarity.
const positives: number[] = [];
const negatives: number[] = [];
probes.forEach((pv, i) => {
  const scored = pool.map((x, j) => ({ j, s: cos(pv, x) })).sort((a, b) => b.s - a.s);
  if (scored[0].j === i) positives.push(scored[0].s);
  const wrong = scored.find(r => r.j !== i);
  if (wrong) negatives.push(wrong.s);
});

const quantile = (a: number[], q: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))];
const accuracyAt = (t: number) =>
  (positives.filter(s => s >= t).length + negatives.filter(s => s < t).length) / (positives.length + negatives.length);

let best = { t: 0, acc: 0 };
for (const t of [...new Set([...positives, ...negatives])].sort((a, b) => a - b)) {
  const acc = accuracyAt(t);
  if (acc > best.acc) best = { t, acc };
}
// The precision-first point: the lowest threshold that admits no false match at all. This is what
// granite ships (0.91 against a max-accuracy 0.8867) -- the guard interrupts a writer, so a quiet
// bar that is occasionally silent beats a chatty one that is occasionally wrong.
const cleanest = [...new Set([...positives, ...negatives])].sort((a, b) => a - b)
  .find(t => negatives.every(s => s < t)) ?? Math.max(...negatives) + 1e-6;

const recallAt = (t: number) => positives.filter(s => s >= t).length / positives.length;

console.log(`\n=== ${presetId} ===`);
console.log(`probes ${probes.length} | top-1 correct ${positives.length} | false-match samples ${negatives.length}`);
console.log(`median true-positive ${quantile(positives, 0.5).toFixed(4)}   median false-match ${quantile(negatives, 0.5).toFixed(4)}   p90 false-match ${quantile(negatives, 0.9).toFixed(4)}`);
console.log(`\n  max-accuracy threshold   ${best.t.toFixed(4)}   accuracy ${(100 * best.acc).toFixed(1)}%   recall ${(100 * recallAt(best.t)).toFixed(1)}%`);
console.log(`  precision-first threshold ${cleanest.toFixed(4)}   recall ${(100 * recallAt(cleanest)).toFixed(1)}%   (no false match at or above this)`);
console.log(`\nPaste into VECTOR_PRESETS['${presetId}'] in src/core/vector-profile.ts:`);
console.log(`    governingDecisionThreshold: ${Number(cleanest.toFixed(3))},`);
console.log(`\nThen measure the FIRE RATE on real writes before trusting it: a threshold fitted on`);
console.log(`decisions alone says how often it is RIGHT, never how often it SPEAKS. Both matter, and`);
console.log(`only the second can be measured on unlabelled data.`);
