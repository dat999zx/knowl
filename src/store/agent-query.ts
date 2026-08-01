import { ExplainedKnowledgeItem, KnowledgeCategory, KnowledgeItem, KnowledgeStatus } from '../core/types.js';
import { queryKnowledgeBase } from './queries.js';
import { searchKnowledgeEmbeddings } from './vector.js';
import { recordKnowledgeAccessBestEffort } from './access-feedback.js';
import { localStore, type StoreHandle } from './store-handle.js';

const DEFAULT_AGENT_QUERY_LIMIT = 3;
/** Exported so cross-store fusion uses the same constant rather than restating it. */
export const RRF_K = 60;
const CATEGORY_HINT_BOOST = 0.015;
const RECENCY_BOOST = 0.005;
const CONFIDENCE_BOOST = 0.005;
const EXACT_IDENTIFIER_BOOST = 0.02;
const MMR_RELEVANCE_WEIGHT = 0.2;
const MMR_SIMILARITY_WEIGHT = 0.8;
// When vector search is available it becomes the primary ranker (cosine similarity,
// 0..1), BM25 drops to a bounded fallback for lexical-only hits, and a stronger
// freshness re-rank keeps current-truth above near-identical stale siblings.
const VECTOR_PRIMARY_WEIGHT = 1;
const BM25_FALLBACK_WEIGHT = 0.35;
// Standing terms. Sized below the freshness re-rank on both paths: an item's earned
// standing breaks ties between near-equals but must never outrank being current — and an
// inferred item is discounted, never buried, because it may still be the only answer.
const TIER_VERIFIED_BOOST_VECTOR = 0.015;
const TIER_VERIFIED_BOOST_LEXICAL = 0.004;
const PROVENANCE_INFERRED_PENALTY_VECTOR = -0.01;
const PROVENANCE_INFERRED_PENALTY_LEXICAL = -0.003;

/**
 * Below this, a vector-backed result is noise rather than a weak answer.
 *
 * Measured 2026-08-01 over 20 queries against a 424-item store: on-topic and near-miss
 * queries score 0.401-0.614, off-topic queries 0.170-0.223, and nothing falls between.
 * 0.30 leaves roughly 0.08 above the worst junk and 0.10 below the weakest legitimate
 * query -- the larger margin deliberately protects real answers, because silencing one is
 * worse than admitting a weak one.
 *
 * Absolute, never a ratio: freshness and provenance penalties are additive and can drive a
 * score slightly negative, which makes "a fraction of the top score" undefined. A ratio was
 * measured and is worse than useless here -- off-topic runner-up ratios reach 0.69 while
 * legitimate ones fall to 0.33.
 */
export const MIN_VECTOR_RELEVANCE = 0.30;

function queryTokens(query?: string): string[] {
  return [...new Set((query ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 1))];
}

function countOccurrences(text: string, token: string): number {
  return text.toLowerCase().split(token).length - 1;
}

function textMatchScore(item: KnowledgeItem, tokens: string[]): number {
  if (tokens.length === 0) {
    return 0;
  }

  const searchableText = [
    item.title,
    item.content,
    item.reasoning ?? '',
    (item.tags ?? []).join(' '),
  ].join(' ');

  return tokens.reduce((score, token) => score + countOccurrences(searchableText, token), 0);
}

function itemTokens(item: KnowledgeItem): Set<string> {
  return new Set(queryTokens([item.title, item.content, ...(item.tags ?? [])].join(' ')));
}

function tokenOverlap(left: Set<string>, right: Set<string>): number {
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 0;
  return [...left].filter(token => right.has(token)).length / union.size;
}

function exactIdentifierScore(item: KnowledgeItem, query?: string): number {
  const identifier = query?.trim().toLowerCase();
  if (!identifier || identifier.length < 3 || !/[./#:_-]/.test(identifier)) return 0;
  const text = [item.title, item.content, ...(item.tags ?? [])].join(' ').toLowerCase();
  return text.includes(identifier) ? EXACT_IDENTIFIER_BOOST : 0;
}

function freshnessScore(item: KnowledgeItem): number {
  if (item.freshness === 'fresh') return 0.006;
  if (item.freshness === 'needs_review') return -0.006;
  return -0.012;
}

// Stronger freshness adjustment used only on the vector path, where the base is a
// 0..1 cosine score. Big enough to flip a stale/fresh near-tie (near-identical
// migration siblings), small enough not to bury a uniquely-relevant stale atom.
function freshnessRerank(item: KnowledgeItem): number {
  if (item.freshness === 'fresh') return 0.02;
  if (item.freshness === 'needs_review') return -0.02;
  return -0.05;
}

function normalizedRecencyScore(item: KnowledgeItem, timestamps: number[]): number {
  const timestamp = new Date(item.updatedAt).getTime();
  const validTimestamps = timestamps.filter(value => Number.isFinite(value));
  if (!Number.isFinite(timestamp) || validTimestamps.length === 0) {
    return 0;
  }

  const oldest = Math.min(...validTimestamps);
  const newest = Math.max(...validTimestamps);
  if (newest === oldest) {
    return 0;
  }

  return (timestamp - oldest) / (newest - oldest);
}

export type RankOptions = {
  category?: KnowledgeCategory;
  status?: KnowledgeStatus;
  tags?: string[];
  query?: string;
  surface?: string;
  limit?: number;
  visibility?: 'repo' | 'workspace';
  vector?: {
    enabled?: boolean;
    provider?: string;
    model?: string;
    embedding?: number[];
  };
};

export type Candidate = {
  item: KnowledgeItem;
  /** This repo's own lexical rank. Corpus-relative -- see the note in scoreCandidates. */
  bm25Rank?: number;
  vectorRank?: number;
  vectorScore?: number;
};

export type ScoredCandidate = {
  item: KnowledgeItem;
  repo?: string;
  score: number;
  explanation: ExplainedKnowledgeItem['explanation'];
};

/**
 * Whether vector search actually returned anything for this query.
 *
 * NOT the same as `options.vector?.enabled && options.vector.embedding`, which says only that
 * vector was *requested*. On a store with no embeddings -- anyone who enables vector before
 * running a reindex -- the request succeeds and returns nothing, leaving every candidate on
 * the BM25 fallback scale of roughly 0.05-0.23. Applying MIN_VECTOR_RELEVANCE there would
 * drop every result for every query, so the floor keys on this instead.
 */
export function vectorContributed(candidates: Pick<Candidate, 'vectorScore'>[]): boolean {
  return candidates.some(candidate => candidate.vectorScore !== undefined);
}

/**
 * The reciprocal-rank base score, reconstructed from the ranks rather than carried.
 *
 * The previous code accumulated this into a `score` field as it merged the two result sets:
 * BM25 set `1 / (RRF_K + index + 1)` and the vector pass added its own term on top. The
 * lexical branch of the scorer read that field.
 *
 * Reconstructing is preferable to carrying it: `bm25Rank` and `vectorRank` are the actual
 * inputs, the arithmetic is visible here rather than smeared across a merge loop, and a
 * candidate assembled by any other caller cannot arrive with a stale precomputed score.
 */
function baseRankScore(candidate: Candidate): number {
  return (candidate.bm25Rank ? 1 / (RRF_K + candidate.bm25Rank) : 0)
    + (candidate.vectorRank ? 1 / (RRF_K + candidate.vectorRank) : 0);
}

export async function queryKnowledgeForAgent(
  projectId: string,
  options: RankOptions,
): Promise<KnowledgeItem[]> {
  return (await queryKnowledgeForAgentExplained(projectId, options)).map(({ explanation, ...item }) => item);
}

/**
 * The database half. One store, one read.
 *
 * Separate from scoring because scoring must be able to run over several repos' candidates at
 * once: recency is normalized against the set it is given, so scoring each repo alone and then
 * comparing the results makes every repo's newest item equally recent.
 */
export async function selectCandidates(
  projectId: string,
  options: RankOptions,
  store: StoreHandle = localStore(),
): Promise<Candidate[]> {
  const limit = options.limit ?? DEFAULT_AGENT_QUERY_LIMIT;
  const { vector, ...textOptions } = options;
  const candidateLimit = Math.max(limit * 3, 10);
  const bm25Results = await queryKnowledgeBase(projectId, {
    ...textOptions,
    category: undefined,
    limit: candidateLimit,
  }, store);

  const byId = new Map<string, Candidate>();
  bm25Results.forEach((item, index) => {
    byId.set(item.id, { item, bm25Rank: index + 1 });
  });

  if (vector?.enabled && vector.embedding) {
    const vectorResults = await searchKnowledgeEmbeddings(projectId, {
      vector: vector.embedding,
      category: undefined,
      status: options.status,
      tags: options.tags,
      visibility: options.visibility,
      provider: vector.provider,
      model: vector.model,
      limit: candidateLimit,
    }, store);

    vectorResults.forEach((result, index) => {
      const existing = byId.get(result.item.id);
      byId.set(result.item.id, {
        item: result.item,
        bm25Rank: existing?.bm25Rank,
        vectorRank: index + 1,
        vectorScore: result.score,
      });
    });
  }

  return [...byId.values()];
}

/**
 * The scoring half. Pure, synchronous, no database, no notion of repos.
 *
 * `repo` rides through untouched so a cross-repo caller can attribute results without scoring
 * knowing anything about workspaces.
 *
 * One term here is corpus-relative and cannot be made otherwise: `bm25Rank` is each repo's own
 * lexical rank. It is used only as a bounded fallback for candidates with no vector -- at most
 * about 0.006 -- and only when vector search is off or an item is unembedded. Every other term
 * is absolute: cosine, freshness, confidence, category, text match, exact identifier. Recency
 * is normalized over whatever set is passed in, which is why a cross-repo caller passes every
 * repo's candidates at once rather than scoring each repo and fusing the results.
 */
export function scoreCandidates<T extends Candidate & { repo?: string }>(
  candidates: T[],
  options: { query?: string; category?: KnowledgeCategory; limit: number; usingVector: boolean },
): ScoredCandidate[] {
  const limit = options.limit;
  const usingVector = options.usingVector;
  const tokens = queryTokens(options.query);
  const timestamps = candidates.map(result => new Date(result.item.updatedAt).getTime());

  const scored = candidates
    .map(result => {
      const category = options.category && result.item.category === options.category ? CATEGORY_HINT_BOOST : 0;
      const recency = normalizedRecencyScore(result.item, timestamps) * RECENCY_BOOST;
      const confidence = result.item.confidence * CONFIDENCE_BOOST;
      const exactIdentifier = exactIdentifierScore(result.item, options.query);
      const standing = (result.item.tier === 'verified'
        ? (usingVector ? TIER_VERIFIED_BOOST_VECTOR : TIER_VERIFIED_BOOST_LEXICAL)
        : 0)
        + (result.item.provenance === 'inferred'
          ? (usingVector ? PROVENANCE_INFERRED_PENALTY_VECTOR : PROVENANCE_INFERRED_PENALTY_LEXICAL)
          : 0);
      let rank: number;
      let text: number;
      let freshness: number;
      if (usingVector) {
        // Vector cosine is the primary signal; BM25-only hits fall back to a bounded
        // rank score so lexical matches still surface below semantic ones.
        const fallback = result.vectorScore === undefined && result.bm25Rank
          ? BM25_FALLBACK_WEIGHT / (RRF_K + result.bm25Rank)
          : 0;
        rank = (result.vectorScore ?? 0) * VECTOR_PRIMARY_WEIGHT + fallback;
        text = Math.min(textMatchScore(result.item, tokens), 20) * 0.001;
        freshness = freshnessRerank(result.item);
      } else {
        // Reconstructed from the ranks, which are the inputs the merge loop used to
        // accumulate into a score field that no longer exists.
        rank = baseRankScore(result);
        text = Math.min(textMatchScore(result.item, tokens), 20) * 0.01;
        freshness = freshnessScore(result.item);
      }
      const contributions = { rank, text, category, recency, confidence, freshness, exactIdentifier, standing };
      return {
        result,
        score: Object.values(contributions).reduce((sum, value) => sum + value, 0),
        contributions,
      };
    })
    .sort((left, right) => right.score - left.score);

  let selected: Array<typeof scored[number] & { diversity: number }>;
  if (usingVector) {
    // Trust the semantic ranking directly — MMR de-duplication scrambles rankings
    // among legitimately distinct-but-similar atoms and hurts recall.
    selected = scored.slice(0, limit).map(candidate => ({ ...candidate, diversity: 0 }));
  } else {
    selected = [];
    const candidateTokens = new Map(scored.map(candidate => [candidate.result.item.id, itemTokens(candidate.result.item)]));
    const highestScore = scored[0]?.score || 1;
    while (selected.length < limit && selected.length < scored.length) {
      const next = scored
        .filter(candidate => !selected.some(chosen => chosen.result.item.id === candidate.result.item.id))
        .map(candidate => {
          const overlap = selected.length === 0 ? 0 : Math.max(...selected.map(chosen => tokenOverlap(
            candidateTokens.get(candidate.result.item.id)!, candidateTokens.get(chosen.result.item.id)!,
          )));
          return {
            ...candidate,
            diversity: -overlap * MMR_SIMILARITY_WEIGHT,
            mmr: (candidate.score / highestScore) * MMR_RELEVANCE_WEIGHT - overlap * MMR_SIMILARITY_WEIGHT,
          };
        })
        .sort((left, right) => right.mmr - left.mmr)[0];
      if (!next) break;
      selected.push(next);
    }
  }

  return selected.map(({ result, score, contributions, diversity }) => {
    const explanationContributions = { ...contributions, diversity };
    return {
      item: result.item,
      repo: result.repo,
      score: score + diversity,
      explanation: {
        finalScore: score + diversity,
        bm25Rank: result.bm25Rank,
        vectorRank: result.vectorRank,
        contributions: explanationContributions,
        reason: `rrf=${contributions.rank.toFixed(3)}, text=${contributions.text.toFixed(3)}, category=${contributions.category.toFixed(3)}, diversity=${diversity.toFixed(3)}`,
      },
    };
  });
}

/**
 * Score and order candidates from one store. Reads only.
 *
 * Split from `queryKnowledgeForAgentExplained` so it can run against any database. Recording
 * that an item was used cannot: a peer handle is read-only, and `knowledge_access` has a
 * foreign key to `knowledge_items`, so a peer's item cannot be recorded in the local database
 * either. Peer access telemetry is therefore not merely unimplemented -- it has nowhere
 * correct to go, and the reads belong to the querying repo regardless.
 */
export async function rankKnowledge(
  projectId: string,
  options: RankOptions,
  store: StoreHandle = localStore(),
): Promise<ExplainedKnowledgeItem[]> {
  const candidates = await selectCandidates(projectId, options, store);
  return scoreCandidates(candidates, {
    query: options.query,
    category: options.category,
    limit: options.limit ?? DEFAULT_AGENT_QUERY_LIMIT,
    usingVector: Boolean(options.vector?.enabled && options.vector.embedding),
  }).map(({ item, explanation }) => ({ ...item, explanation }));
}

export async function queryKnowledgeForAgentExplained(
  projectId: string,
  options: RankOptions,
): Promise<ExplainedKnowledgeItem[]> {
  const items = await rankKnowledge(projectId, options);
  await Promise.all(items.map((item, index) => recordKnowledgeAccessBestEffort({
    itemId: item.id,
    query: options.query,
    surface: options.surface ?? 'agent_query',
    rank: index + 1,
  })));
  return items;
}
