import { KnowledgeItem } from '../core/types.js';
import { iterateKnowledgeItemsForIndexing } from './index-scan.js';
import { purgeEmbeddingsNotMatching, upsertKnowledgeEmbeddings } from './vector.js';

export type KnowledgeEmbedder = {
  provider: string;
  model: string;
  pooling: 'mean' | 'cls';
  /** Stamped on every row this embedder writes, and the filter its queries search under. */
  profileFingerprint: string;
  embed(texts: string[]): Promise<number[][]>;
  /**
   * A QUERY, not a document.
   *
   * Retrieval models are trained asymmetrically: the query carries an instruction the
   * document does not. Arctic and E5 want `query: `, Nomic wants `search_query: `. Omitting
   * it is the same class of silent mistake as the wrong pooling -- the model still returns
   * vectors, they are just measurably worse, and nothing reports a problem.
   *
   * A separate entry point rather than a flag on `embed`, because the asymmetry is invisible
   * at the call site otherwise, and every caller that forgets it loses accuracy silently.
   */
  embedQuery(text: string): Promise<number[]>;
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

    // One transaction per page, not one per row. Embedding happens above, outside it, so the
    // transaction is open only for the writes. See `upsertKnowledgeEmbeddings`: a row written
    // on its own fsyncs the WAL, which cost 11.57 ms per row against 0.088 ms batched.
    const writes = [];
    for (let i = 0; i < batch.length; i++) {
      const vector = vectors[i];
      if (!vector || vector.length === 0) continue;
      writes.push({
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
    await upsertKnowledgeEmbeddings(writes);
  }

  // Runs last so an interrupted rebuild never deletes rows it has not replaced.
  const purged = await purgeEmbeddingsNotMatching(projectId, embedder.profileFingerprint);

  return { indexed, purged, byStatus };
}
