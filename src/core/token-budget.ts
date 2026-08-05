import { KnowledgeCategory, KnowledgeFreshness, KnowledgeItem } from './types.js';

export const DEFAULT_CONTEXT_MAX_CHARS = 3_000;
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 1_200;
export const DEFAULT_RESULT_LIMIT = 3;
/**
 * How much of a stored fact a caller receives.
 *
 * 600 was returning **half of every fact, severed mid-sentence**. Measured on this repository's
 * own store (556 active items): p50 558, but p75 1,448 and p90 1,988, so 48.7% of items were
 * cut -- and because `truncateText` is called here with the empty marker, a caller could not
 * tell a short complete atom from the opening third of a long one while the doctrine told it to
 * answer from memory rather than read files.
 *
 * Cost of the alternatives on the same corpus, at `DEFAULT_RESULT_LIMIT`:
 *
 * | ceiling | items whole | mean chars/query | worst case |
 * | --- | --- | --- | --- |
 * | 600 | 51.3% | 1,331 | 1,800 |
 * | 1,500 | 76.6% | 2,311 | 4,500 |
 * | 2,000 | 90.6% | 2,552 | 6,000 |
 * | 3,000 | 99.1% | 2,665 | 9,000 |
 *
 * 3,000 costs only 113 more mean characters and buys another 8.5 points, but its worst case is
 * 9,000 and the value is tuned to this store's longest item (3,779) rather than to a principle.
 * 2,000 is the choice that survives not knowing the corpus.
 */
export const MAX_ITEM_CONTENT_CHARS = 2000;
/**
 * The compact item's title, and the resource markdown's heading.
 *
 * Its own ceiling because it is its own thing: a title is an identifier rather than prose, and
 * it must not inherit whatever the content ceiling becomes. It shared that ceiling only by
 * accident of both being truncated in the same function. Measured on this repository's store:
 * p50 62, p90 100, p99 120, longest 133 -- so 200 never fires on real data, and exists to stop
 * a pathological title from claiming the content ceiling's new headroom.
 */
export const MAX_TITLE_CHARS = 200;
/**
 * Per-item ceiling for the markdown formatters in `./format.ts`.
 *
 * Those two call sites already bound the WHOLE response at `DEFAULT_CONTEXT_MAX_CHARS`, so this
 * must stay well under it. Raising it to the item-content ceiling would let one item consume
 * two thirds of `knowl_recent` and `knowl_state`.
 */
export const MAX_SUMMARY_ITEM_CHARS = 600;
/**
 * A bounded sample of something retrievable in full elsewhere: an evidence excerpt, a timeline
 * assertion, a skill's markdown, a skill run's stdout and stderr, a decision's reasoning.
 *
 * None of these is the fact an agent reasons from, and each has its own way back to the whole:
 * evidence carries a locator, a skill has a package on disk, a subprocess can be re-run. They
 * must not move when the item-content ceiling moves.
 */
export const MAX_PREVIEW_CHARS = 600;
export const MAX_TAGS = 4;
export const MAX_TAG_CHARS = 48;
export const MAX_EVIDENCE_ITEMS = 5;
/**
 * Measured against the three real stores on this machine (710 active items, 354 carrying
 * paths): median 3 paths per item, p90 5, p99 10. Six covers over 90% of items whole, and the
 * long tail is a list nobody reads to the end of anyway.
 */
export const MAX_AFFECTED_PATHS = 6;
/** Same corpus: p99 path length 57 chars, longest 81. Nothing real is cut at 120. */
export const MAX_PATH_CHARS = 120;

/**
 * Why a score was withheld, where the withholding is deliberate.
 *
 * The gate on publishing a number is sound and stays: a lexical-only ranking divides each
 * candidate by its own corpus's best hit, so its top result scores ~1.0 whatever it is;
 * the layered namespace path normalises per namespace, so two 1.0s from two stores invite a
 * comparison they cannot support; and a row vector never saw has a semantic half of 0 by
 * absence, not by verdict. What was wrong was the silence: 907 of 924 archived `knowl_query`
 * results carried no score (docs/evals/agent-surface.md §10), and "the ranker has no opinion"
 * was indistinguishable from "the ranker forgot to say". The reader's decision -- trust this
 * or go read the files -- is exactly the one that silence blocks.
 */
export type UncalibratedReason = 'lexical-only' | 'layered namespaces' | 'not embedded';
/**
 * The marker itself, riding in the `score` field rather than beside it: the reader is already
 * told to judge by `score`, so the verdict goes where the eye already is, and `typeof` is the
 * machine-legible switch -- a number is the ranker's opinion, this string is its refusal, with
 * the reason attached. One idiom with `NO CONFIDENT MATCH`, not a second one.
 */
export type UncalibratedScore = `uncalibrated (${UncalibratedReason})`;
export function uncalibratedScore(reason: UncalibratedReason): UncalibratedScore {
  return `uncalibrated (${reason})`;
}

export type CompactKnowledgeItem = Pick<KnowledgeItem, 'id' | 'category' | 'title' | 'content' | 'freshness' | 'confidence'> & {
  tags?: string[];
  /**
   * The files this item depends on -- the one field that turns a remembered fact back into a
   * place to look. Held back until now as "verbose provenance", grouped with `reasoning` and
   * `alternatives`; it is not prose, it is a pointer list averaging 112 characters, and its
   * absence was measurable: across 356 archived cases where an agent queried memory and then
   * opened a file within three tool calls, the file it opened was named in the result 17.1%
   * of the time. It could not have been higher -- the field never left this function.
   */
  affectedPaths?: string[];
  /**
   * Set when `content` was cut at `MAX_ITEM_CONTENT_CHARS`, never present otherwise.
   *
   * The cut is not an edge case: 84-94% of active items in the three real stores exceed 600
   * characters, so a caller sees roughly a third of what was stored, and `truncateText` is
   * called here with the empty marker -- no ellipsis, no sign. An agent cannot distinguish a
   * short complete atom from the opening third of a long one, which makes "answer from Knowl
   * without inspecting repository files" advice it has no way to evaluate. `knowl_skill_read`
   * has always reported its own truncation this way; this is that flag, on the path that
   * actually carries the traffic.
   */
  truncated?: true;
  /** Owning repo, when a workspace is active. Absent otherwise. */
  repo?: string;
  /** Namespace the item came from. queryLayeredKnowledge attaches this and it was dropped here. */
  namespace?: string;
  /**
   * The ranker's fused relevance for this result, in [0,1] -- or, when the ranking carried no
   * absolute half, the explicit refusal `uncalibrated (<reason>)`. Never absent-but-meant:
   * absence now means the caller supplied nothing, not that the ranker had no opinion.
   */
  score?: number | UncalibratedScore;
};

/** What the caller knows about this result that the item itself does not carry. */
export type CompactProvenance = {
  repo?: string;
  namespace?: string;
  /**
   * The calibrated score when there is one, or the marker saying why there is not.
   *
   * Supplied by the caller rather than read off the item, because it is a property of *this
   * query* and the same row scores differently under the next one. Absent unless supplied, so
   * a response that has no such number stays byte-identical.
   *
   * A rank cannot tell "this is the answer" apart from "this is the best of a bad lot", and the
   * consumer of a memory read is deciding exactly that: trust this, or go read the files. The
   * ranker has known the difference since the floor moved onto the raw cosine; it reached
   * `explain` only, which nothing sets by default. The `UncalibratedScore` string is the same
   * decision served on the paths where no calibrated number exists -- see `UncalibratedReason`.
   */
  score?: number | UncalibratedScore;
};

/**
 * Three decimals. The difference between 0.573 and 0.5730000000000001 is thirteen bytes on
 * every result of every query and no information at all, and the score is read as evidence of
 * strength rather than compared for equality.
 */
const SCORE_DECIMALS = 3;

export function truncateText(value: string, maxChars: number, marker = ''): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= marker.length) return marker.slice(0, maxChars);
  return `${value.slice(0, maxChars - marker.length)}${marker}`;
}

export function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

/**
 * An allowlist, not a projection: a field absent here never reaches the agent, whatever
 * upstream attaches. queryLayeredKnowledge has been labelling results with their namespace
 * and having it silently dropped at this boundary, so provenance has to be declared.
 *
 * Both extras stay absent unless supplied, keeping a single-store payload byte-identical.
 */
export function compactKnowledgeItem(item: KnowledgeItem, extras: CompactProvenance = {}): CompactKnowledgeItem {
  const tags = item.tags?.slice(0, MAX_TAGS).map(tag => truncateText(tag, MAX_TAG_CHARS));
  const affectedPaths = item.affectedPaths?.slice(0, MAX_AFFECTED_PATHS).map(path => truncateText(path, MAX_PATH_CHARS));
  return {
    id: item.id,
    category: item.category as KnowledgeCategory,
    title: truncateText(item.title, MAX_TITLE_CHARS),
    content: truncateText(item.content, MAX_ITEM_CONTENT_CHARS),
    freshness: item.freshness as KnowledgeFreshness,
    confidence: item.confidence,
    // A flag, not a length: the caller is deciding "is this the whole fact or the start of
    // one", and a byte count answers a question nobody asked. Absent when nothing was cut, so
    // every response that fitted stays byte-identical.
    ...(item.content.length > MAX_ITEM_CONTENT_CHARS ? { truncated: true as const } : {}),
    ...(tags?.length ? { tags } : {}),
    ...(affectedPaths?.length ? { affectedPaths } : {}),
    ...(extras.repo ? { repo: extras.repo } : {}),
    ...(extras.namespace ? { namespace: extras.namespace } : {}),
    // A marker string passes through whole: it is already bounded (the longest reason is 33
    // characters) and rounding is a property of numbers.
    ...(typeof extras.score === 'string' ? { score: extras.score } : {}),
    // Compared against undefined rather than tested for truth: a score of 0 is the single most
    // useful one this field can carry, and `extras.score ? ...` would be the one value it drops.
    ...(typeof extras.score === 'number' && Number.isFinite(extras.score)
      ? { score: Number(extras.score.toFixed(SCORE_DECIMALS)) }
      : {}),
  };
}
