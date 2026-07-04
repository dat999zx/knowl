import { KnowledgeCategory, KnowledgeItem, KnowledgeStatus } from '../core/types.js';
import { queryKnowledgeBase } from './queries.js';

const DEFAULT_AGENT_QUERY_LIMIT = 3;

export async function queryKnowledgeForAgent(
  projectId: string,
  options: {
    category?: KnowledgeCategory;
    status?: KnowledgeStatus;
    tags?: string[];
    query?: string;
    limit?: number;
  }
): Promise<KnowledgeItem[]> {
  const limit = options.limit ?? DEFAULT_AGENT_QUERY_LIMIT;
  const results = await queryKnowledgeBase(projectId, {
    ...options,
    category: undefined,
    limit,
  });

  if (!options.category || results.length === 0) {
    return results;
  }

  return [...results].sort((left, right) => {
    const leftBoost = left.category === options.category ? 1 : 0;
    const rightBoost = right.category === options.category ? 1 : 0;
    return rightBoost - leftBoost;
  });
}
