import { eq, and, or, like, sql, SQL } from 'drizzle-orm';
import { getDb } from './database.js';
import * as schema from './schema.js';
import { searchKnowledgeItemsRanked } from './search.js';
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

export type KnowledgeQueryOptions = {
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
};

/**
 * A selected item and the lexical evidence for it, on a scale where higher is better.
 *
 * `source` names which engine produced the number, because the two are not the same quantity:
 * `fts` is `-bm25()`, `like` is the substring path's own saturation score below. They are never
 * mixed inside one store's answer -- the fallback runs only when FTS returned nothing -- and a
 * consumer that fuses several stores must normalise each store's scores separately anyway,
 * because BM25 is corpus-relative by construction.
 */
export type LexicalCandidate = { item: KnowledgeItem; lexicalScore: number; source: 'fts' | 'like' };

/**
 * BM25's term-saturation and length-normalisation components, for the substring fallback.
 *
 * The fallback matches one literal pattern rather than a bag of tokens, so IDF is the same
 * constant for every candidate and cancels out of the ordering entirely; what is left is the
 * part that actually discriminates. Without it the fallback did not rank at all -- it took
 * whatever rowid order handed it, which is insertion order, so a store returned its ten
 * OLDEST matches and the item that answered was never offered to the ranker.
 */
const LIKE_K1 = 1.2;
const LIKE_B = 0.75;

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

function likeCandidateScores(items: KnowledgeItem[], query: string): number[] {
  const needle = query.toLowerCase();
  const fields = items.map(item => ({
    // A hit in the title is worth more than one in the body, which is what an FTS5 column
    // weight would express. Repeating the title is how bm25() itself would be told so.
    text: `${item.title} ${item.title} ${item.title} ${item.content} ${item.reasoning ?? ''}`.toLowerCase(),
  }));
  const lengths = fields.map(field => field.text.length);
  const averageLength = lengths.reduce((sum, value) => sum + value, 0) / Math.max(lengths.length, 1) || 1;

  return fields.map((field, index) => {
    const tf = countOccurrences(field.text, needle);
    if (tf === 0) return 0;
    const norm = 1 - LIKE_B + LIKE_B * (lengths[index] / averageLength);
    return (tf * (LIKE_K1 + 1)) / (tf + LIKE_K1 * norm);
  });
}

/**
 * Queries the knowledge base with optional filters (category, status, tags, search query).
 */
export async function queryKnowledgeBase(
  projectId: string,
  options: KnowledgeQueryOptions,
  store: StoreHandle = localStore(),
): Promise<KnowledgeItem[]> {
  return (await queryKnowledgeCandidates(projectId, options, store)).map(candidate => candidate.item);
}

/** The same selection, with the lexical evidence the ranker needs. */
export async function queryKnowledgeCandidates(
  projectId: string,
  options: KnowledgeQueryOptions,
  store: StoreHandle = localStore(),
): Promise<LexicalCandidate[]> {
  const resultLimit = options.limit;
  const db = store.db;
  try {
    if (options.query) {
      const ftsResults = await searchKnowledgeItemsRanked(projectId, {
        category: options.category,
        status: options.status,
        tags: options.tags,
        query: options.query,
        limit: options.limit,
        visibility: options.visibility,
      }, store);

      if (ftsResults.length > 0) {
        // Negated on the way out: FTS5 returns a negative score where more negative is a
        // better match, and every consumer above this line reads "higher is better".
        const candidates: LexicalCandidate[] = ftsResults.map(hit => ({
          item: hit.item, lexicalScore: -hit.bm25, source: 'fts',
        }));
        if (!options.asOf) return resultLimit === undefined ? candidates : candidates.slice(0, resultLimit);
        // An `asOf` query used to compute these and throw them away, dropping to the
        // whole-phrase LIKE below -- so "auth token expire" missed "Auth token TTL is
        // fifteen minutes", one filler word from a match, exactly as the peer scan did
        // before it was tokenized. Historical resolution is a filter over the same
        // candidates, not a reason to select them differently.
        return resolveAsOf(candidates, options.asOf, resultLimit);
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

    // Same predicate the FTS path uses, and for the same reason: a filter that decides
    // whether a row may be returned belongs in SQL. Verified exactly against the parsed
    // array below, so this narrows rather than decides.
    for (const tag of options.tags ?? []) {
      conditions.push(sql`${schema.knowledgeItems.tags} LIKE ${`%"${tag}"%`}`);
    }

    // Fallback for queries FTS5 cannot answer. Measured: it is reached when every token is a
    // stop word (`buildFtsQuery` returns null) or when the query is an infix of an indexed
    // token. It is NOT reached by `/mcp` or `package.json`, which the previous comment here
    // claimed -- FTS5's tokenizer splits both and matches them.
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

    // Exact check against the parsed array; the SQL predicate above is a superset of it.
    if (options.tags && options.tags.length > 0) {
      const requiredTags = options.tags;
      mapped = mapped.filter(item => {
        if (!item.tags) return false;
        return requiredTags.every(reqTag => item.tags!.includes(reqTag));
      });
    }

    // Ranked BEFORE the cap. Without a query there is nothing to rank by, and the caller is
    // browsing rather than searching, so insertion order stands.
    let candidates: LexicalCandidate[] = mapped.map(item => ({ item, lexicalScore: 0, source: 'like' }));
    if (options.query) {
      const scores = likeCandidateScores(mapped, options.query);
      candidates = mapped
        .map((item, index) => ({ item, lexicalScore: scores[index], source: 'like' as const }))
        // Ties broken by recency, so equal-strength matches are not silently ordered oldest
        // first -- which is what rowid order meant and is the opposite of what a reader wants.
        .sort((left, right) => right.lexicalScore - left.lexicalScore
          || new Date(right.item.updatedAt).getTime() - new Date(left.item.updatedAt).getTime());
    }

    if (!options.asOf) return resultLimit === undefined ? candidates : candidates.slice(0, resultLimit);
    return resolveAsOf(candidates, options.asOf, resultLimit);
  } catch (error: any) {
    throw new DatabaseError(`Failed to query knowledge base: ${error.message}`);
  }
}

/**
 * Rewind candidates to the content they held at a point in time, dropping any that did not
 * exist yet. Shared by both selection paths so historical results are the same candidates the
 * present-tense query would have found.
 */
async function resolveAsOf(
  candidates: LexicalCandidate[],
  asOf: string,
  resultLimit: number | undefined,
): Promise<LexicalCandidate[]> {
  const historical = await Promise.all(candidates.map(async candidate => {
    const assertion = await findAssertionAsOf(candidate.item.id, asOf);
    return assertion
      ? { ...candidate, item: { ...candidate.item, content: assertion.content, confidence: assertion.confidence } }
      : null;
  }));
  const resolved = historical.filter((candidate): candidate is LexicalCandidate => candidate !== null);
  return resultLimit === undefined ? resolved : resolved.slice(0, resultLimit);
}
