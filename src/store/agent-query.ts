import { KnowledgeCategory, KnowledgeItem, KnowledgeStatus } from '../core/types.js';
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
    item.tags.join(' '),
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
  const limit = options.limit ?? DEFAULT_AGENT_QUERY_LIMIT;
  const { vector, ...textOptions } = options;
  const bm25Results = await queryKnowledgeBase(projectId, {
    ...textOptions,
    category: undefined,
    limit: vector?.enabled ? Math.max(limit * 3, 10) : limit,
  });

  const ranked = new Map<string, { item: KnowledgeItem; score: number }>();
  bm25Results.forEach((item, index) => {
    ranked.set(item.id, {
      item,
      score: 1 / (index + 1),
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
    .map(result => result.item);
}
