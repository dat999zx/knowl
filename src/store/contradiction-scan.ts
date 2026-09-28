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
 * Detected kinds. `polarity` is titles on the same subject
 * differing only by polarity tokens: exact by construction, because these are precisely the
 * pairs the write path's own guard creates, so they are listed as contradictions rather than
 * candidates.
 *
 * `retired` and `sameSubject` exist because of #165. A same-subject write that retired a verified
 * fact told only its writer -- in an injection, the one party that was fooled -- and this scan
 * compared active items only, so the retired truth had nothing to pair with: 0 pairs in every
 * red-team store. `retired` lists verified items retired in the last `RETIRED_WINDOW_DAYS`;
 * `sameSubject` lists the pairs the write-path guards keep side by side when one side is verified.
 * Both are filtered to stay short on a real store (4 rows each on this repository's own, against
 * 147 superseded items and 838 same-subject active pairs unfiltered), for the precision reason
 * given below.
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
import type { KnowledgeItem, KnowledgeProvenance } from '../core/types.js';
import * as repo from './repository.js';
import { duplicateTokens, isVerifiedProvenance, polarityTokensDiffer, sameSubjectTokens } from './knowledge-writer.js';

/** A place to glance at recent swaps, not an audit log: `knowl_timeline` holds the full history. */
export const RETIRED_WINDOW_DAYS = 14;

export type ContradictionParty = { id: string; title: string; category: string };

export type PolarityContradiction = {
  kind: 'polarity';
  a: ContradictionParty;
  b: ContradictionParty;
};

export type VerifiedParty = ContradictionParty & { provenance: KnowledgeProvenance | null };

export type RetiredVerified = {
  kind: 'retired';
  retired: VerifiedParty;
  replacedBy: VerifiedParty | null;
  /** The retired item's `updatedAt`, which the supersede update stamps. */
  retiredAt: string;
};

export type SameSubjectPair = { kind: 'sameSubject'; a: VerifiedParty; b: VerifiedParty };

export type DetectedContradictions = {
  polarity: PolarityContradiction[];
  retired: RetiredVerified[];
  sameSubject: SameSubjectPair[];
};

const party = (item: { id: string; title: string; category: string }): ContradictionParty => ({
  id: item.id,
  title: item.title,
  category: item.category,
});

const verifiedParty = (item: KnowledgeItem): VerifiedParty => ({ ...party(item), provenance: item.provenance ?? null });

export async function scanContradictions(options: { now?: Date } = {}): Promise<DetectedContradictions> {
  const all = await repo.listKnowledgeItems();
  const items = all.filter(item => item.status === 'active');
  const byId = new Map(all.map(item => [item.id, item]));

  // Tokenized once per item rather than inside each predicate: the pair loop below is O(n^2)
  // and the two title predicates tokenize both sides, so the naive form paid four tokenizations
  // per pair -- 1.5s of the 1.8s this scan cost on a real 1,033-item store, for a test that is
  // set comparison once the sets exist.
  const titleTokens = items.map(item => duplicateTokens(item.title));

  const polarity: PolarityContradiction[] = [];
  const sameSubject: SameSubjectPair[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (!sameSubjectTokens(titleTokens[i], titleTokens[j])) continue;
      if (polarityTokensDiffer(titleTokens[i], titleTokens[j])) {
        polarity.push({ kind: 'polarity', a: party(items[i]), b: party(items[j]) });
      } else if (
        items[i].category === items[j].category
        && (isVerifiedProvenance(items[i]) || isVerifiedProvenance(items[j]))
      ) {
        sameSubject.push({ kind: 'sameSubject', a: verifiedParty(items[i]), b: verifiedParty(items[j]) });
      }
    }
  }

  const since = (options.now ?? new Date()).getTime() - RETIRED_WINDOW_DAYS * 86_400_000;
  const retired: RetiredVerified[] = all
    .filter(item => item.status === 'superseded' && isVerifiedProvenance(item)
      && Date.parse(item.updatedAt) >= since)
    .map((item): RetiredVerified => {
      const next = item.supersededById ? byId.get(item.supersededById) : undefined;
      return { kind: 'retired', retired: verifiedParty(item), replacedBy: next ? verifiedParty(next) : null, retiredAt: item.updatedAt };
    })
    // Newest first: the store returns creation order and MCP keeps five rows, so an injected swap
    // of a recently created fact would sort last and be the row the truncation hides.
    .sort((a, b) => b.retiredAt.localeCompare(a.retiredAt));

  return { polarity, retired, sameSubject };
}
