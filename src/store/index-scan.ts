import { KnowledgeItem } from '../core/types.js';
import { getClient } from './database.js';
import { getKnowledgeItems } from './repository.js';

/**
 * Every knowledge item, in every status, in id order.
 *
 * Deliberately not `queryKnowledgeBase`: that applies `status = 'active'` when no
 * status is passed, so "omit the filter" means active-only there, and it has no
 * cursor, so its 10,000 limit truncates a larger store without saying so. Reindex
 * needs the opposite of both.
 *
 * `projectId` is accepted for symmetry with the rest of the store and is not a
 * predicate: one database holds one project, and `knowledge_items` has no such column.
 */
export async function* iterateKnowledgeItemsForIndexing(
  projectId: string,
  options: {
    batchSize?: number;
    /**
     * Restrict to items this profile has no usable vector for. Omit to visit every item.
     *
     * One predicate covers both cases a rebuild has to handle, which is why there is no
     * separate "did the model change" branch: after a model switch nothing matches the new
     * fingerprint, so every item is selected and the run is a full rebuild; with the model
     * unchanged only new and edited items are, and the run is proportional to the edits.
     */
    needsEmbeddingFor?: string;
  } = {},
): AsyncGenerator<KnowledgeItem[]> {
  const batchSize = options.batchSize ?? 500;
  const fingerprint = options.needsEmbeddingFor;
  let cursor = '';

  for (;;) {
    // Paging stays correct under the filter: the cursor advances by the last *returned*
    // id, and skipped rows sort below it, so no page can revisit or straddle them.
    const rows = fingerprint === undefined
      ? await getClient().execute({
        sql: `SELECT id FROM knowledge_items
              WHERE id > ?
              ORDER BY id
              LIMIT ?`,
        args: [cursor, batchSize],
      })
      : await getClient().execute({
        // `e.updated_at < i.updated_at` catches content edited after it was embedded.
        // Both columns are ISO-8601 UTC, so a text comparison is a chronological one.
        sql: `SELECT i.id AS id FROM knowledge_items i
              LEFT JOIN knowledge_embeddings e
                ON e.knowledge_item_id = i.id AND e.profile_fingerprint = ?
              WHERE i.id > ?
                AND (e.knowledge_item_id IS NULL OR e.updated_at < i.updated_at)
              ORDER BY i.id
              LIMIT ?`,
        args: [fingerprint, cursor, batchSize],
      });
    if (rows.rows.length === 0) return;

    const ids = rows.rows.map(row => String(row.id));
    cursor = ids[ids.length - 1];

    const items = await getKnowledgeItems(ids);
    const batch = ids.map(id => items.get(id)).filter((item): item is KnowledgeItem => Boolean(item));
    if (batch.length > 0) yield batch;
  }
}
