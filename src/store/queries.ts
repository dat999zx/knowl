import { eq, and, or, like, SQL } from 'drizzle-orm';
import { getDb } from './database.js';
import * as schema from './schema.js';
import { searchKnowledgeItems } from './search.js';
import { localStore, type StoreHandle } from './store-handle.js';
import { KnowledgeItem, KnowledgeCategory, KnowledgeStatus } from '../core/types.js';
import { DatabaseError } from '../core/errors.js';
import { mapRowToKnowledgeItem } from './repository.js';
import { findAssertionAsOf } from './assertions.js';

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
          eq(schema.knowledgeItems.category, category),
          eq(schema.knowledgeItems.status, 'active')
        )
      );

    return results.map(mapRowToKnowledgeItem);
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
      .from(schema.knowledgeItems);

    const mapped = results.map(mapRowToKnowledgeItem);

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
    limit?: number;
    asOf?: string;
    /**
     * Restricts to shared items. Must reach **both** paths below: the LIKE fallback runs
     * whenever FTS returns nothing, which is exactly the case where a private row would
     * otherwise slip through after the indexed path correctly excluded it.
     */
    visibility?: 'repo' | 'workspace';
  },
  store: StoreHandle = localStore(),
): Promise<KnowledgeItem[]> {
  const resultLimit = options.limit;
  const db = store.db;
  try {
    if (options.query) {
      const ftsResults = await searchKnowledgeItems(projectId, {
        category: options.category,
        status: options.status,
        tags: options.tags,
        query: options.query,
        limit: options.limit,
        visibility: options.visibility,
      }, store);

      if (ftsResults.length > 0) {
        if (!options.asOf) return resultLimit === undefined ? ftsResults : ftsResults.slice(0, resultLimit);
      }
    }

    const conditions: SQL[] = [];

    if (options.category) {
      conditions.push(eq(schema.knowledgeItems.category, options.category));
    }

    if (options.status) {
      conditions.push(eq(schema.knowledgeItems.status, options.status));
    } else {
      // By default query active unless status is specified
      conditions.push(eq(schema.knowledgeItems.status, 'active'));
    }

    if (options.visibility) {
      conditions.push(eq(schema.knowledgeItems.visibility, options.visibility));
    }

    // Fallback: If FTS returned no results (or wasn't matched due to FTS5 stripping special characters 
    // like '/' or '.' in queries like '/mcp' or 'package.json'), we fall back to a standard SQL LIKE 
    // substring search which is highly resilient for literal substring matching of code-specific terms.
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

    const baseQuery = db
      .select()
      .from(schema.knowledgeItems);
    let results = conditions.length > 0
      ? await baseQuery.where(and(...conditions))
      : await baseQuery;

    let mapped = results.map(mapRowToKnowledgeItem);

    // Local filter for tags if specified (SQLite stored JSON arrays are easier filtered locally or via JSON1 extensions,
    // local filtering is highly robust and database-agnostic).
    if (options.tags && options.tags.length > 0) {
      const requiredTags = options.tags;
      mapped = mapped.filter(item => {
        if (!item.tags) return false;
        return requiredTags.every(reqTag => item.tags!.includes(reqTag));
      });
    }

    if (!options.asOf) return resultLimit === undefined ? mapped : mapped.slice(0, resultLimit);
    const historical = await Promise.all(mapped.map(async item => {
      const assertion = await findAssertionAsOf(item.id, options.asOf!);
      return assertion ? { ...item, content: assertion.content, confidence: assertion.confidence } : null;
    }));
    const resolved = historical.filter((item): item is KnowledgeItem => item !== null);
    return resultLimit === undefined ? resolved : resolved.slice(0, resultLimit);
  } catch (error: any) {
    throw new DatabaseError(`Failed to query knowledge base: ${error.message}`);
  }
}
