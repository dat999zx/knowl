import { KnowledgeItem } from '../core/types.js';
import { queryKnowledgeBase } from './queries.js';
import { upsertKnowledgeEmbedding } from './vector.js';

export type KnowledgeEmbedder = {
  provider: string;
  model: string;
  embed(texts: string[]): Promise<number[][]>;
};

export type VectorReindexResult = {
  indexed: number;
};

export function buildKnowledgeEmbeddingText(item: KnowledgeItem): string {
  const tags = item.tags?.length ? `\nTags: ${item.tags.join(', ')}` : '';
  const reasoning = item.reasoning ? `\nReasoning: ${item.reasoning}` : '';
  return `${item.title}\n${item.content}${reasoning}${tags}`;
}

export async function reindexKnowledgeEmbeddings(
  projectId: string,
  embedder: KnowledgeEmbedder
): Promise<VectorReindexResult> {
  const items = await queryKnowledgeBase(projectId, {
    status: 'active',
  });

  if (items.length === 0) {
    return { indexed: 0 };
  }

  const vectors = await embedder.embed(items.map(buildKnowledgeEmbeddingText));

  for (let i = 0; i < items.length; i++) {
    const vector = vectors[i];
    if (!vector || vector.length === 0) continue;
    await upsertKnowledgeEmbedding({
      projectId,
      knowledgeItemId: items[i].id,
      provider: embedder.provider,
      model: embedder.model,
      dimensions: vector.length,
      vector,
    });
  }

  return {
    indexed: vectors.filter(vector => vector && vector.length > 0).length,
  };
}
