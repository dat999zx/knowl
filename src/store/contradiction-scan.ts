/**
 * The detected half of `knowl conflicts`.
 *
 * THE GAP THIS CLOSES. `knowl conflicts` promised "knowledge items that contradict each other"
 * and read only `conflictKey`/`conflictExclusive` -- declared on 3 of 937 active items in the
 * store that motivated this. Meanwhile the write path itself MANUFACTURES undeclared
 * contradictions on purpose: the polarity guard clamps "X" vs "X no longer" to coexist rather
 * than letting either retire the other, tells the caller once in the write result, and then no
 * surface could ever list the pair again. This is that surface.
 *
 * ONE detected kind, and deliberately not two. `polarity` is titles on the same subject
 * differing only by polarity tokens: exact by construction, because these are precisely the
 * pairs the write path's own guard creates, so they are listed as contradictions rather than
 * candidates.
 *
 * WHY REVERSAL CANDIDATES ARE NOT LISTED HERE. The cue-sentence detector
 * (`detectReversal`, still live on the write path) was measured against 101 real
 * title-unrelated supersessions in this repo's own store: it fires on 4 of them, against 45
 * false candidates among active items -- roughly 4% recall at 8% precision, and no gate setting
 * swept reached 6% recall. `docs/evals/reversal-detector-recall.md` has the full sweep and the
 * replayable probe.
 *
 * That rate is survivable as a write-time advisory, where it is one dismissable note attached
 * to the writer's own sentence on 2.4% of writes. It is not survivable here. An inspection
 * command returns a LIST, an agent reads it as a work queue, and 45 candidates with no true
 * positive among them is worse than an empty list -- the empty list is at least honest about
 * what the store knows. Precision matters more per row on a surface that pages and truncates
 * than on one that speaks once, in context, to the person who just wrote the sentence.
 *
 * A scan, not an index: it reads the whole store on request. That is the right cost model for
 * an inspection command a person runs on purpose, and the wrong one for the write path, which
 * is why the write path's advisory gates on its own cue scan instead of calling this.
 */
import * as repo from './repository.js';
import { duplicateTokens, polarityTokensDiffer, sameSubjectTokens } from './knowledge-writer.js';

export type ContradictionParty = { id: string; title: string; category: string };

export type PolarityContradiction = {
  kind: 'polarity';
  a: ContradictionParty;
  b: ContradictionParty;
};

export type DetectedContradictions = {
  polarity: PolarityContradiction[];
};

const party = (item: { id: string; title: string; category: string }): ContradictionParty => ({
  id: item.id,
  title: item.title,
  category: item.category,
});

export async function scanContradictions(): Promise<DetectedContradictions> {
  const items = (await repo.listKnowledgeItems()).filter(item => item.status === 'active');

  // Tokenized once per item rather than inside each predicate: the pair loop below is O(n^2)
  // and the two title predicates tokenize both sides, so the naive form paid four tokenizations
  // per pair -- 1.5s of the 1.8s this scan cost on a real 1,033-item store, for a test that is
  // set comparison once the sets exist.
  const titleTokens = items.map(item => duplicateTokens(item.title));

  const polarity: PolarityContradiction[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (sameSubjectTokens(titleTokens[i], titleTokens[j])
        && polarityTokensDiffer(titleTokens[i], titleTokens[j])) {
        polarity.push({ kind: 'polarity', a: party(items[i]), b: party(items[j]) });
      }
    }
  }

  return { polarity };
}
