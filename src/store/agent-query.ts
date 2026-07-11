import { ExplainedKnowledgeItem, KnowledgeCategory, KnowledgeItem, KnowledgeStatus } from '../core/types.js';
import { queryKnowledgeBase } from './queries.js';
import { searchKnowledgeEmbeddings } from './vector.js';

const DEFAULT_AGENT_QUERY_LIMIT = 3;
const CATEGORY_HINT_BOOST = 10;
const SIMILAR_RELEVANCE_RECENCY_BOOST = 0.75;

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
    limit?: number;
    vector?: { enabled?: boolean; provider?: string; model?: string; embedding?: number[] };
  },
): Promise<ExplainedKnowledgeItem[]> {
  const limit = options.limit ?? DEFAULT_AGENT_QUERY_LIMIT;
  const { vector, ...textOptions } = options;
  const bm25Results = await queryKnowledgeBase(projectId, {
    ...textOptions,
    category: undefined,
    limit: vector?.enabled ? Math.max(limit * 3, 10) : limit,
  });

  const ranked = new Map<string, { item: KnowledgeItem; score: number; bm25Rank?: number; vectorRank?: number }>();
  bm25Results.forEach((item, index) => {
    ranked.set(item.id, {
      item,
      score: 1 / (index + 1),
      bm25Rank: index + 1,
    });
  });

  if (vector?.enabled && vector.embedding) {
    const vectorResults = await searchKnowledgeEmbeddings(projectId, {
      vector: vector.embedding,
      category: undefined,
      status: options.status,
      tags: options.tags,
      provider: vector.provider,
      model: vector.model,
      limit: Math.max(limit * 3, 10),
    });

    vectorResults.forEach((result, index) => {
      const existing = ranked.get(result.item.id);
      const score = 1 / (index + 1);
      ranked.set(result.item.id, {
        item: result.item,
        score: (existing?.score ?? 0) + score,
        bm25Rank: existing?.bm25Rank,
        vectorRank: index + 1,
      });
    });
  }

  const tokens = queryTokens(options.query);
  const timestamps = [...ranked.values()].map(result => new Date(result.item.updatedAt).getTime());

  return [...ranked.values()]
    .sort((left, right) => {
      const leftCategoryBoost = options.category && left.item.category === options.category ? CATEGORY_HINT_BOOST : 0;
      const rightCategoryBoost = options.category && right.item.category === options.category ? CATEGORY_HINT_BOOST : 0;
      const leftTextScore = textMatchScore(left.item, tokens);
      const rightTextScore = textMatchScore(right.item, tokens);
      const similarRelevance = leftTextScore === rightTextScore;
      const leftScore =
        leftCategoryBoost +
        left.score +
        (similarRelevance ? normalizedRecencyScore(left.item, timestamps) * SIMILAR_RELEVANCE_RECENCY_BOOST : 0);
      const rightScore =
        rightCategoryBoost +
        right.score +
        (similarRelevance ? normalizedRecencyScore(right.item, timestamps) * SIMILAR_RELEVANCE_RECENCY_BOOST : 0);

      return rightScore - leftScore;
    })
    .slice(0, limit)
    .map(result => {
      const category = options.category && result.item.category === options.category ? CATEGORY_HINT_BOOST : 0;
      const text = textMatchScore(result.item, tokens);
      const recency = normalizedRecencyScore(result.item, timestamps) * SIMILAR_RELEVANCE_RECENCY_BOOST;
      const confidence = result.item.confidence * 0.01;
      const freshness = result.item.freshness === 'fresh' ? 0.05 : result.item.freshness === 'needs_review' ? -0.05 : -0.1;
      const contributions = { rank: result.score, text, category, recency, confidence, freshness };
      return {
        ...result.item,
        explanation: {
          finalScore: Object.values(contributions).reduce((sum, value) => sum + value, 0),
          bm25Rank: result.bm25Rank,
          vectorRank: result.vectorRank,
          contributions,
          reason: `rank=${result.score.toFixed(3)}, text=${text}, category=${category}, recency=${recency.toFixed(3)}`,
        },
      };
    });
}
