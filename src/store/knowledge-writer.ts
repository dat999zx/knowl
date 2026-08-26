import { CommitChange, EvidenceInput, EvidenceType, KnowledgeCategory, KnowledgeItem, KnowledgeProvenance, KnowledgeWriteValidationOptions } from '../core/types.js';
import { assertConfidenceInRange } from '../core/knowledge-validation.js';
import { searchKnowledgeItems } from './search.js';
import * as repo from './repository.js';
import { checkKnowledgeConflict, normalizeConflictScope } from './conflicts.js';
import { KnowledgeConflictError } from '../core/errors.js';
import { getConfigRoot, withClientTransaction } from './database.js';
import type { CrossRepoOverlap, OverlapSubject } from '../workspace/cross-repo-overlap.js';
import type { ActiveWorkspace } from '../workspace/resolve.js';
import { attachEvidenceToKnowledge, listEvidenceForItem, normalizeEvidenceLocator } from './evidence-repository.js';
import { normalizeAffectedPaths } from './freshness.js';
import { indexKnowledgeItemsBestEffort } from './write-embedding.js';
import { recordRederivationBestEffort } from './access-feedback.js';
import { governingDecisionForWrite, type GoverningDecision } from './governing-decision.js';

/**
 * Queue a committed write for the team, if this repo is connected.
 *
 * The import is deferred because `cloud` sits above `store` in the layer rule
 * (`tests/architecture/module-boundaries.test.ts`), and a static edge here would be upward and
 * forbidden. Deferring is the remedy that test names, and it is honest rather than a dodge: this
 * is optional behaviour that does nothing at all in a repo with no cloud pointer, so the module
 * should not be loaded to discover that.
 *
 * Never throws -- `autoStageAfterWrite` swallows, and so does this.
 */
async function stageWrittenItems(itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) return;
  try {
    const { autoStageAfterWrite } = await import('../cloud/auto-stage.js');
    await autoStageAfterWrite(itemIds);
  } catch { /* the write already committed; see above */ }
}

const DUPLICATE_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'does', 'for', 'from', 'in', 'is',
  'it', 'of', 'on', 'or', 'our', 'the', 'this', 'to', 'use', 'uses', 'using', 'what', 'with',
]);

/**
 * Tokens that flip a claim rather than extend it.
 *
 * THE FAILURE THIS EXISTS FOR. `sameSubjectTitle` is a token-SUBSET test, and none of these
 * words is a stop word, so an affirmative title is a strict subset of its own negation and the
 * subset test fires. Measured by running the real function, 2026-08-19:
 *
 *     "Push gate blocks default branch"  SUPERSEDES  "Push gate no longer blocks default branch"
 *     "Reranker is the right call"       SUPERSEDES  "Reranker is not the right call"
 *
 * The survivor then asserts the opposite of what was retired, silently. The first pair is this
 * project's own 2026-08-13 push-gate reversal: a title shape that, written twice across the
 * reversal, retires its own predecessor in whichever order the two writes happen to arrive.
 *
 * WHY NOT THE NUMERIC CASE TOO. The published prior art for this guard (muninndb's
 * `dedup_separation.go`) is built around numbers -- "$99" merging with "$149". That hole does not
 * exist here and the check would be dead weight: `duplicateTokens` splits on `[^a-z0-9_]+`, so
 * digits survive as tokens, `768` is absent from a title saying `1024`, the subset test already
 * fails, and the two atoms already coexist. Verified alongside the two cases above. Only polarity
 * is unguarded, because only polarity words are short, common, and absent from the stop list.
 *
 * DELIBERATELY NARROW. Ambiguous stems are left out -- `can` ("Can the gate block" is a real
 * title), `won`, `don`. A missed negation costs what today already costs; a false positive here
 * costs a supersede that should have happened, which the caller then has to make deliberately.
 * Contraction apostrophes are split by the tokenizer, so `isn't` arrives as `isn` plus a
 * one-character token that the length filter drops -- hence the bare stems below.
 */
const POLARITY_TOKENS = new Set([
  'not', 'no', 'never', 'none', 'nor', 'without', 'cannot', 'longer', 'unable',
  'isn', 'aren', 'wasn', 'weren', 'doesn', 'didn', 'hasn', 'haven', 'hadn',
  'couldn', 'shouldn', 'wouldn',
]);

/**
 * Phrases that assert a reversal of something recorded, as opposed to merely discussing change.
 *
 * THE FAILURE THIS EXISTS FOR. Store "Database choice: Postgres for everything", then store
 * "We are moving persistence to SQLite" whose content says "The Postgres-for-everything plan is
 * abandoned." The titles share no subset relation, the whole-text token overlap is 0.33 --
 * just under the 0.35 duplicate gate -- and the write lands in silence: both decisions active,
 * both returned fresh by the next query, nothing for `knowl conflicts` to see. Reproduced
 * against this exact source (2026-08-24) through the MCP path a real agent uses.
 *
 * WHY LEXICAL AND NOT SEMANTIC. Similarity statistics were measured for exactly this job and
 * lost: on the labelled pair set the motivating reversal scores 0.8593 under the default
 * profile while a hand-labelled NEGATIVE pair scores 0.8575 -- five statistics (margin, ratio,
 * margin-over-sd, z, exponential tail) all discriminate worse than the raw cosine, and no gate
 * over any of them reaches this case at a shippable fire rate. What distinguishes a reversal is
 * not how CLOSE the two texts are but that one of them SAYS the other is over -- a lexical
 * fact, detectable deterministically, in stores of any size including the fresh two-item store
 * where the CSLS guard abstains by construction.
 *
 * Kept to phrases that assert reversal rather than discuss it. "instead of", "dropped",
 * "rejected" and "retire" were measured on a real 831-item store and fire constantly in
 * ordinary engineering prose; the phrases below fired on 148 items' contents there, and 129 of
 * 1,033 on this repo's store. See `detectReversal` for the end-to-end rate, which is higher
 * than first reported and is stated rather than tuned away.
 */
const REVERSAL_CUES = [
  'no longer', 'abandoned', 'superseded', 'supersedes', 'deprecated',
  'reversed', 'obsolete', 'replaced by', 'overturned', 'rescinded', 'retracted',
];

export interface StoreKnowledgeInput {
  category: KnowledgeCategory;
  title: string;
  content: string;
  reasoning?: string | null;
  alternatives?: string[] | null;
  tags?: string[] | null;
  source?: string | null;
  sourceCommit?: string | null;
  affectedPaths?: string[] | null;
  confidence?: number;
  provenance?: KnowledgeProvenance | null;
  steps?: string[];
  evidence?: EvidenceInput[];
  /** Explicitly mark this active item id superseded by the new write. */
  supersedes?: string;
  // Declared because both store paths already forward these to checkKnowledgeConflict and
  // createKnowledgeItem at runtime; without them the exclusive-conflict contract was
  // reachable only through an object literal that failed its own excess-property check.
  conflictKey?: string | null;
  conflictScope?: Record<string, unknown> | null;
  conflictExclusive?: boolean;
}

export interface StoreKnowledgeResult {
  /** 'duplicate' means nothing was written because the item was already held verbatim. */
  action: 'inserted' | 'duplicate';
  item: KnowledgeItem;
  /** The active item this write retired, when it replaced one. */
  superseded?: KnowledgeItem;
  /** An overlapping active item deliberately left active beside this write. */
  nearDuplicate?: KnowledgeItem;
  /**
   * Overlaps with linked repos. Advisory: those items belong to another repo and cannot be
   * retired from here.
   */
  crossRepo?: CrossRepoOverlap[];
  /**
   * An active decision that already governs this subject. Advisory in the strongest sense: it
   * never refuses the write, because the signal separates a real match from the best false one
   * by only about a standard deviation. It exists so a writer is told the decision is there.
   */
  governingDecision?: GoverningDecision;
  /**
   * An active item this write's own content reads as reversing. Advisory and candidate-grade:
   * the caller gets the cue sentence quoted back and is the one that can tell. See
   * `detectReversal` for what fires it and the measured rate.
   */
  reversal?: ReversalAdvisory;
}

export interface StoreKnowledgeAtomOutcome {
  action: 'inserted' | 'duplicate';
  itemId: string;
  title: string;
  supersededId?: string;
  nearDuplicateId?: string;
  nearDuplicateTitle?: string;
  /** Overlaps with linked repos, per atom: five findings can overlap five different repos. */
  crossRepo?: CrossRepoOverlap[];
  /** Per atom, for the same reason: five findings can fall under five different decisions. */
  governingDecision?: GoverningDecision;
  /** Per atom: the active item this atom's content reads as reversing, if any. */
  reversal?: ReversalAdvisory;
}

export interface StoreKnowledgeBatchResult {
  /** One id per atom: the inserted item, or the existing item for a verbatim no-op. */
  itemIds: string[];
  insertedCount: number;
  duplicateCount: number;
  supersededIds: string[];
  /** Per-atom outcomes, so a caller can report exactly what happened to each one. */
  outcomes: StoreKnowledgeAtomOutcome[];
}

export function duplicateTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .map(token => token.trim())
      .filter(token => token.length >= 2 && !DUPLICATE_STOP_WORDS.has(token))
  );
}

function tokenOverlapScore(a: string, b: string): number {
  const left = duplicateTokens(a);
  const right = duplicateTokens(b);
  if (left.size === 0 || right.size === 0) return 0;

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection++;
  }

  return intersection / Math.min(left.size, right.size);
}

function searchableText(item: {
  title: string;
  content: string;
  reasoning?: string | null;
  tags?: string[] | null;
}): string {
  return `${item.title}\n${item.content}\n${item.reasoning || ''}\n${(item.tags || []).join(' ')}`;
}

export async function findLikelyDuplicateKnowledgeItem(
  projectId: string,
  item: {
    category: KnowledgeCategory;
    title: string;
    content: string;
    reasoning?: string | null;
    tags?: string[] | null;
  }
): Promise<KnowledgeItem | null> {
  const query = [
    item.title,
    item.content,
    item.reasoning || '',
    ...(item.tags || []),
  ].join(' ');

  const candidates = await searchKnowledgeItems(projectId, {
    query,
    category: item.category,
    status: 'active',
    limit: 3,
  });

  const incomingText = searchableText(item);
  return candidates.find(candidate =>
    tokenOverlapScore(incomingText, searchableText(candidate)) >= 0.35
  ) || null;
}

function normalizedIdentity(item: { title: string; content: string }): string {
  return `${item.title}\n${item.content}`.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Whether two items are about the same subject, judged on titles alone: one title's
// significant tokens are wholly contained in the other's. This is deliberately a title
// test and not a whole-text similarity test, because content overlap cannot tell a
// correction apart from a lifecycle trail. "Work Loop: Implement search UI" and
// "Work Loop finish" overlap on ~86% of their body tokens yet must stay side by side,
// while their titles are not in a subset relation. "Cache TTL" twice, and
// "Database is SQLite" against "Project database uses SQLite", are.
//
// A one-token title ("Auth") is too coarse to carry this and is excluded.
export function sameSubjectTitle(a: { title: string }, b: { title: string }): boolean {
  return sameSubjectTokens(duplicateTokens(a.title), duplicateTokens(b.title));
}

/**
 * `sameSubjectTitle` over token sets a caller already holds.
 *
 * Split out for the all-pairs scan in `contradiction-scan.ts`, which asks this and
 * `polarityTokensDiffer` about every pair of active items: tokenizing both titles inside each
 * predicate meant four tokenizations per pair, and at ~1,000 active items that is the dominant
 * cost of `knowl conflicts`. Tokenize once per item, compare many times.
 */
export function sameSubjectTokens(left: Set<string>, right: Set<string>): boolean {
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  if (smaller.size < 2) return false;
  for (const token of smaller) {
    if (!larger.has(token)) return false;
  }
  return true;
}

/**
 * Whether two same-subject titles differ ONLY by polarity -- one negates the other.
 *
 * Called after `sameSubjectTitle` has already established containment, so the smaller set is a
 * subset of the larger and the difference is exactly what the longer title adds. If everything it
 * adds is a polarity token, the two titles are not "same subject, new information" -- they are
 * the same subject asserted both ways, and retiring either one leaves the store asserting a
 * claim its own history contradicts.
 *
 * Symmetric on purpose: which of the pair is the incoming write is not the question. Reaching
 * this from the affirmative side (a re-assertion arriving after a recorded negation) is the more
 * dangerous direction, because the negation is usually the correction.
 */
export function differsOnlyInPolarity(a: { title: string }, b: { title: string }): boolean {
  return polarityTokensDiffer(duplicateTokens(a.title), duplicateTokens(b.title));
}

/** `differsOnlyInPolarity` over token sets a caller already holds. See `sameSubjectTokens`. */
export function polarityTokensDiffer(left: Set<string>, right: Set<string>): boolean {
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];

  let added = 0;
  for (const token of larger) {
    if (smaller.has(token)) continue;
    if (!POLARITY_TOKENS.has(token)) return false;
    added++;
  }
  // Identical token sets add nothing and are not a polarity pair; that case is a plain duplicate
  // and belongs to the payload comparison above, which can still answer `no-op`.
  return added > 0;
}

/** A sentence of an incoming write that contains a reversal cue, with its own token set. */
export type ReversalCueSentence = { cue: string; sentence: string; tokens: Set<string> };

/**
 * The sentences of `content` that contain a reversal cue. Empty for the overwhelming majority
 * of writes, which is what makes the whole check affordable: everything downstream is gated on
 * this being non-empty, and the cue scan itself is a handful of substring searches.
 */
export function reversalCueSentences(content: string): ReversalCueSentence[] {
  const lower = content.toLowerCase();
  if (!REVERSAL_CUES.some(cue => lower.includes(cue))) return [];
  const found: ReversalCueSentence[] = [];
  for (const sentence of content.split(/(?<=[.!?])\s+|\n+/)) {
    const text = sentence.trim();
    if (!text) continue;
    const sentenceLower = text.toLowerCase();
    const cue = REVERSAL_CUES.find(candidate => sentenceLower.includes(candidate));
    if (cue) found.push({ cue, sentence: text, tokens: duplicateTokens(text) });
  }
  return found;
}

/**
 * How many active titles a token may appear in and still count as naming a subject.
 *
 * Corpus-relative on purpose -- the same reasoning that moved the decision guard from a fitted
 * constant to a percentile of the store's own distribution. Measured on a real 831-item store,
 * the naive form of this detector (any 2 shared title tokens near a cue) flagged 13,678 pairs,
 * and requiring the shared tokens to cover half the title still flagged 21 -- every one of them
 * false, because the shared tokens were words like "web" and "site" that appear in dozens of
 * titles. Judging distinctiveness against THIS store's title frequencies cut it to 6 flagged
 * pairs on the same corpus, with the motivating case still detected in a two-item store.
 */
export function distinctiveTitleCap(activeItemCount: number): number {
  return Math.max(2, Math.ceil(activeItemCount * 0.01));
}

/** Per-token count of active titles containing it, the denominator distinctiveness is judged on. */
export function titleTokenFrequency(titles: string[]): Map<string, number> {
  const frequency = new Map<string, number>();
  for (const title of titles) {
    for (const token of duplicateTokens(title)) {
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
    }
  }
  return frequency;
}

export type ReversalMatch = {
  cue: string;
  sentence: string;
  /** Share of the held title's distinctive tokens the cue sentence names. For ranking, not gating. */
  coverage: number;
};

/**
 * Whether one of `cueSentences` reads as reversing the item holding `heldTitle`.
 *
 * Fires only when a single sentence both contains a reversal cue and names the held item's
 * subject: at least two of the title's distinctive tokens, covering at least half of them.
 * Distinctive is relative to the store's own title frequencies (`titleTokenFrequency` /
 * `distinctiveTitleCap`); a title with fewer than two distinctive tokens is too generic to be
 * named by tokens at all and never matches, the same reasoning as `sameSubjectTitle`'s
 * one-token exclusion.
 *
 * This is a CANDIDATE detector, and every surface that reports it says so. Re-measured
 * 2026-08-24 on this repo's own store (1,033 active items): 129 items carry a cue at all, and
 * 25 of 1,033 -- 2.4% of writes -- would draw an advisory. ALL 25 are narrative mentions
 * (release notes saying what a change stopped doing, items citing a `supersedes` id), not live
 * contradictions; this store has no true reversal left unresolved, so the precision of the
 * detector on a real positive is UNMEASURED, and the 2.4% is the noise floor a writer pays.
 *
 * That is a worse rate than the 831-item store this was first tuned against, and deliberately
 * NOT met with another threshold. Both obvious ones -- a cap on cue-sentence length, and
 * requiring the shared tokens to cover a share of the sentence too -- separate all 25 negatives
 * from the single synthetic positive cleanly, which is exactly the shape of a constant fitted
 * to one point. #182 records the same lesson for the relevance floor: when the signal does not
 * support the stronger claim, say what it supports instead of adding a number.
 *
 * The note is affordable at 2.4% because it carries the cue sentence, so a reader dismisses a
 * false one in seconds, and the true case it exists for (an explicit reversal stored under an
 * unrelated title) is otherwise silent everywhere, including the small fresh stores where the
 * statistical guard abstains by construction.
 */
export function detectReversal(
  cueSentences: ReversalCueSentence[],
  heldTitle: string,
  titleFrequency: Map<string, number>,
  cap: number,
): ReversalMatch | null {
  const distinctive = [...duplicateTokens(heldTitle)].filter(
    token => (titleFrequency.get(token) ?? 0) <= cap,
  );
  if (distinctive.length < 2) return null;
  for (const cueSentence of cueSentences) {
    let shared = 0;
    for (const token of distinctive) {
      if (cueSentence.tokens.has(token)) shared++;
    }
    if (shared >= 2 && shared / distinctive.length >= 0.5) {
      return { cue: cueSentence.cue, sentence: cueSentence.sentence, coverage: shared / distinctive.length };
    }
  }
  return null;
}

/**
 * Everything an item carries that a title-and-content comparison cannot see.
 *
 * Named as a type because two places decide "is this copy redundant" -- the write path, when
 * it answers "already held verbatim", and GC, when it picks which of two twins to hard delete.
 * Both used to compare title and content alone, and both therefore discarded whatever else the
 * losing copy held. One definition, so the two cannot drift apart.
 */
export type KnowledgePayload = {
  reasoning?: string | null;
  alternatives?: string[] | null;
  tags?: string[] | null;
  source?: string | null;
  sourceCommit?: string | null;
  affectedPaths?: string[] | null;
  provenance?: KnowledgeProvenance | null;
  confidence?: number | null;
  conflictKey?: string | null;
  conflictScope?: Record<string, unknown> | null;
  conflictExclusive?: boolean;
  /** Evidence identity, as `type:locator`. Absent means "not compared", not "none". */
  evidence?: string[];
  /** Skill steps, in order. Absent means "not compared", not "none". */
  steps?: string[];
};

function nonEmptySet(values: string[] | null | undefined): Set<string> | null {
  if (!values || values.length === 0) return null;
  const set = new Set(values.filter(value => value !== null && value !== undefined && value !== ''));
  return set.size > 0 ? set : null;
}

function scalarCarriesNothingNew(incoming: unknown, held: unknown): boolean {
  if (incoming === undefined || incoming === null || incoming === '') return true;
  return incoming === held;
}

function setCarriesNothingNew(incoming: string[] | null | undefined, held: string[] | null | undefined): boolean {
  const left = nonEmptySet(incoming);
  if (!left) return true;
  const right = nonEmptySet(held) ?? new Set<string>();
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

/**
 * Whether `incoming` adds nothing `held` does not already carry.
 *
 * Deliberately asymmetric, and deliberately not "are these equal". A write that merely *omits*
 * what the store already holds adds nothing, so it must stay a no-op -- treating any
 * difference as new information would let a barer restatement retire a richer record, which is
 * the same field-blindness pointed the other way. A write that adds a tag, a path, a source
 * commit or a lower confidence is carrying something, and gets written.
 *
 * A field left `undefined` on either side is not compared. That is what lets the same function
 * serve a caller that knows an item's evidence and one that does not, without either having to
 * pretend it knows the answer is "none".
 */
export function carriesNothingNew(incoming: KnowledgePayload, held: KnowledgePayload): boolean {
  return scalarCarriesNothingNew(incoming.reasoning, held.reasoning)
    && scalarCarriesNothingNew(incoming.source, held.source)
    && scalarCarriesNothingNew(incoming.sourceCommit, held.sourceCommit)
    && scalarCarriesNothingNew(incoming.provenance, held.provenance)
    && scalarCarriesNothingNew(incoming.conflictKey, held.conflictKey)
    && scalarCarriesNothingNew(incoming.confidence, held.confidence)
    // Only a declared exclusivity is information; not declaring it says nothing.
    && (incoming.conflictExclusive !== true || held.conflictExclusive === true)
    && scalarCarriesNothingNew(
      incoming.conflictScope ? JSON.stringify(normalizeConflictScope(incoming.conflictScope)) : null,
      held.conflictScope ? JSON.stringify(normalizeConflictScope(held.conflictScope)) : null,
    )
    && setCarriesNothingNew(incoming.alternatives, held.alternatives)
    && setCarriesNothingNew(incoming.tags, held.tags)
    // Normalized on both sides: the stored copy was normalized on the way in and the incoming
    // one has not been yet, so `./src/a.ts` and `src/a.ts` would otherwise read as different.
    && setCarriesNothingNew(normalizeAffectedPaths(incoming.affectedPaths), normalizeAffectedPaths(held.affectedPaths))
    && setCarriesNothingNew(incoming.evidence, held.evidence)
    // Steps are ordered, so a reordering is a different procedure rather than a subset.
    && (incoming.steps === undefined || incoming.steps.length === 0
      || (held.steps !== undefined && held.steps.join('\n') === incoming.steps.join('\n')));
}

/**
 * Evidence identity, matched the way `createEvidence` stores it.
 *
 * Through the same normalizer, not a copy of it. The two drifted apart the moment the
 * canonical form stopped being `trim` plus separator folding: a re-store citing
 * `file://src/a.ts` keyed differently from the stored `src/a.ts`, so a write that added
 * nothing read as new information and retired the record it duplicated.
 */
function evidenceKey(type: string, locator: string): string {
  return `${type}:${normalizeEvidenceLocator(type as EvidenceType, locator)}`;
}

/**
 * What the stored item holds beyond its own columns, fetched only when a no-op is possible.
 *
 * Two extra reads on every write would be two too many. Title and content already have to
 * match byte-for-byte before anything else can make the difference, and that is a rare path.
 */
export async function heldPayloadFor(
  input: { title: string; content: string },
  duplicate: KnowledgeItem,
): Promise<KnowledgePayload | undefined> {
  if (normalizedIdentity(input) !== normalizedIdentity(duplicate)) return undefined;
  const [evidence, steps] = await Promise.all([
    listEvidenceForItem(duplicate.id).catch(() => []),
    duplicate.category === 'skill' ? repo.getSkillSteps(duplicate.id).catch(() => []) : Promise.resolve([]),
  ]);
  return {
    ...duplicate,
    evidence: evidence.map(entry => evidenceKey(entry.type, entry.locator)),
    steps: steps.map(step => step.instruction),
  };
}

export type DuplicateResolution =
  /** Byte-for-byte the knowledge already held: write nothing, report the existing item. */
  | 'no-op'
  /** Same subject, different content: insert and retire the predecessor. */
  | 'supersede'
  /** Overlapping but not the same subject: insert, leave the other active, report it. */
  | 'coexist';

// How a detected near-duplicate is reconciled with the incoming write. The one
// invariant that holds for every category and every calling agent: content is never
// silently discarded. Only a re-store that adds nothing is a no-op, because only then is
// there nothing to lose. Everything else is written.
//
// "Adds nothing" used to mean "same title and content", which is where this went wrong.
// A write of the same sentence carrying `affectedPaths`, a `sourceCommit`, tags, a
// changed confidence, provenance or evidence was answered "already held verbatim, nothing
// was lost" and dropped -- and `affectedPaths` is what the whole drift system keys on, so
// the dropped write was the difference between an item that gets re-checked when its file
// changes and one that never does. The test is now over the whole payload, and
// deliberately asymmetric: a restatement that merely OMITS what the store already holds
// still adds nothing, and must not retire the richer record.
//
// An explicit `supersedes` id always wins. Otherwise a subset-title match reads as
// "same subject, new information" and supersedes, which keeps exactly one active answer
// and leaves the predecessor queryable via supersededById -- supersession is not
// deletion. When the titles are unrelated the engine cannot know whether this is a
// correction or a genuinely distinct record, so it keeps both and tells the caller,
// which is recoverable in a way that dropping the write is not.
//
// `held` carries what the stored item holds outside its own columns -- evidence and skill
// steps. Omit it and those two are simply not compared; every other field still is. Callers
// on the write path pass it via `heldPayloadFor`.
export function resolveDuplicate(
  // `evidence` is widened because a caller supplies inputs while a stored payload holds keys.
  input: { category: KnowledgeCategory; title: string; content: string; supersedes?: string }
    & Omit<KnowledgePayload, 'evidence'>
    & { evidence?: EvidenceInput[] | string[] },
  duplicate: KnowledgeItem,
  held?: KnowledgePayload,
): DuplicateResolution {
  if (input.supersedes && input.supersedes === duplicate.id) return 'supersede';
  if (normalizedIdentity(input) === normalizedIdentity(duplicate)) {
    const incoming: KnowledgePayload = {
      ...input,
      evidence: held?.evidence === undefined ? undefined : (input.evidence || []).map(entry =>
        typeof entry === 'string' ? entry : evidenceKey(entry.type, entry.locator)),
      steps: held?.steps === undefined ? undefined : input.steps,
    };
    if (carriesNothingNew(incoming, held ?? duplicate)) return 'no-op';
  }
  if (!sameSubjectTitle(input, duplicate)) return 'coexist';

  // One guard on the supersede branch, clamping to `coexist` rather than refusing. It cannot lose
  // a write: the incoming atom is still inserted, the predecessor stays active, and the caller is
  // told about the pair through the `nearDuplicate` channel that already reports the exact retire
  // call. An agent that means to retire the other one says so with `supersedes`, which is checked
  // first and is never second-guessed.
  //
  // The titles are the same claim asserted both ways; see `POLARITY_TOKENS`.
  //
  // NOT GUARDED ON PROVENANCE, and that was measured rather than assumed. A second guard was
  // proposed here -- refuse to let an atom with no provenance retire one claiming `observed` or
  // `user_stated` -- and replayed against this repo's 101 real supersessions it would have
  // blocked 3, all three of them legitimate corrections. One of the three is an atom whose entire
  // point is that the measurement it replaced was defective; blocking it leaves the known-wrong
  // figure active. Unset provenance is not a weak claim here, it is simply what 73% of all writes
  // look like, including the most carefully verified ones. `agent-query.ts` does demote an
  // unclaimed atom, but by a 0.98 multiplier -- a nudge in ranking is not the same judgement as
  // refusing a supersession, and a pair left coexisting is invisible afterwards: `knowl_conflicts`
  // reads only `conflictKey`/`conflictExclusive`, set on 3 of 937 active items.
  if (differsOnlyInPolarity(input, duplicate)) return 'coexist';

  return 'supersede';
}

// Resolve the item (if any) that a new write should mark superseded: the detected
// duplicate when it qualifies, otherwise an explicitly named active item.
async function resolveSupersedeTarget(
  input: { supersedes?: string },
  duplicate: KnowledgeItem | null,
  qualifies: boolean,
): Promise<KnowledgeItem | null> {
  if (duplicate && qualifies) return duplicate;
  if (input.supersedes) {
    const explicit = await repo.getKnowledgeItem(input.supersedes);
    if (explicit && explicit.status === 'active') return explicit;
  }
  return null;
}

/**
 * Linked repos, resolved once per write operation rather than once per atom.
 *
 * Lazy for the same reason `resolveWritingRepo` is: an unlinked project must pay nothing, and
 * a broken workspace must not block an ordinary write.
 */
let workspaceCache: { root: string; workspace: ActiveWorkspace | null } | null = null;

/** Tests only: the cache is process-lifetime and would otherwise leak between fixtures. */
export function resetWriteWorkspaceCache(): void {
  workspaceCache = null;
}

/**
 * Cached per config root, for the same reason `resolveWritingRepo` is: a write must not pay a
 * config read, and the overwhelming majority of writes happen in projects with no workspace.
 *
 * The batch writer resolved this once per batch from the start; the single-atom writer resolved
 * it per call, which meant a config read and a JSON parse on every write. That was not merely
 * wasteful -- a run of 2500 ordinary writes crashed the process partway through, and completed
 * cleanly with this call removed. The same run passes on 2.6.0, which did not have it.
 */
async function activeWorkspaceForWrite(): Promise<ActiveWorkspace | null> {
  let root: string;
  try {
    root = getConfigRoot();
  } catch {
    return null; // no open store: nothing to resolve against
  }

  if (workspaceCache?.root === root) return workspaceCache.workspace;

  let workspace: ActiveWorkspace | null;
  try {
    const { resolveWorkspace } = await import('../workspace/resolve.js');
    workspace = await resolveWorkspace(root);
  } catch {
    workspace = null; // a broken workspace must not block an ordinary write
  }

  workspaceCache = { root, workspace };
  return workspace;
}

/** Advisory and non-fatal: a peer that cannot be consulted must not fail the write. */
/**
 * The cross-repo overlap report for a single write, workspace resolution included.
 *
 * Exported because `recordDecisionDirect` writes through the repository rather than through this
 * module, so it never reached the private version -- and it backs both `knowl decide` and the
 * `knowl_decide` MCP tool. The result was that the cross-repo advisory was silently off for
 * decisions: the category most likely to contradict across repos, and the one a workspace default
 * shares automatically. Found by linking two repos and using them, not by reading the code.
 *
 * Any future writer that produces a result envelope should call this rather than reimplement it.
 */
export async function crossRepoOverlapForWrite(item: OverlapSubject): Promise<CrossRepoOverlap[] | undefined> {
  return overlapFor(await activeWorkspaceForWrite(), item);
}

async function overlapFor(
  workspace: ActiveWorkspace | null,
  item: OverlapSubject,
): Promise<CrossRepoOverlap[] | undefined> {
  if (!workspace) return undefined;
  try {
    const { findCrossRepoOverlap } = await import('../workspace/cross-repo-overlap.js');
    const found = await findCrossRepoOverlap({ workspace, item });
    return found.length ? found : undefined;
  } catch {
    return undefined;
  }
}

export type ReversalAdvisory = {
  id: string;
  title: string;
  /** The cue phrase that fired, for the caller's own reporting. */
  cue: string;
  /** The incoming sentence that names the held item, quoted back so the reader can judge it. */
  sentence: string;
};

/**
 * Everything a reversal check needs about the store, read once. The batch path shares one of
 * these across all its atoms; the single path builds one only after the cue gate passes.
 */
type ReversalScan = {
  titles: Array<{ id: string; title: string }>;
  frequency: Map<string, number>;
  cap: number;
};

async function loadReversalScan(): Promise<ReversalScan> {
  const titles = await repo.listActiveKnowledgeTitles();
  return {
    titles,
    frequency: titleTokenFrequency(titles.map(entry => entry.title)),
    cap: distinctiveTitleCap(titles.length),
  };
}

/**
 * The active item this write's content reads as reversing, or `undefined`.
 *
 * Advisory like its two neighbours in the result: never throws, never blocks, and every failure
 * path is `undefined`. `exclude` carries the ids already reported through their own channels --
 * the write itself, a retired predecessor, a coexisting near-duplicate -- so one pair is never
 * announced twice in the same result. Of several matches the one naming the largest share of
 * its title wins, because that is the one the sentence is most plainly about.
 */
async function reversalAdvisoryForWrite(
  item: { content: string },
  exclude: Set<string>,
  scan?: ReversalScan,
): Promise<ReversalAdvisory | undefined> {
  try {
    const cueSentences = reversalCueSentences(item.content);
    if (cueSentences.length === 0) return undefined;
    const { titles, frequency, cap } = scan ?? await loadReversalScan();
    let best: (ReversalAdvisory & { coverage: number }) | undefined;
    for (const held of titles) {
      if (exclude.has(held.id)) continue;
      const match = detectReversal(cueSentences, held.title, frequency, cap);
      if (match && (!best || match.coverage > best.coverage)) {
        best = { id: held.id, title: held.title, cue: match.cue, sentence: match.sentence, coverage: match.coverage };
      }
    }
    if (!best) return undefined;
    return { id: best.id, title: best.title, cue: best.cue, sentence: best.sentence };
  } catch {
    return undefined;
  }
}

export async function storeKnowledgeItemDeduped(
  projectId: string,
  input: StoreKnowledgeInput,
  commitMessage?: string,
  validationOptions?: KnowledgeWriteValidationOptions,
): Promise<StoreKnowledgeResult> {
  assertConfidenceInRange(input.confidence, input.title);
  const conflicts = await checkKnowledgeConflict(input);
  if (conflicts.length) throw new KnowledgeConflictError(conflicts.map(item => ({ id: item.id, title: item.title })));
  const duplicate = await findLikelyDuplicateKnowledgeItem(projectId, input);
  const resolution = duplicate
    ? resolveDuplicate(input, duplicate, await heldPayloadFor(input, duplicate))
    : null;
  if (duplicate && resolution === 'no-op' && !input.supersedes) {
    // The agent reached this conclusion again and the store already had it. That is the one
    // positive capture signal in the system, and until now it was computed and discarded.
    await recordRederivationBestEffort(duplicate.id);
    return { action: 'duplicate', item: duplicate };
  }

  // The item, the predecessor it retires and the commit record naming both land together or
  // not at all -- the same invariant the batch path holds. Rows with no commit record are
  // invisible to blast-radius, which is the mechanism that decides what to re-check when one
  // of them turns out to be wrong.
  const { item, superseded } = await withClientTransaction(async (conn) => {
    const written = await repo.createKnowledgeItem(
      projectId,
      {
        category: input.category,
        title: input.title,
        content: input.content,
        reasoning: input.reasoning,
        alternatives: input.alternatives,
        tags: input.tags,
        source: input.source,
        sourceCommit: input.sourceCommit,
        affectedPaths: input.affectedPaths,
        confidence: input.confidence,
        provenance: input.provenance,
        conflictKey: input.conflictKey,
        conflictScope: input.conflictScope,
        conflictExclusive: input.conflictExclusive,
      },
      input.steps,
      conn,
      validationOptions,
    );
    await attachEvidenceToKnowledge(written.id, input.evidence, input);

    const changes: CommitChange[] = [];
    const retired = await resolveSupersedeTarget(input, duplicate, resolution === 'supersede');
    if (retired && retired.id !== written.id) {
      await repo.updateKnowledgeItem(retired.id, { status: 'superseded', supersededById: written.id }, undefined, conn);
      changes.push({ itemId: retired.id, action: 'supersede', before: retired });
    }
    changes.push({ itemId: written.id, action: 'insert', after: written });
    await repo.createKnowledgeCommit(projectId, commitMessage || `Store ${input.category}: ${input.title}`, changes, conn);
    return { item: written, superseded: retired };
  });
  await indexKnowledgeItemsBestEffort(projectId, [item]);
  // After the transaction, never inside it. A crash between the two leaves an atom that is not
  // staged, which `knowl cloud stage` repairs; staging inside would leave a ledger row -- written
  // on a different connection, so it survives -- pointing at an item a rollback erased, and the
  // next push would send a phantom.
  await stageWrittenItems([item.id]);

  return {
    action: 'inserted',
    item,
    superseded: superseded || undefined,
    nearDuplicate: resolution === 'coexist' && duplicate ? duplicate : undefined,
    crossRepo: await overlapFor(await activeWorkspaceForWrite(), input),
    // Read after the write is durable, like the cross-repo advisory above it. Computed against
    // the WRITTEN item rather than the input so the text scored is the text stored.
    governingDecision: await governingDecisionForWrite(projectId, item),
    reversal: await reversalAdvisoryForWrite(item, new Set(
      [item.id, superseded?.id, resolution === 'coexist' && duplicate ? duplicate.id : undefined]
        .filter((id): id is string => Boolean(id)),
    )),
  };
}

/**
 * Write a batch of atoms, or write none of it.
 *
 * The atoms used to be written one transaction at a time with the commit record appended once
 * at the end, so an atom refused halfway through -- an oversized field, a secret, an exclusive
 * conflict -- threw out of the loop and skipped the commit entirely. The caller was told the
 * call failed while the earlier atoms sat in the store, and with no commit naming them
 * blast-radius could never implicate them if one later turned out to be wrong. A retired
 * predecessor stayed retired too, so a failed batch could leave a subject with no active
 * answer at all.
 *
 * One transaction over the whole batch makes the report and the state agree, and makes a retry
 * of the same batch trivially idempotent. The duplicate search runs inside it and therefore
 * still sees the atoms written earlier in the same batch. What stays outside is everything
 * that is not this database: peer overlap reports and embedding, both advisory and both
 * reasons to hold a write lock longer than the write needs it.
 */
export async function storeKnowledgeAtomsDeduped(
  projectId: string,
  atoms: StoreKnowledgeInput[],
  commitMessage?: string,
  validationOptions?: KnowledgeWriteValidationOptions,
): Promise<StoreKnowledgeBatchResult> {
  // Every atom's confidence, before the first one is written -- the same reason the ownership
  // guard is hoisted out of the loop. A batch is all-or-nothing, so a per-atom check would
  // refuse the batch after opening a transaction the caller was told nothing about.
  for (const atom of atoms) assertConfidenceInRange(atom.confidence, atom.title);
  // Resolved once for the whole batch, not once per atom. Ten atoms against three peers is
  // thirty workspace resolutions inside the loop, for something that cannot change mid-batch.
  const workspace = await activeWorkspaceForWrite();

  const written = await withClientTransaction(async (conn) => {
    const changes: CommitChange[] = [];
    const itemIds: string[] = [];
    const inserted: KnowledgeItem[] = [];
    const supersededIds: string[] = [];
    const outcomes: StoreKnowledgeAtomOutcome[] = [];
    // Which atom produced which outcome, so the peer lookups can be resolved after the
    // transaction commits rather than inside it.
    const overlapSubjects: Array<{ outcome: StoreKnowledgeAtomOutcome; atom: StoreKnowledgeInput }> = [];
    let duplicateCount = 0;
    let insertedCount = 0;

    for (const atom of atoms) {
      const duplicate = await findLikelyDuplicateKnowledgeItem(projectId, {
        category: atom.category,
        title: atom.title,
        content: atom.content,
        reasoning: atom.reasoning,
        tags: atom.tags,
      });

      const resolution = duplicate
        ? resolveDuplicate(atom, duplicate, await heldPayloadFor(atom, duplicate))
        : null;
      if (duplicate && resolution === 'no-op' && !atom.supersedes) {
        await recordRederivationBestEffort(duplicate.id);
        itemIds.push(duplicate.id);
        duplicateCount++;
        outcomes.push({ action: 'duplicate', itemId: duplicate.id, title: atom.title });
        continue;
      }

      const item = await repo.createKnowledgeItem(
        projectId,
        {
          category: atom.category,
          title: atom.title,
          content: atom.content,
          reasoning: atom.reasoning,
          alternatives: atom.alternatives,
          tags: atom.tags,
          source: atom.source,
          sourceCommit: atom.sourceCommit,
          affectedPaths: atom.affectedPaths,
          confidence: atom.confidence,
          provenance: atom.provenance,
          // Dropped here until now, while the comment on StoreKnowledgeInput claimed both
          // store paths forwarded them. Exclusivity is enforced inside createKnowledgeItem's
          // own transaction, so an atom that never carried the key was never checked against
          // it -- the guard was simply off for anything ingested as a batch.
          conflictKey: atom.conflictKey,
          conflictScope: atom.conflictScope,
          conflictExclusive: atom.conflictExclusive,
        },
        atom.steps,
        conn,
        validationOptions,
      );
      await attachEvidenceToKnowledge(item.id, atom.evidence, atom);

      const superseded = await resolveSupersedeTarget(atom, duplicate, resolution === 'supersede');
      if (superseded && superseded.id !== item.id) {
        await repo.updateKnowledgeItem(superseded.id, { status: 'superseded', supersededById: item.id }, undefined, conn);
        changes.push({ itemId: superseded.id, action: 'supersede', before: superseded });
        supersededIds.push(superseded.id);
      }

      itemIds.push(item.id);
      insertedCount++;
      inserted.push(item);
      changes.push({ itemId: item.id, action: 'insert', after: item });
      const outcome: StoreKnowledgeAtomOutcome = {
        action: 'inserted',
        itemId: item.id,
        title: atom.title,
        ...(superseded && superseded.id !== item.id ? { supersededId: superseded.id } : {}),
        ...(resolution === 'coexist' && duplicate
          ? { nearDuplicateId: duplicate.id, nearDuplicateTitle: duplicate.title }
          : {}),
      };
      outcomes.push(outcome);
      overlapSubjects.push({ outcome, atom });
    }

    if (changes.length > 0) {
      await repo.createKnowledgeCommit(
        projectId,
        commitMessage || `Store ${atoms.length} structured knowledge atom(s)`,
        changes,
        conn,
      );
    }

    return { itemIds, insertedCount, duplicateCount, supersededIds, outcomes, inserted, overlapSubjects };
  });

  // Per atom, so an agent can tell which of five findings overlapped rather than being told
  // only that something in the batch did. Advisory, so it reads peers after the local write
  // is durable instead of holding the write open across them.
  for (const { outcome, atom } of written.overlapSubjects) {
    outcome.crossRepo = await overlapFor(workspace, atom);
  }
  await indexKnowledgeItemsBestEffort(projectId, written.inserted);
  // Only what was actually inserted. A duplicate resolved to a no-op wrote nothing, so staging
  // its id would queue an atom this call did not change.
  await stageWrittenItems(written.inserted.map(item => item.id));

  // After indexing, not before: a batch that writes a decision should have it embedded before
  // the next atom in the same batch is scored against the pool. Keyed by id so an atom that was
  // a verbatim duplicate (and therefore wrote nothing) is not scored against itself.
  const insertedById = new Map(written.inserted.map(item => [item.id, item]));
  // One store scan for the whole batch, and only if some atom carries a cue at all -- the
  // same lazy shape as the workspace resolution above the loop.
  let reversalScan: ReversalScan | undefined;
  for (const { outcome } of written.overlapSubjects) {
    const item = insertedById.get(outcome.itemId);
    if (!item) continue;
    outcome.governingDecision = await governingDecisionForWrite(projectId, item);
    if (reversalCueSentences(item.content).length === 0) continue;
    reversalScan ??= await loadReversalScan();
    outcome.reversal = await reversalAdvisoryForWrite(
      item,
      new Set([item.id, outcome.supersededId, outcome.nearDuplicateId]
        .filter((id): id is string => Boolean(id))),
      reversalScan,
    );
  }

  return {
    itemIds: written.itemIds,
    insertedCount: written.insertedCount,
    duplicateCount: written.duplicateCount,
    supersededIds: written.supersededIds,
    outcomes: written.outcomes,
  };
}
