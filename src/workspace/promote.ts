import { isKnowledgeCategory, KNOWLEDGE_CATEGORIES, type KnowledgeCategory } from '../core/types.js';
import { closeDb, getClient, initDb } from '../store/database.js';
import { hashKnowledgeLifecycle } from '../store/freshness.js';
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

  // A category that cannot exist matches nothing, and "matched nothing" is also what a
  // correctly-spelled filter reports for an already-shared repo. Rejecting it here keeps the
  // two apart. This fires on Windows without a typo: `knowl.cmd` runs through cmd.exe, which
  // treats commas as argument separators, so an unquoted `--category a,b,c` arrives as `a`.
  const unknownCategories = (byCategory ?? []).filter(entry => !isKnowledgeCategory(entry));
  if (unknownCategories.length > 0) {
    throw new Error(
      `Not a knowledge category: ${unknownCategories.map(entry => `"${entry}"`).join(', ')}. ` +
      `Valid categories are ${KNOWLEDGE_CATEGORIES.join(', ')}. ` +
      'On Windows quote the list -- --category "decision,constraint" -- because cmd.exe splits on the commas.',
    );
  }

  await initDb(input.projectRoot);
  try {
    const client = getClient();
    const selector = byId
      ? { clause: `id IN (${byId.map(() => '?').join(', ')})`, args: [...byId] as string[] }
      : { clause: `category IN (${byCategory!.map(() => '?').join(', ')})`, args: [...byCategory!] as string[] };

    // Counted separately so the caller can say "1 item belongs to web" rather than silently
    // returning fewer rows than the user asked for. An unowned item is not foreign: NULL
    // means nobody has claimed it, and claiming it here would be wrong only if some other
    // repo could have written it, which it cannot -- this database is this repo's.
    const foreign = await client.execute({
      sql: `SELECT COUNT(*) AS n FROM knowledge_items
            WHERE ${selector.clause} AND status = 'active'
              AND visibility = 'repo' AND origin_repo IS NOT NULL AND origin_repo <> ?`,
      args: [...selector.args, input.repoName],
    });

    // An id nobody has is a different failure from an id another repo owns, and only the
    // first is a mistake in the command. It refuses rather than reporting an empty result,
    // and refuses before anything is applied: promoting the ids that did resolve while
    // reporting the one that did not would be a partial, irreversible change -- there is
    // deliberately no demote -- announced by an error.
    //
    // Deliberately unfiltered by status, visibility and owner: the question is only whether
    // the id exists, so an already-promoted or superseded item stays a known id whose absence
    // from the results has its own explanation.
    if (byId) {
      const known = await client.execute({
        sql: `SELECT id FROM knowledge_items WHERE id IN (${byId.map(() => '?').join(', ')})`,
        args: [...byId],
      });
      const present = new Set(known.rows.map(row => String(row.id)));
      const unknown = byId.filter(id => !present.has(id));
      if (unknown.length > 0) {
        throw new Error(
          `No item with id ${unknown.map(id => `"${id}"`).join(', ')}. ` +
          'Ids must be given in full -- a truncated id from a listing matches nothing.',
        );
      }
    }

    // Ownership is stamped at write time now, so a NULL owner means the row predates that
    // and predates the join backfill. Claiming it here is still right for the same reason
    // the backfill claims: this database is this repo's, so nothing else could have written
    // it. Applying the promotion below stamps it for good.
    const rows = await client.execute({
      sql: `SELECT id, title, category, status, freshness, superseded_by_id FROM knowledge_items
            WHERE ${selector.clause} AND status = 'active'
              AND visibility = 'repo' AND (origin_repo IS NULL OR origin_repo = ?)
            ORDER BY updated_at DESC`,
      args: [...selector.args, input.repoName],
    });

    const items: PromoteTarget[] = rows.rows.map(row => ({
      id: String(row.id),
      title: String(row.title),
      category: String(row.category),
    }));

    if (input.apply && items.length > 0) {
      // Promotion changes two of the five fields the lifecycle hash covers, and it is raw
      // SQL rather than `updateKnowledgeItem` precisely so `content_hash`, `version` and
      // `updated_at` stay put. That means the lifecycle hash has to be written here too, or
      // an export of a promoted item would carry the pre-promotion fingerprint and the
      // receiving side would classify it as identical and skip it -- the exact failure
      // `lifecycle_hash` exists to fix.
      // `updated_at` moves as well. Divergence resolution orders by it, so a promotion that
      // left it alone was a change no other machine could ever prefer: identical timestamp,
      // identical version, and `newer` keeps local on a tie. `content_hash` still does not
      // move -- the content genuinely did not change, and that is the invariant that keeps
      // re-import idempotent.
      const promotedAt = new Date().toISOString();
      for (const row of rows.rows) {
        await client.execute({
          sql: 'UPDATE knowledge_items SET visibility = ?, origin_repo = ?, lifecycle_hash = ?, updated_at = ? WHERE id = ?',
          args: [
            'workspace',
            input.repoName,
            hashKnowledgeLifecycle({
              status: String(row.status),
              freshness: String(row.freshness),
              supersededById: row.superseded_by_id === null ? null : String(row.superseded_by_id),
              originRepo: input.repoName,
              visibility: 'workspace',
            }),
            promotedAt,
            String(row.id),
          ],
        });
      }
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
