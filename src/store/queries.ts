import { eq, and, or, like, sql } from 'drizzle-orm';
import { getDb } from './database.js';
import * as schema from './schema.js';
import { KnowledgeItem, KnowledgeCategory, KnowledgeStatus } from '../core/types.js';
import { DatabaseError } from '../core/errors.js';

/**
 * Fetch active items for a project in a specific category.
 */
export async function getActiveKnowledgeByCategory(
  projectId: string,
  category: KnowledgeCategory
): Promise<KnowledgeItem[]> {
  const db = getDb();
  try {
    const results = await db
      .select()
      .from(schema.knowledgeItems)
      .where(
        and(
          eq(schema.knowledgeItems.projectId, projectId),
          eq(schema.knowledgeItems.category, category),
          eq(schema.knowledgeItems.status, 'active')
        )
      );

    return results.map(row => ({
      ...row,
      category: row.category as KnowledgeCategory,
      status: row.status as KnowledgeStatus,
      alternatives: row.alternatives as string[] | null,
      tags: row.tags as string[] | null,
    }));
  } catch (error: any) {
    throw new DatabaseError(`Failed to fetch category "${category}": ${error.message}`);
  }
}

/**
 * Fetch all active knowledge items hierarchically organized by layers.
 */
export async function getHierarchicalKnowledge(projectId: string) {
  const db = getDb();
  try {
    const results = await db
      .select()
      .from(schema.knowledgeItems)
      .where(eq(schema.knowledgeItems.projectId, projectId));

    const mapped = results.map(row => ({
      ...row,
      category: row.category as KnowledgeCategory,
      status: row.status as KnowledgeStatus,
      alternatives: row.alternatives as string[] | null,
      tags: row.tags as string[] | null,
    }));

    const state: KnowledgeItem[] = [];
    const knowledge: KnowledgeItem[] = [];
    const skills: KnowledgeItem[] = [];
    const archive: KnowledgeItem[] = [];

    for (const item of mapped) {
      if (item.status !== 'active') {
        archive.push(item);
      } else if (item.category === 'state') {
        state.push(item);
      } else if (item.category === 'skill') {
        skills.push(item);
      } else {
        knowledge.push(item);
      }
    }

    return { state, knowledge, skills, archive };
  } catch (error: any) {
    throw new DatabaseError(`Failed to fetch hierarchical knowledge: ${error.message}`);
  }
}

/**
 * Queries the knowledge base with optional filters (category, status, tags, search query).
 */
export async function queryKnowledgeBase(
  projectId: string,
  options: {
    category?: KnowledgeCategory;
    status?: KnowledgeStatus;
    tags?: string[];
    query?: string;
  }
): Promise<KnowledgeItem[]> {
  const db = getDb();
  try {
    const conditions = [eq(schema.knowledgeItems.projectId, projectId)];

    if (options.category) {
      conditions.push(eq(schema.knowledgeItems.category, options.category));
    }

    if (options.status) {
      conditions.push(eq(schema.knowledgeItems.status, options.status));
    } else {
      // By default query active unless status is specified
      conditions.push(eq(schema.knowledgeItems.status, 'active'));
    }

    if (options.query) {
      const searchPattern = `%${options.query}%`;
      conditions.push(
        or(
          like(schema.knowledgeItems.title, searchPattern),
          like(schema.knowledgeItems.content, searchPattern),
          like(schema.knowledgeItems.reasoning, searchPattern)
        )!
      );
    }

    let results = await db
      .select()
      .from(schema.knowledgeItems)
      .where(and(...conditions));

    let mapped = results.map(row => ({
      ...row,
      category: row.category as KnowledgeCategory,
      status: row.status as KnowledgeStatus,
      alternatives: row.alternatives as string[] | null,
      tags: row.tags as string[] | null,
    }));

    // Local filter for tags if specified (SQLite stored JSON arrays are easier filtered locally or via JSON1 extensions,
    // local filtering is highly robust and database-agnostic).
    if (options.tags && options.tags.length > 0) {
      const requiredTags = options.tags;
      mapped = mapped.filter(item => {
        if (!item.tags) return false;
        return requiredTags.every(reqTag => item.tags!.includes(reqTag));
      });
    }

    return mapped;
  } catch (error: any) {
    throw new DatabaseError(`Failed to query knowledge base: ${error.message}`);
  }
}
