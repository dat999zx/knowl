import { KnowledgeItem } from '../core/types.js';
import { queryKnowledgeBase } from './queries.js';
import { upsertKnowledgeEmbedding } from './vector.js';

export type KnowledgeEmbedder = {
  provider: string;
  model: string;
  embed(texts: string[]): Promise<number[][]>;
  /**
   * Embed a QUERY rather than a document. Retrieval models are trained with an
   * asymmetric instruction prefix, so the two are not interchangeable. Optional
   * because a symmetric model does not need it and test stubs should not have to
   * implement it -- callers fall back to embed().
   */
  embedQuery?(text: string): Promise<number[]>;
};

/** Embed one query, using the model's own instruction prefix when it has one. */
export async function embedSearchQuery(embedder: KnowledgeEmbedder, query: string): Promise<number[]> {
  if (embedder.embedQuery) return embedder.embedQuery(query);
  const [vector] = await embedder.embed([query]);
  return vector;
}

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
    limit: 10_000,
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
