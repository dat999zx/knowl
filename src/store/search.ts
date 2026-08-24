import { sql, type SQL } from 'drizzle-orm';
import { getKnowledgeItems } from './repository.js';
import { localStore, type StoreHandle } from './store-handle.js';
import { KnowledgeCategory, KnowledgeItem, KnowledgeStatus } from '../core/types.js';

const SEARCH_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'does', 'for', 'from', 'how', 'in',
  'is', 'it', 'of', 'on', 'or', 'our', 'the', 'this', 'to', 'use', 'uses', 'using', 'what',
  'when', 'where', 'which', 'who', 'why', 'with',
]);

// Null-prototype: a plain object literal answers `SEARCH_SYNONYMS['constructor']`
// and `SEARCH_SYNONYMS['__proto__']` with an inherited Object.prototype member,
// which is truthy and not iterable — so the expansion loop below threw for any
// query containing either word. Both survive the tokenizer, and both occur in
// ordinary error text and commit bodies.
const SEARCH_SYNONYMS: Record<string, string[]> = Object.assign(Object.create(null) as Record<string, string[]>, {
  auth: ['authentication'],
  authentication: ['auth'],
  backend: ['server'],
  client: ['frontend'],
  database: ['db', 'storage', 'persistence', 'persist'],
  db: ['database', 'storage', 'persistence', 'persist'],
  frontend: ['client'],
  persist: ['persistence', 'storage', 'database', 'db'],
  persistence: ['persist', 'storage', 'database', 'db'],
  server: ['backend'],
  storage: ['persistence', 'persist', 'database', 'db'],
});

/**
 * The query as groups of interchangeable terms: each original token with its synonyms.
 *
 * Grouped rather than flattened because coverage has to be counted per *term the user asked
 * for*. Flattening makes `db` two terms and an item that says "database" cover half a query
 * it answers completely.
 */
function queryTokenGroups(query: string): string[][] {
  // `\p{L}\p{N}` rather than `a-z0-9`, because an ASCII-only class makes every letter outside
  // a-z a SEPARATOR rather than a character. Measured (docs/evals/multilingual.md):
  // `hành vi của cờ đánh dấu đã xóa` tokenised to ["nh", "vi", "nh"] -- eight words to three
  // fragments, one a duplicate -- and `cờ đã xóa`, whose every word shreds below the
  // two-character minimum, produced NO tokens at all, so buildFtsQuery returned null and the
  // lexical path returned nothing for a query that names the stored item.
  //
  // Not a new convention: `src/transcripts/search.ts` toMatchQuery already tokenises this way.
  // Blast radius on the real 482-item store: 5 items (1.0%), each an accented word that used
  // to break into fragments (`hambüchen` was `hamb` + `chen`) and is now one token.
  const tokens = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .map(token => token.trim())
    .filter(token => token.length >= 2 && !SEARCH_STOP_WORDS.has(token));

  const groups: string[][] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    groups.push([token, ...(SEARCH_SYNONYMS[token] || [])]);
  }
  return groups;
}

/**
 * How many distinct terms a query contributes to coverage -- the DENOMINATOR `queryCoverage`
 * divides by. Exported for measurement only: coverage is a fraction, and a fraction whose
 * denominator is 1 carries no information, so any judgement about coverage as a relevance
 * signal has to be able to see this number alongside it.
 */
export function queryTermCount(query: string): number {
  return queryTokenGroups(query).length;
}

function tokenizeSearchQuery(query: string): string[] {
  return [...new Set(queryTokenGroups(query).flat())];
}

function buildFtsQuery(query: string): string | null {
  const tokens = tokenizeSearchQuery(query);
  if (tokens.length === 0) return null;
  return tokens.map(token => `${token}*`).join(' OR ');
}

/**
 * The share of the query's distinct terms this item contains.
 *
 * FTS5 is asked `a* OR b* OR c*`, so a document matching one term out of three is a hit with
 * a real BM25 score, and nothing in that score says how much of the question it answered.
 * Coverage does, and unlike BM25 it means the same thing in every repo: it is a property of
 * the item and the query, with no corpus statistics in it. Prefix-matched, because that is
 * what the FTS query asked for.
 *
 * IT IS QUANTIZED AT `1 / groups.length`, AND THAT IS WHY IT CANNOT BE A RELEVANCE FLOOR.
 * Measured 2026-08-24 against this repo's ~1,200-atom store (`scripts/probe-query-coverage.ts`,
 * written up in `docs/evals/query-coverage-probe.md`), while looking for a corpus-free
 * replacement for the cosine floor that issue #169 showed cannot exist per-model.
 *
 * A short query has few groups, so it has few reachable values: a two-term question can only
 * score 0, 0.5 or 1. Genuinely on-topic questions are often short precisely because they are
 * vague -- `why is startup slow` is two terms after stop-words and scored **0.500** against a
 * store that answers it in detail. Partially-matching junk lands on the same value: `sourdough
 * starter discard crumb` also scored **0.500**. On-topic min and off-topic max met exactly, a
 * gap of 0.000, so no threshold divides them.
 *
 * Coverage is still the right thing to RANK with, which is what it does here. It is not a thing
 * to abstain on, and the reason is arithmetic rather than tuning: the grid is too coarse at the
 * query lengths where the question is hard.
 */
function queryCoverage(item: KnowledgeItem, groups: string[][]): number {
  if (groups.length === 0) return 1;
  // Same class as queryTokenGroups, and it has to be: coverage compares the query's tokens
  // against this set, so an ASCII-split haystack could never contain a non-ASCII query term.
  const haystack = new Set(
    [item.title, item.content, item.reasoning ?? '', (item.tags ?? []).join(' ')]
      .join(' ').toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean),
  );
  const words = [...haystack];
  const covered = groups.filter(group =>
    group.some(term => haystack.has(term) || words.some(word => word.startsWith(term)))).length;
  return covered / groups.length;
}

export type SearchOptions = {
  category?: KnowledgeCategory;
  status?: KnowledgeStatus;
  tags?: string[];
  query: string;
  limit?: number;
  /**
   * Restricts to shared items. Required when the store is a peer: a repo-private row must
   * not be read into this process at all, so this is a SQL predicate and never a filter
   * applied to rows that have already been loaded.
   */
  visibility?: 'repo' | 'workspace';
};

/**
 * One lexical hit and the number FTS5 scored it with.
 *
 * `bm25` is SQLite's raw output: **negative, and more negative is a better match** -- measured,
 * not inferred from `ORDER BY score ASC` (see tests/store/lexical-path.test.ts). It is also
 * corpus-relative to a degree that rules out any absolute threshold: the same single occurrence
 * of a rare term scores -7.95 in a one-word document and -0.64 in a 600-word one, while a term
 * common enough for SQLite to clamp its IDF to 1e-6 scores around -2e-6 for an equally good
 * match. Six orders of magnitude, decided by the corpus rather than by the match.
 *
 * The ranker used to discard this and recount tokens in JavaScript instead. It is returned
 * because it is the length-normalised evidence the recount was a worse copy of.
 */
export type LexicalHit = { item: KnowledgeItem; bm25: number; coverage: number };

/**
 * A SQL predicate that keeps only rows carrying every requested tag.
 *
 * Tags are a JSON array in a text column, and the filter used to run in JavaScript *after* the
 * SQL LIMIT -- so a tagged query spent its whole candidate window on untagged rows and returned
 * nothing, at every limit, while the same query without tags returned a full page. The vector
 * path has always filtered tags before its own cap; this is the half that disagreed.
 *
 * Deliberately a substring test rather than `json_each`: it matches both the current encoding
 * (`["a","b"]`) and the double-encoded legacy rows `unwrapJson` exists to repair, and it needs
 * no JSON1 predicate over a column that may be NULL or malformed. Surrounding quotes make it
 * exact enough that `"a"` cannot match `["ab"]`; the caller still verifies against the parsed
 * array, so this narrows and never decides.
 */
function tagPredicates(tags: string[] | undefined): SQL[] {
  if (!tags || tags.length === 0) return [];
  return tags.map(tag => sql`AND i.tags LIKE ${`%"${tag}"%`}`);
}

/** Exact tag check against the parsed array. The SQL predicate above is a superset of this. */
function hasEveryTag(item: KnowledgeItem, tags: string[] | undefined): boolean {
  if (!tags || tags.length === 0) return true;
  return Boolean(item.tags) && tags.every(tag => item.tags!.includes(tag));
}

export async function searchKnowledgeItems(
  projectId: string,
  options: SearchOptions,
  // Optional and trailing, so every existing call site is unchanged and the whole suite is
  // the regression test. Evaluated at call time, exactly like the getDb() it replaces.
  store: StoreHandle = localStore(),
): Promise<KnowledgeItem[]> {
  return (await searchKnowledgeItemsRanked(projectId, options, store)).map(hit => hit.item);
}

export async function searchKnowledgeItemsRanked(
  projectId: string,
  options: SearchOptions,
  store: StoreHandle = localStore(),
): Promise<LexicalHit[]> {
  const db = store.db;
  const ftsQuery = buildFtsQuery(options.query);
  if (!ftsQuery) return [];

  const status = options.status || 'active';
  const limit = options.limit ?? 20;
  // Every filter is now in SQL, so the only rows the exact tag check can still remove are
  // ones whose tag text contains a quote character. A small over-read absorbs that without
  // reopening the hole: read-then-filter is only a defect when it reads too FEW rows.
  const readLimit = options.tags && options.tags.length > 0 ? limit * 2 + 8 : limit;

  // Joined and filtered above the LIMIT. Filtering afterwards spends the candidate window on
  // rows that can never be returned: a query whose top lexical hits are all archived came
  // back empty even with an active match just past the cap. For a peer it is worse than
  // empty -- a private row would have to be read into this process before being discarded.
  //
  // The FTS table is not aliased, because bm25() takes the table it is measuring by name.
  const rows = await (db as any).all(sql`
    SELECT knowledge_items_fts.item_id AS itemId, bm25(knowledge_items_fts) AS score
    FROM knowledge_items_fts
    JOIN knowledge_items i ON i.id = knowledge_items_fts.item_id
    WHERE knowledge_items_fts MATCH ${ftsQuery}
      AND i.status = ${status}
      ${options.category ? sql`AND i.category = ${options.category}` : sql``}
      ${options.visibility ? sql`AND i.visibility = ${options.visibility}` : sql``}
      ${sql.join(tagPredicates(options.tags), sql` `)}
    ORDER BY score ASC
    LIMIT ${readLimit}
  `) as { itemId: string; score: number }[];

  const ordered: Array<{ itemId: string; score: number }> = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.itemId)) continue;
    seen.add(row.itemId);
    ordered.push(row);
  }

  // One statement for the whole page. Hydrating row by row was 72% of lexical retrieval cost
  // at limit 30 and 17x at limit 100, next to a batch fetch this module's vector sibling was
  // already using. Hydrated from the store the ids came from -- the ambient handle would
  // return nothing for a peer, or an unrelated local row presented as the peer's.
  const items = await getKnowledgeItems(ordered.map(row => row.itemId), store.db);

  const groups = queryTokenGroups(options.query);
  const hits: LexicalHit[] = [];
  for (const row of ordered) {
    const item = items.get(row.itemId);
    if (!item || !hasEveryTag(item, options.tags)) continue;
    hits.push({ item, bm25: row.score, coverage: queryCoverage(item, groups) });
    if (hits.length >= limit) break;
  }

  return hits;
}
