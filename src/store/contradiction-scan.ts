/**
 * The detected half of `knowl conflicts`.
 *
 * THE GAP THIS CLOSES. `knowl conflicts` promised "knowledge items that contradict each other"
 * and read only `conflictKey`/`conflictExclusive` -- declared on 3 of 937 active items in the
 * store that motivated this. Meanwhile the write path itself MANUFACTURES undeclared
 * contradictions on purpose: the polarity guard clamps "X" vs "X no longer" to coexist rather
 * than letting either retire the other, tells the caller once in the write result, and then no
 * surface can ever list the pair again. A reversal stored under an unrelated title
 * ("Database choice: Postgres for everything" vs a SQLite decision whose content says the
 * Postgres plan is abandoned) was worse: silent at write AND invisible here, reproduced
 * end-to-end 2026-08-24.
 *
 * Two detected kinds, in order of confidence:
 *
 * - `polarity`: titles on the same subject differing only by polarity tokens. Exact by
 *   construction -- these are precisely the pairs the write path's own guard creates -- so
 *   they are listed as contradictions, not candidates.
 * - `reversal`: one item's content contains a sentence with a reversal cue naming another
 *   item's distinctive title tokens. Candidate-grade (see `detectReversal` for the measured
 *   rates), so each row quotes the cue sentence for the reader to judge.
 *
 * A scan, not an index: it reads the whole store on request. That is the right cost model for
 * an inspection command a person runs on purpose, and the wrong one for the write path, which
 * is why the write path's advisory gates on the cue scan instead of calling this.
 */
import * as repo from './repository.js';
import {
  detectReversal,
  differsOnlyInPolarity,
  distinctiveTitleCap,
  reversalCueSentences,
  sameSubjectTitle,
  titleTokenFrequency,
} from './knowledge-writer.js';

export type ContradictionParty = { id: string; title: string; category: string };

export type PolarityContradiction = {
  kind: 'polarity';
  a: ContradictionParty;
  b: ContradictionParty;
};

export type ReversalCandidate = {
  kind: 'reversal';
  /** The item whose content carries the reversal sentence. */
  asserts: ContradictionParty;
  /** The item the sentence names. */
  names: ContradictionParty;
  cue: string;
  sentence: string;
};

export type DetectedContradictions = {
  polarity: PolarityContradiction[];
  reversalCandidates: ReversalCandidate[];
};

const party = (item: { id: string; title: string; category: string }): ContradictionParty => ({
  id: item.id,
  title: item.title,
  category: item.category,
});

export async function scanContradictions(): Promise<DetectedContradictions> {
  const items = (await repo.listKnowledgeItems()).filter(item => item.status === 'active');

  const polarity: PolarityContradiction[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (sameSubjectTitle(items[i], items[j]) && differsOnlyInPolarity(items[i], items[j])) {
        polarity.push({ kind: 'polarity', a: party(items[i]), b: party(items[j]) });
      }
    }
  }

  const frequency = titleTokenFrequency(items.map(item => item.title));
  const cap = distinctiveTitleCap(items.length);
  const reversalCandidates: ReversalCandidate[] = [];
  for (const asserting of items) {
    const cueSentences = reversalCueSentences(asserting.content);
    if (cueSentences.length === 0) continue;
    for (const named of items) {
      if (named.id === asserting.id) continue;
      const match = detectReversal(cueSentences, named.title, frequency, cap);
      if (match) {
        reversalCandidates.push({
          kind: 'reversal',
          asserts: party(asserting),
          names: party(named),
          cue: match.cue,
          sentence: match.sentence,
        });
      }
    }
  }

  return { polarity, reversalCandidates };
}
