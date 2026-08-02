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
  options: { batchSize?: number } = {},
): AsyncGenerator<KnowledgeItem[]> {
  const batchSize = options.batchSize ?? 500;
  let cursor = '';

  for (;;) {
    const rows = await getClient().execute({
      sql: `SELECT id FROM knowledge_items
            WHERE id > ?
            ORDER BY id
            LIMIT ?`,
      args: [cursor, batchSize],
    });
    if (rows.rows.length === 0) return;

    const ids = rows.rows.map(row => String(row.id));
    cursor = ids[ids.length - 1];

    const items = await getKnowledgeItems(ids);
    const batch = ids.map(id => items.get(id)).filter((item): item is KnowledgeItem => Boolean(item));
    if (batch.length > 0) yield batch;
  }
}
