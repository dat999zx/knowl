import { and, desc, eq } from 'drizzle-orm';
import { KnowledgeCommit, KnowledgeItem, KnowledgeCategory, KnowledgeStatus } from '../core/types.js';
import { DatabaseError } from '../core/errors.js';
import { getDb } from './database.js';
import * as schema from './schema.js';
import { getKnowledgeCommits } from './repository.js';

export type RecentContext = {
  items: KnowledgeItem[];
  commits: KnowledgeCommit[];
};

export async function getRecentContext(
  projectId: string,
  options: {
    itemLimit?: number;
    commitLimit?: number;
  } = {}
): Promise<RecentContext> {
  const db = getDb();
  const itemLimit = options.itemLimit ?? 12;
  const commitLimit = options.commitLimit ?? 8;

  try {
    const rows = await db
      .select()
      .from(schema.knowledgeItems)
      .where(and(
        eq(schema.knowledgeItems.projectId, projectId),
        eq(schema.knowledgeItems.status, 'active')
      ))
      .orderBy(desc(schema.knowledgeItems.updatedAt))
      .limit(itemLimit);

    const items = rows.map(row => ({
      ...row,
      category: row.category as KnowledgeCategory,
      status: row.status as KnowledgeStatus,
      alternatives: row.alternatives as string[] | null,
      tags: row.tags as string[] | null,
    }));

    const commits = await getKnowledgeCommits(projectId, commitLimit);
    return { items, commits };
  } catch (error: any) {
    throw new DatabaseError(`Failed to fetch recent context: ${error.message}`);
  }
}
