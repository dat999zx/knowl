import { KnowledgeCategory, KnowledgeItem, KnowledgeStatus } from '../core/types.js';
import { queryKnowledgeBase } from './queries.js';
import { searchKnowledgeEmbeddings } from './vector.js';

const DEFAULT_AGENT_QUERY_LIMIT = 3;

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

  return [...ranked.values()]
    .sort((left, right) => {
      const leftBoost = options.category && left.item.category === options.category ? 10 : 0;
      const rightBoost = options.category && right.item.category === options.category ? 10 : 0;
      return (right.score + rightBoost) - (left.score + leftBoost);
    })
    .slice(0, limit)
    .map(result => result.item);
}
