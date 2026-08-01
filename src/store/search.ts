import { sql } from 'drizzle-orm';
import { getKnowledgeItem } from './repository.js';
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

function tokenizeSearchQuery(query: string): string[] {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map(token => token.trim())
    .filter(token => token.length >= 2 && !SEARCH_STOP_WORDS.has(token));

  const expanded = new Set<string>();
  for (const token of tokens) {
    expanded.add(token);
    for (const synonym of SEARCH_SYNONYMS[token] || []) {
      expanded.add(synonym);
    }
  }

  return [...expanded];
}

function buildFtsQuery(query: string): string | null {
  const tokens = tokenizeSearchQuery(query);
  if (tokens.length === 0) return null;
  return tokens.map(token => `${token}*`).join(' OR ');
}

export async function searchKnowledgeItems(
  projectId: string,
  options: {
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
  },
  // Optional and trailing, so every existing call site is unchanged and the whole suite is
  // the regression test. Evaluated at call time, exactly like the getDb() it replaces.
  store: StoreHandle = localStore(),
): Promise<KnowledgeItem[]> {
  const db = store.db;
  const ftsQuery = buildFtsQuery(options.query);
  if (!ftsQuery) return [];

  const status = options.status || 'active';

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
    ORDER BY score ASC
    LIMIT ${options.limit ?? 20}
  `) as { itemId: string; score: number }[];

  const items: KnowledgeItem[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (seen.has(row.itemId)) continue;
    seen.add(row.itemId);

    // Hydrated from the same database the ids came from. Loading them from the ambient
    // handle instead would silently return nothing for a peer -- or, on an id collision, an
    // unrelated local row presented as the peer's.
    const item = await getKnowledgeItem(row.itemId, store.db);
    if (!item) continue;
    // Status, category and visibility are already applied in SQL. Only the JSON-array tag
    // filter remains here, and it narrows an already-correct candidate set rather than
    // deciding whether a row may be seen at all.
    if (options.tags && options.tags.length > 0) {
      if (!item.tags || !options.tags.every(tag => item.tags!.includes(tag))) continue;
    }

    items.push(item);
    if (items.length >= (options.limit ?? 20)) break;
  }

  return items;
}
