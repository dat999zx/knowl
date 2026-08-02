import { KnowledgeItem } from '../core/types.js';
import { iterateKnowledgeItemsForIndexing } from './index-scan.js';
import { purgeEmbeddingsNotMatching, upsertKnowledgeEmbedding } from './vector.js';

export type KnowledgeEmbedder = {
  provider: string;
  model: string;
  pooling: 'mean' | 'cls';
  /** Stamped on every row this embedder writes, and the filter its queries search under. */
  profileFingerprint: string;
  embed(texts: string[]): Promise<number[][]>;
};

export type VectorReindexResult = {
  indexed: number;
  purged: number;
  byStatus: Record<string, number>;
};

export function buildKnowledgeEmbeddingText(item: KnowledgeItem): string {
  const tags = item.tags?.length ? `\nTags: ${item.tags.join(', ')}` : '';
  const reasoning = item.reasoning ? `\nReasoning: ${item.reasoning}` : '';
  return `${item.title}\n${item.content}${reasoning}${tags}`;
}

/**
 * Rebuild every stored vector under the embedder's current profile.
 *
 * Every status, not just active: a superseded or archived item is still returned by
 * time-travel and archive queries, and leaving it unembedded made it reachable by
 * keyword alone while its active neighbours ranked semantically.
 */
export async function reindexKnowledgeEmbeddings(
  projectId: string,
  embedder: KnowledgeEmbedder,
): Promise<VectorReindexResult> {
  let indexed = 0;
  const byStatus: Record<string, number> = {};

  for await (const batch of iterateKnowledgeItemsForIndexing(projectId)) {
    const vectors = await embedder.embed(batch.map(buildKnowledgeEmbeddingText));

    for (let i = 0; i < batch.length; i++) {
      const vector = vectors[i];
      if (!vector || vector.length === 0) continue;
      await upsertKnowledgeEmbedding({
        projectId,
        knowledgeItemId: batch[i].id,
        provider: embedder.provider,
        model: embedder.model,
        profileFingerprint: embedder.profileFingerprint,
        dimensions: vector.length,
        vector,
      });
      indexed++;
      const status = batch[i].status ?? 'active';
      byStatus[status] = (byStatus[status] ?? 0) + 1;
    }
  }

  // Runs last so an interrupted rebuild never deletes rows it has not replaced.
  const purged = await purgeEmbeddingsNotMatching(projectId, embedder.profileFingerprint);

  return { indexed, purged, byStatus };
}
