import { KnowledgeItem } from '../core/types.js';
import { getClient } from './database.js';
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
  /** Items left alone because this profile already has a current vector for them. */
  skipped: number;
  purged: number;
  byStatus: Record<string, number>;
};

export type VectorReindexOptions = {
  /**
   * Re-embed every item even when its stored vector is current.
   *
   * The escape hatch for staleness the fingerprint cannot see: `buildKnowledgeEmbeddingText`
   * changing what it feeds the model produces different vectors from the same profile, and
   * nothing in the database records which shape of text a row was built from.
   */
  force?: boolean;
};

export function buildKnowledgeEmbeddingText(item: KnowledgeItem): string {
  const tags = item.tags?.length ? `\nTags: ${item.tags.join(', ')}` : '';
  const reasoning = item.reasoning ? `\nReasoning: ${item.reasoning}` : '';
  return `${item.title}\n${item.content}${reasoning}${tags}`;
}

/**
 * Bring every stored vector up to date under the embedder's current profile.
 *
 * Every status, not just active: a superseded or archived item is still returned by
 * time-travel and archive queries, and leaving it unembedded made it reachable by
 * keyword alone while its active neighbours ranked semantically.
 *
 * Only the items that need it are embedded. A model change invalidates everything at once
 * -- no row carries the new fingerprint -- so that case still rebuilds the whole store,
 * while a routine run after a few writes costs a few forward passes instead of one per
 * item. Embedding is the expensive part by orders of magnitude, so re-embedding a corpus
 * to write back vectors identical to the ones already stored was the whole cost of the run.
 */
export async function reindexKnowledgeEmbeddings(
  projectId: string,
  embedder: KnowledgeEmbedder,
  options: VectorReindexOptions = {},
): Promise<VectorReindexResult> {
  let indexed = 0;
  const byStatus: Record<string, number> = {};
  // Read before the loop: an item embedded during this run must not be counted as skipped.
  const total = options.force ? 0 : await countKnowledgeItems();

  const scan = iterateKnowledgeItemsForIndexing(projectId, {
    needsEmbeddingFor: options.force ? undefined : embedder.profileFingerprint,
  });

  for await (const batch of scan) {
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

  return { indexed, skipped: Math.max(0, total - indexed), purged, byStatus };
}

/** How many items a full pass would have visited, for the skipped count. */
async function countKnowledgeItems(): Promise<number> {
  const rows = await getClient().execute('SELECT COUNT(*) AS total FROM knowledge_items');
  return Number((rows.rows[0] as any)?.total ?? 0);
}
