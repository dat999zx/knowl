import { sql } from 'drizzle-orm';
import { getKnowledgeItem } from './repository.js';
import { localStore, type StoreHandle } from './store-handle.js';
import { KnowledgeCategory, KnowledgeItem, KnowledgeStatus } from '../core/types.js';

const SEARCH_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'does', 'for', 'from', 'how', 'in',
  'is', 'it', 'of', 'on', 'or', 'our', 'the', 'this', 'to', 'use', 'uses', 'using', 'what',
  'when', 'where', 'which', 'who', 'why', 'with',
]);

const SEARCH_SYNONYMS: Record<string, string[]> = {
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
};

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
  },
  // Optional and trailing, so every existing call site is unchanged and the whole suite is
  // the regression test. Evaluated at call time, exactly like the getDb() it replaces.
  store: StoreHandle = localStore(),
): Promise<KnowledgeItem[]> {
  const db = store.db;
  const ftsQuery = buildFtsQuery(options.query);
  if (!ftsQuery) return [];

  const rows = await (db as any).all(sql`
    SELECT item_id AS itemId, bm25(knowledge_items_fts) AS score
    FROM knowledge_items_fts
    WHERE knowledge_items_fts MATCH ${ftsQuery}
    ORDER BY score ASC
    LIMIT ${options.limit ?? 20}
  `) as { itemId: string; score: number }[];

  const status = options.status || 'active';
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
    if (item.status !== status) continue;
    if (options.category && item.category !== options.category) continue;
    if (options.tags && options.tags.length > 0) {
      if (!item.tags || !options.tags.every(tag => item.tags!.includes(tag))) continue;
    }

    items.push(item);
    if (items.length >= (options.limit ?? 20)) break;
  }

  return items;
}
