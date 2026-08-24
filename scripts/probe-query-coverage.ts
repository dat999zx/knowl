/**
 * The measurement that decides whether #169 direction 1 is alive.
 *
 * `docs/evals/preset-floor-sweep.md` closed direction 2: no embedding preset separates on-topic
 * from technical off-topic queries, because the overlap is a property of cosine rather than of any
 * one model. That left direction 1 -- a relative or corpus-free signal instead of an absolute
 * cosine cut.
 *
 * `queryCoverage` (`src/store/search.ts:84`) is a candidate that already exists and is already
 * computed on every lexical hit: the share of the query's distinct terms an item contains,
 * prefix-matched. Its own doc comment claims exactly the property the floor needs -- "unlike BM25
 * it means the same thing in every repo: it is a property of the item and the query, with no
 * corpus statistics in it."
 *
 * THE RISK THIS SCRIPT EXISTS TO TEST. Coverage separates junk only if genuinely on-topic queries
 * score high. A correctly-VAGUE on-topic question -- "how do we do releases", asked of a store that
 * knows exactly how -- contains few distinct terms and may match none of them literally, so it
 * could score as low as junk. If that class scores low, coverage is a precision trap that abstains
 * on the queries a human is most likely to type, and direction 1 dies here rather than after
 * someone ships a threshold. That is the whole point: measure the failure mode first.
 *
 * Probes are three classes, and the vague class is the verdict.
 *
 * CONTAMINATION WARNING, learned the hard way. This runs against the repo's REAL store, which
 * contains atoms about retrieval evaluation -- and those atoms quote off-topic probe strings
 * verbatim. `recipe for sourdough bread starter` scores coverage 1.000 here, correctly, because
 * the terms really are in the corpus. Never probe a Knowl store with a string its own eval docs
 * discuss. The technical probes below were chosen to name domains this project has never written
 * about, and each is checked against that failure by reporting the atom it matched.
 *
 * Usage: npx tsx scripts/probe-query-coverage.ts [--json out.json]
 */
import fs from 'node:fs/promises';
import { findProjectRoot } from '../src/core/config.js';
import { closeDb, initDb } from '../src/store/database.js';
import { getProjectByRootPath } from '../src/store/repository.js';
import { searchKnowledgeItemsRanked, queryTermCount } from '../src/store/search.js';

type Probe = { query: string; expect: 'abstain' | 'answer' };

/** Technical, same register as the corpus, about domains this project has never touched. */
const OFF_TECHNICAL: Probe[] = [
  { query: 'sourdough hydration bulk ferment banneton', expect: 'abstain' },
  { query: 'trombone slide positions overtone series', expect: 'abstain' },
  { query: 'perennial pruning espalier rootstock grafting', expect: 'abstain' },
  { query: 'sonnet volta iambic pentameter enjambment', expect: 'abstain' },
  { query: 'kayak eskimo roll paddle feathering', expect: 'abstain' },
  { query: 'sourdough starter discard crumb', expect: 'abstain' },
];

/** On-topic and specific: the easy case, and the one already known to score 1.000. */
const ON_SPECIFIC: Probe[] = [
  { query: 'relevance floor per model preset cosine abstain', expect: 'answer' },
  { query: 'supersession retired active retrieval benchmark', expect: 'answer' },
  { query: 'workspace federated query grouping repo scope', expect: 'answer' },
];

/**
 * On-topic and VAGUE -- the class that decides this. Each is a question this store can genuinely
 * answer, phrased the way somebody half-remembers it rather than the way the atom is written.
 * Few distinct terms, none of them jargon, no overlap engineered in.
 */
const ON_VAGUE: Probe[] = [
  { query: 'how do we do releases', expect: 'answer' },
  { query: 'why is startup slow', expect: 'answer' },
  { query: 'what happens when two facts disagree', expect: 'answer' },
  { query: 'how does it decide what to show me', expect: 'answer' },
  { query: 'where does the data live', expect: 'answer' },
  { query: 'what did we decide about staleness', expect: 'answer' },
  { query: 'is there a way to see all the settings', expect: 'answer' },
  { query: 'how do agents talk to this', expect: 'answer' },
];

const jsonOut = (() => {
  const i = process.argv.indexOf('--json');
  return i >= 0 ? process.argv[i + 1] : undefined;
})();

const root = await findProjectRoot(process.cwd());
if (!root) throw new Error('No Knowl project found from the working directory.');
await initDb(root);
const project = await getProjectByRootPath(root);
if (!project) throw new Error('Project not found in the database.');

async function probe(p: Probe) {
  const hits = await searchKnowledgeItemsRanked(project!.id, { query: p.query, status: 'active', limit: 10 });
  const terms = queryTermCount(p.query);
  let best = 0;
  let bestTitle = '(no hit)';
  for (const hit of hits as Array<{ item: { title: string }; coverage: number }>) {
    if (hit.coverage > best) { best = hit.coverage; bestTitle = hit.item.title; }
  }
  return { ...p, coverage: best, terms, hits: hits.length, matched: bestTitle };
}

const classes: Array<[string, Probe[]]> = [
  ['off-technical', OFF_TECHNICAL],
  ['on-specific', ON_SPECIFIC],
  ['on-vague', ON_VAGUE],
];

const results: any[] = [];
for (const [label, probes] of classes) {
  console.log(`\n## ${label}\n`);
  console.log('| coverage | terms | query | best-covering atom |');
  console.log('| --- | --- | --- | --- |');
  for (const p of probes) {
    const r = await probe(p);
    results.push({ class: label, ...r });
    const title = r.matched.length > 58 ? `${r.matched.slice(0, 58)}…` : r.matched;
    console.log(`| **${r.coverage.toFixed(3)}** | ${r.terms} | \`${r.query}\` | ${title} |`);
  }
}

const by = (label: string) => results.filter(r => r.class === label).map(r => r.coverage).sort((a, b) => a - b);
const off = by('off-technical');
const spec = by('on-specific');
const vague = by('on-vague');
const line = (label: string, xs: number[]) =>
  `${label.padEnd(14)} n=${xs.length}  min ${xs[0].toFixed(3)}  p50 ${xs[Math.floor(xs.length / 2)].toFixed(3)}  max ${xs[xs.length - 1].toFixed(3)}`;

console.log('\n## Distributions\n');
console.log('```');
console.log(line('off-technical', off));
console.log(line('on-specific', spec));
console.log(line('on-vague', vague));
console.log('```');

// The verdict is a single comparison: does the WEAKEST on-topic query outscore the STRONGEST
// piece of junk? That is the gap a threshold would have to live in, and it is measured against
// the vague class because the specific class was never in doubt.
const onMin = Math.min(spec[0], vague[0]);
const offMax = off[off.length - 1];
console.log(`\n**Gap: on-topic min ${onMin.toFixed(3)} vs off-technical max ${offMax.toFixed(3)} = `
  + `${onMin - offMax >= 0 ? '+' : ''}${(onMin - offMax).toFixed(3)}**`);
console.log(onMin > offMax
  ? '\nSEPARABLE on this probe set: a threshold exists between them.'
  : '\nNOT SEPARABLE: the vague on-topic class reaches down into the junk, which is the failure mode this script was written to find.');

if (jsonOut) {
  await fs.writeFile(jsonOut, JSON.stringify({ results, onMin, offMax }, null, 2));
  console.error(`\nwrote ${jsonOut}`);
}
await closeDb();
