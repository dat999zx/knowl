/**
 * The measurement PR #180 shipped without: what the reversal detector does on REAL positives.
 *
 * The review of #180 measured precision on this repo's store and found 25 fires, all narrative
 * mentions, zero true reversals. That is a noise floor, not an evaluation -- with no positive to
 * score against, "does this detector work" was unanswered, and two candidate precision gates
 * (a cue-sentence length cap, a symmetric-coverage requirement) each separated all 25 negatives
 * from the ONE synthetic positive in the test file. Fitting a constant to a single point is the
 * failure #182 records for the relevance floor, so both were left out pending real positives.
 *
 * THE GROUND TRUTH THAT WAS ALREADY IN THE STORE. Every `superseded_by_id` link is a reversal
 * that genuinely happened: a human or agent decided item B replaces item A. Self-joining
 * `knowledge_items` on that column yields ~100 labelled positive pairs, the same population
 * `docs/evals`-adjacent probes have replayed predicates over before (the polarity guard was
 * cleared as 0-of-101 this way).
 *
 * THE SUBSET THAT ACTUALLY TESTS THIS DETECTOR. Most supersessions here were INFERRED from
 * `sameSubjectTitle`, meaning the two titles were already in a subset relation. Those are cases
 * the write path already catches, so a reversal detector is not needed for them and counting
 * them would inflate recall with work something else does. The detector's stated job is the pair
 * whose titles are UNRELATED -- exactly the Postgres/SQLite shape. So the population is split:
 *
 *   - title-linked   : sameSubjectTitle already true. Reported, but not the detector's job.
 *   - title-unrelated: the real target. Recall here is the number that matters.
 *
 * WHAT EACH GATE COSTS. The two candidate gates are replayed over the positives, so their cost is
 * measured in recall lost rather than argued about. A gate that keeps precision and drops real
 * reversals is worse than the noise it removes.
 */
import path from 'node:path';
import { closeDb, initDb } from '../src/store/database.js';
import * as repo from '../src/store/repository.js';
import {
  detectReversal,
  distinctiveTitleCap,
  duplicateTokens,
  reversalCueSentences,
  sameSubjectTitle,
  titleTokenFrequency,
} from '../src/store/knowledge-writer.js';

const root = process.argv[2] ?? process.cwd();
await initDb(path.resolve(root));

const all = await repo.listKnowledgeItems();
const byId = new Map(all.map(item => [item.id, item]));
const active = all.filter(item => item.status === 'active');

// The frequency table the detector uses at write time is built from ACTIVE titles. A superseded
// predecessor is no longer active, so scoring it needs its title's tokens counted the way they
// were when it was live: add the retired side back in for this replay only.
const positives = all
  .filter(item => item.supersededById && byId.has(item.supersededById))
  .map(retired => ({ retired, superseder: byId.get(retired.supersededById!)! }));

const frequency = titleTokenFrequency([
  ...active.map(item => item.title),
  ...positives.map(pair => pair.retired.title),
]);
const cap = distinctiveTitleCap(active.length);

type Row = {
  titleLinked: boolean;
  fired: boolean;
  sentenceTokens?: number;
  shareOfSentence?: number;
  retired: string;
  superseder: string;
  sentence?: string;
};

const rows: Row[] = positives.map(({ retired, superseder }) => {
  const titleLinked = sameSubjectTitle(superseder, retired);
  const cues = reversalCueSentences(superseder.content);
  const match = cues.length ? detectReversal(cues, retired.title, frequency, cap) : null;
  if (!match) return { titleLinked, fired: false, retired: retired.title, superseder: superseder.title };
  const cue = cues.find(sentence => sentence.sentence === match.sentence)!;
  const distinctive = [...duplicateTokens(retired.title)].filter(
    token => (frequency.get(token) ?? 0) <= cap,
  );
  const shared = distinctive.filter(token => cue.tokens.has(token)).length;
  return {
    titleLinked,
    fired: true,
    sentenceTokens: cue.tokens.size,
    shareOfSentence: shared / cue.tokens.size,
    retired: retired.title,
    superseder: superseder.title,
    sentence: match.sentence,
  };
});

const unrelated = rows.filter(row => !row.titleLinked);
const linked = rows.filter(row => row.titleLinked);
const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`);

console.log(`active items          : ${active.length}`);
console.log(`labelled positives    : ${rows.length} real supersessions`);
console.log(`  title-linked        : ${linked.length} (sameSubjectTitle already true -- write path catches these)`);
console.log(`  title-unrelated     : ${unrelated.length} (the detector's actual job)`);
console.log('');
console.log(`RECALL, title-unrelated : ${unrelated.filter(r => r.fired).length}/${unrelated.length} = ${pct(unrelated.filter(r => r.fired).length, unrelated.length)}`);
console.log(`RECALL, title-linked    : ${linked.filter(r => r.fired).length}/${linked.length} = ${pct(linked.filter(r => r.fired).length, linked.length)}`);
console.log('');

const hits = rows.filter(row => row.fired);
if (hits.length) {
  console.log('WHAT THE GATES WOULD COST, replayed over the real positives that fire:');
  for (const capTokens of [10, 12, 15, 20, 30]) {
    const kept = hits.filter(row => row.sentenceTokens! <= capTokens).length;
    console.log(`  cue-sentence tokens <= ${String(capTokens).padStart(2)} : keeps ${kept}/${hits.length} real reversals (${pct(kept, hits.length)})`);
  }
  for (const share of [0.2, 0.3, 0.4, 0.5]) {
    const kept = hits.filter(row => row.shareOfSentence! >= share).length;
    console.log(`  share of sentence   >= ${share.toFixed(1)} : keeps ${kept}/${hits.length} real reversals (${pct(kept, hits.length)})`);
  }
  console.log('');
  console.log('THE POSITIVES IT CATCHES:');
  for (const row of hits) {
    console.log(`  ${row.titleLinked ? '[title-linked]   ' : '[title-unrelated]'} ${row.superseder.slice(0, 58)}`);
    console.log(`     retired: ${row.retired.slice(0, 66)}`);
    console.log(`     tokens=${row.sentenceTokens} share=${row.shareOfSentence!.toFixed(2)} "${row.sentence!.replace(/\s+/g, ' ').slice(0, 96)}"`);
  }
}

const missedUnrelated = unrelated.filter(row => !row.fired);
console.log('');
console.log(`MISSED, title-unrelated (${missedUnrelated.length}) -- sample of 10:`);
for (const row of missedUnrelated.slice(0, 10)) {
  console.log(`  ${row.superseder.slice(0, 62)}`);
  console.log(`     did not name: ${row.retired.slice(0, 62)}`);
}

await closeDb();
