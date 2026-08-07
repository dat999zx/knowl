/**
 * How much ranking signal does the semantic half actually carry?
 *
 * Fusion is `alpha * semantic + (1 - alpha) * lexical` at alpha 0.8, so the semantic term holds
 * four fifths of the weight. That is only four fifths of the *signal* if cosines actually spread
 * out across candidates. If a model packs every cosine into a narrow band, the semantic term is
 * nearly constant, and the 0.2-weighted lexical term decides the order despite its small weight.
 *
 * Usage: npx tsx scripts/diagnose-cosine-spread.ts [preset]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { findProjectRoot, loadConfig } from '../src/core/config.js';
import { createLocalEmbeddingProvider } from '../src/ai/embeddings.js';

const datasetPath = path.resolve('docs/evals/semantic-suite.json');
const dataset = JSON.parse(await fs.readFile(datasetPath, 'utf-8')) as {
  cases: Array<{ id: string; tier?: string; query: string; expectedItemIds: string[] }>;
  fixtures: Array<{ id: string; title: string; content: string; tags?: string[] }>;
};

const root = await findProjectRoot(process.cwd());
const config = await loadConfig(root);
const embedder = await createLocalEmbeddingProvider(config, root);

const cosine = (a: number[], b: number[]) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

// Embed the fixtures the same way the index does: title, content and tags together.
const fixtureText = (f: typeof dataset.fixtures[number]) =>
  `${f.title}\n${f.content}\n${(f.tags ?? []).join(' ')}`;
const fixtureVectors: number[][] = [];
for (const f of dataset.fixtures) fixtureVectors.push((await embedder.embed([fixtureText(f)]))[0] as number[]);

console.log(`model: ${embedder.profileFingerprint}`);
console.log(`fixtures: ${dataset.fixtures.length}  cases: ${dataset.cases.length}\n`);

const gaps: number[] = [];
const spreads: number[] = [];
for (const testCase of dataset.cases) {
  const q = (await embedder.embed([testCase.query]))[0] as number[];
  const scores = fixtureVectors
    .map((v, i) => ({ id: dataset.fixtures[i].id, cos: cosine(q, v) }))
    .sort((a, b) => b.cos - a.cos);
  // The margin the fusion has to work with: how far rank 1 stands above rank 2.
  gaps.push(scores[0].cos - scores[1].cos);
  // The whole usable range across the candidate page.
  spreads.push(scores[0].cos - scores[9].cos);
}

const stat = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return `min=${s[0].toFixed(4)} p25=${at(0.25).toFixed(4)} median=${at(0.5).toFixed(4)} p75=${at(0.75).toFixed(4)} max=${s[s.length - 1].toFixed(4)}`;
};

console.log('cosine gap, rank1 - rank2 (the margin fusion must not overturn):');
console.log(`  ${stat(gaps)}`);
console.log('\ncosine spread, rank1 - rank10 (the whole semantic signal on a page):');
console.log(`  ${stat(spreads)}`);

/**
 * The comparison that matters. The lexical half is a normalised [0,1] score, so its contribution
 * spans up to (1 - alpha) * 1.0 = 0.2. The semantic half contributes alpha * (its actual spread).
 * If alpha * spread is smaller than 0.2, lexical decides the ranking whatever the weights say.
 */
const ALPHA = 0.8;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const semanticSwing = ALPHA * median(spreads);
console.log(`\nmedian semantic swing across a page: ${ALPHA} x ${median(spreads).toFixed(4)} = ${semanticSwing.toFixed(4)}`);
console.log(`maximum lexical swing:               ${(1 - ALPHA).toFixed(1)} x 1.0000 = ${(1 - ALPHA).toFixed(4)}`);
console.log(
  semanticSwing < (1 - ALPHA)
    ? '=> lexical can overturn any semantic ordering on this model.'
    : '=> semantic dominates, as the weights intend.',
);
