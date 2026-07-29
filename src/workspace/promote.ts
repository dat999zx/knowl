import type { KnowledgeCategory } from '../core/types.js';
import { closeDb, getClient, initDb } from '../store/database.js';
import { createKnowledgeCommit } from '../store/repository.js';

export type PromoteTarget = { id: string; title: string; category: string };
export type PromoteResult = { items: PromoteTarget[]; applied: boolean; skippedForeign: number };

/**
 * Backfill existing knowledge into workspace visibility.
 *
 * Category routing governs future writes only, so without this, linking shares nothing a
 * team already learned -- including the cross-repo decision that motivates the feature and
 * that already exists in someone's repo today.
 *
 * Promotion is a one-column update: it does not touch `content_hash`, create rows, or move
 * anything between databases. Only items this repo originated can be promoted, because
 * publishing another repo's knowledge is that repo's decision. There is deliberately no
 * `demote`: retracting something other repos have already read needs a mechanism this
 * design does not have.
 */
export async function promoteItems(input: {
  projectRoot: string;
  repoName: string;
  categories?: KnowledgeCategory[];
  ids?: string[];
  apply?: boolean;
}): Promise<PromoteResult> {
  const byCategory = input.categories?.length ? input.categories : null;
  const byId = input.ids?.length ? input.ids : null;
  if (!byCategory && !byId) {
    throw new Error('Specify what to promote with --category <list> or --id <id>. A bare promote would publish the whole repo.');
  }

  await initDb(input.projectRoot);
  try {
    const client = getClient();
    const selector = byId
      ? { clause: `id IN (${byId.map(() => '?').join(', ')})`, args: [...byId] as string[] }
      : { clause: `category IN (${byCategory!.map(() => '?').join(', ')})`, args: [...byCategory!] as string[] };

    // Counted separately so the caller can say "1 item belongs to web" rather than silently
    // returning fewer rows than the user asked for.
    const foreign = await client.execute({
      sql: `SELECT COUNT(*) AS n FROM knowledge_items
            WHERE ${selector.clause} AND status = 'active'
              AND visibility = 'repo' AND (origin_repo IS NULL OR origin_repo <> ?)`,
      args: [...selector.args, input.repoName],
    });

    const rows = await client.execute({
      sql: `SELECT id, title, category FROM knowledge_items
            WHERE ${selector.clause} AND status = 'active'
              AND visibility = 'repo' AND origin_repo = ?
            ORDER BY updated_at DESC`,
      args: [...selector.args, input.repoName],
    });

    const items: PromoteTarget[] = rows.rows.map(row => ({
      id: String(row.id),
      title: String(row.title),
      category: String(row.category),
    }));

    if (input.apply && items.length > 0) {
      await client.execute({
        sql: `UPDATE knowledge_items SET visibility = 'workspace' WHERE id IN (${items.map(() => '?').join(', ')})`,
        args: items.map(item => item.id),
      });
      // Promotion is the moment an item becomes readable by other repos, so it is the
      // moment their agents need told. Change detection reads `knowledge_commits`; a bare
      // column update left no trace there, which made a promote the one knowledge event
      // that could never be noticed -- including by the repos it was performed for.
      await createKnowledgeCommit(
        'local',
        `Promote ${items.length} item${items.length === 1 ? '' : 's'} to workspace visibility`,
        items.map(item => ({
          itemId: item.id,
          action: 'update' as const,
          after: { id: item.id, category: item.category as KnowledgeCategory, title: item.title },
        })),
      );
    }

    return {
      items,
      applied: Boolean(input.apply) && items.length > 0,
      skippedForeign: Number(foreign.rows[0]?.n ?? 0),
    };
  } finally {
    await closeDb();
  }
}
