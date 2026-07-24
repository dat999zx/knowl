import { ExplainedKnowledgeItem, KnowledgeCategory, KnowledgeItem, KnowledgeStatus } from '../core/types.js';
import { queryKnowledgeBase } from './queries.js';
import { searchKnowledgeEmbeddings } from './vector.js';
import { recordKnowledgeAccessBestEffort } from './access-feedback.js';

const DEFAULT_AGENT_QUERY_LIMIT = 3;
const RRF_K = 60;
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

export async function queryKnowledgeForAgent(
  projectId: string,
  options: {
    category?: KnowledgeCategory;
    status?: KnowledgeStatus;
    tags?: string[];
    query?: string;
    surface?: string;
    limit?: number;
    vector?: {
      enabled?: boolean;
      provider?: string;
      model?: string;
      embedding?: number[];
    };
  }
): Promise<KnowledgeItem[]> {
  return (await queryKnowledgeForAgentExplained(projectId, options)).map(({ explanation, ...item }) => item);
}

export async function queryKnowledgeForAgentExplained(
  projectId: string,
  options: {
    category?: KnowledgeCategory;
    status?: KnowledgeStatus;
    tags?: string[];
    query?: string;
    surface?: string;
    limit?: number;
    vector?: { enabled?: boolean; provider?: string; model?: string; embedding?: number[] };
  },
): Promise<ExplainedKnowledgeItem[]> {
  const limit = options.limit ?? DEFAULT_AGENT_QUERY_LIMIT;
  const { vector, ...textOptions } = options;
  const candidateLimit = Math.max(limit * 3, 10);
  const bm25Results = await queryKnowledgeBase(projectId, {
    ...textOptions,
    category: undefined,
    limit: candidateLimit,
  });

  const ranked = new Map<string, { item: KnowledgeItem; score: number; bm25Rank?: number; vectorRank?: number; vectorScore?: number }>();
  bm25Results.forEach((item, index) => {
    ranked.set(item.id, {
      item,
      score: 1 / (RRF_K + index + 1),
      bm25Rank: index + 1,
    });
  });

  const usingVector = Boolean(vector?.enabled && vector.embedding);
  if (usingVector) {
    const vectorResults = await searchKnowledgeEmbeddings(projectId, {
      vector: vector!.embedding!,
      category: undefined,
      status: options.status,
      tags: options.tags,
      provider: vector!.provider,
      model: vector!.model,
      limit: candidateLimit,
    });

    vectorResults.forEach((result, index) => {
      const existing = ranked.get(result.item.id);
      const score = 1 / (RRF_K + index + 1);
      ranked.set(result.item.id, {
        item: result.item,
        score: (existing?.score ?? 0) + score,
        bm25Rank: existing?.bm25Rank,
        vectorRank: index + 1,
        vectorScore: result.score,
      });
    });
  }

  const tokens = queryTokens(options.query);
  const timestamps = [...ranked.values()].map(result => new Date(result.item.updatedAt).getTime());

  const scored = [...ranked.values()]
    .map(result => {
      const category = options.category && result.item.category === options.category ? CATEGORY_HINT_BOOST : 0;
      const recency = normalizedRecencyScore(result.item, timestamps) * RECENCY_BOOST;
      const confidence = result.item.confidence * CONFIDENCE_BOOST;
      const exactIdentifier = exactIdentifierScore(result.item, options.query);
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
        rank = result.score;
        text = Math.min(textMatchScore(result.item, tokens), 20) * 0.01;
        freshness = freshnessScore(result.item);
      }
      const contributions = { rank, text, category, recency, confidence, freshness, exactIdentifier };
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

  const items = selected.map(({ result, score, contributions, diversity }) => {
    const explanationContributions = { ...contributions, diversity };
    return {
      ...result.item,
      explanation: {
        finalScore: score + diversity,
        bm25Rank: result.bm25Rank,
        vectorRank: result.vectorRank,
        contributions: explanationContributions,
        reason: `rrf=${contributions.rank.toFixed(3)}, text=${contributions.text.toFixed(3)}, category=${contributions.category.toFixed(3)}, diversity=${diversity.toFixed(3)}`,
      },
    };
  });

  await Promise.all(items.map((item, index) => recordKnowledgeAccessBestEffort({
    itemId: item.id,
    query: options.query,
    surface: options.surface ?? 'agent_query',
    rank: index + 1,
  })));
  return items;
}
