import { and, desc, eq, isNull, notLike, sql } from 'drizzle-orm';
import { KnowledgeCommit, KnowledgeItem } from '../core/types.js';
import { DatabaseError } from '../core/errors.js';
import { getDb } from './database.js';
import * as schema from './schema.js';
import { getKnowledgeCommits, mapRowToKnowledgeItem } from './repository.js';

export type RecentContext = {
  items: KnowledgeItem[];
  commits: KnowledgeCommit[];
};

export async function getRecentContext(
  projectId: string,
  options: {
    itemLimit?: number;
    commitLimit?: number;
    includeEphemeral?: boolean;
  } = {}
): Promise<RecentContext> {
  const db = getDb();
  const itemLimit = options.itemLimit ?? 3;
  const commitLimit = options.commitLimit ?? 8;

  try {
    const conditions = [eq(schema.knowledgeItems.status, 'active')];
    if (!options.includeEphemeral) {
      conditions.push(notLike(schema.knowledgeItems.title, 'Verified command:%'));
      conditions.push(notLike(schema.knowledgeItems.title, 'Work Loop checkpoint%'));
    }
    // Ordered by when the claim was last RESTATED, not by when its row was last written.
    //
    // `updated_at` moves on supersession, archival, visibility promotion and a freshness flip,
    // none of which mean anyone revisited the claim -- `unrestated.ts` measured 72% of items on
    // a 950-item store carrying an `updated_at` newer than their `valid_from`. Ordering three
    // card slots by it had one consequence worth naming: `blastRadius` flags a sibling
    // `needs_review` through `updateKnowledgeItem`, which stamps `updated_at` unconditionally,
    // so correcting one atom PROMOTED unrelated atoms onto the session card for having just
    // been marked doubtful -- evicting whatever the session had actually learned.
    //
    // A new assertion generation is written only when title, content, reasoning or confidence
    // change, so `valid_from` moves on restatement and on nothing else. Same clock and same
    // join `unrestated.ts` already established.
    //
    // LEFT joined, where that module inner-joins. It is reporting on a population and may
    // exclude a row it cannot date; this is a card with three slots, and an item with no open
    // assertion -- an import, a store predating the table -- must still be reachable. Such a
    // row falls back to `updated_at`, which is exactly the old behaviour for exactly the rows
    // that have nothing better.
    const restatedAt = sql<string>`coalesce(${schema.knowledgeAssertions.validFrom}, ${schema.knowledgeItems.updatedAt})`;
    const rows = await db
      .select({ item: schema.knowledgeItems })
      .from(schema.knowledgeItems)
      .leftJoin(
        schema.knowledgeAssertions,
        and(
          eq(schema.knowledgeAssertions.knowledgeItemId, schema.knowledgeItems.id),
          isNull(schema.knowledgeAssertions.validTo),
        ),
      )
      .where(and(...conditions))
      // Tie-broken to a total order, because the primary key is not one. ISO timestamps are
      // millisecond-granular, and three atoms written by one turn routinely share a
      // millisecond on a fast machine -- CI's macOS runner produced a different second slot
      // than Windows did from the same fixture. `updated_at` had the same property; ordering
      // three card slots by a partial order means the card can differ between two identical
      // calls, which is the kind of instability that reads as a bug in whatever consumed it.
      // `id` last because it is arbitrary but stable, which is exactly what a final tiebreak
      // should be; `created_at` first because when it does differ it is meaningful.
      .orderBy(desc(restatedAt), desc(schema.knowledgeItems.createdAt), desc(schema.knowledgeItems.id))
      .limit(itemLimit);

    const items = rows.map(row => mapRowToKnowledgeItem(row.item));

    const commits = await getKnowledgeCommits(projectId, commitLimit);
    return { items, commits };
  } catch (error: any) {
    throw new DatabaseError(`Failed to fetch recent context: ${error.message}`);
  }
}
