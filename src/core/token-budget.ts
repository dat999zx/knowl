import { KnowledgeCategory, KnowledgeFreshness, KnowledgeItem } from './types.js';

export const DEFAULT_CONTEXT_MAX_CHARS = 3_000;
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 1_200;
export const DEFAULT_RESULT_LIMIT = 3;
export const MAX_ITEM_CONTENT_CHARS = 600;
export const MAX_TAGS = 4;
export const MAX_TAG_CHARS = 48;
export const MAX_EVIDENCE_ITEMS = 5;

export type CompactKnowledgeItem = Pick<KnowledgeItem, 'id' | 'category' | 'title' | 'content' | 'freshness' | 'confidence'> & {
  tags?: string[];
  /** Owning repo, when a workspace is active. Absent otherwise. */
  repo?: string;
  /** Namespace the item came from. queryLayeredKnowledge attaches this and it was dropped here. */
  namespace?: string;
  /**
   * The ranker's fused relevance for this result, in [0,1]. Absent when the ranking carried no
   * absolute half -- see `CompactProvenance.score`.
   */
  score?: number;
};

/** What the caller knows about this result that the item itself does not carry. */
export type CompactProvenance = {
  repo?: string;
  namespace?: string;
  /**
   * The calibrated score, when there is one.
   *
   * Supplied by the caller rather than read off the item, because it is a property of *this
   * query* and the same row scores differently under the next one. Absent unless supplied, so
   * a response that has no such number stays byte-identical.
   *
   * A rank cannot tell "this is the answer" apart from "this is the best of a bad lot", and the
   * consumer of a memory read is deciding exactly that: trust this, or go read the files. The
   * ranker has known the difference since the floor moved onto the raw cosine; it reached
   * `explain` only, which nothing sets by default.
   */
  score?: number;
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
  return {
    id: item.id,
    category: item.category as KnowledgeCategory,
    title: truncateText(item.title, MAX_ITEM_CONTENT_CHARS),
    content: truncateText(item.content, MAX_ITEM_CONTENT_CHARS),
    freshness: item.freshness as KnowledgeFreshness,
    confidence: item.confidence,
    ...(tags?.length ? { tags } : {}),
    ...(extras.repo ? { repo: extras.repo } : {}),
    ...(extras.namespace ? { namespace: extras.namespace } : {}),
    // Compared against undefined rather than tested for truth: a score of 0 is the single most
    // useful one this field can carry, and `extras.score ? ...` would be the one value it drops.
    ...(extras.score === undefined || !Number.isFinite(extras.score)
      ? {}
      : { score: Number(extras.score.toFixed(SCORE_DECIMALS)) }),
  };
}
