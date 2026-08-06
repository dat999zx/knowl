import { and, desc, eq, notLike } from 'drizzle-orm';
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
    const rows = await db
      .select()
      .from(schema.knowledgeItems)
      .where(and(...conditions))
      .orderBy(desc(schema.knowledgeItems.updatedAt))
      .limit(itemLimit);

    const items = rows.map(mapRowToKnowledgeItem);

    const commits = await getKnowledgeCommits(projectId, commitLimit);
    return { items, commits };
  } catch (error: any) {
    throw new DatabaseError(`Failed to fetch recent context: ${error.message}`);
  }
}
