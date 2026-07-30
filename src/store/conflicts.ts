import { and, eq, isNull } from 'drizzle-orm';
import * as schema from './schema.js';
import { mapRowToKnowledgeItem } from './repository.js';
import { localStore, type StoreHandle } from './store-handle.js';

export function normalizeConflictKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '');
}

export function normalizeConflictScope(scope?: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!scope || Object.keys(scope).length === 0) return null;
  return Object.fromEntries(Object.keys(scope).sort().map(key => [key, scope[key]]));
}

export async function checkKnowledgeConflict(
  input: {
    conflictKey?: string | null;
    conflictScope?: Record<string, unknown> | null;
    conflictExclusive?: boolean;
    /**
     * Restricts to shared items. Required when the store is a peer: a repo-private row must
     * not be read into this process, so this is a SQL predicate and never a filter applied
     * to rows that have already been loaded.
     */
    visibility?: 'repo' | 'workspace';
  },
  store: StoreHandle = localStore(),
) {
  if (!input.conflictExclusive || !input.conflictKey) return [];
  const key = normalizeConflictKey(input.conflictKey);
  const scope = normalizeConflictScope(input.conflictScope);
  const rows = await store.db.select().from(schema.knowledgeItems).where(and(
    eq(schema.knowledgeItems.status, 'active'),
    eq(schema.knowledgeItems.conflictExclusive, true),
    eq(schema.knowledgeItems.conflictKey, key),
    // `eq(column, null)` renders `conflict_scope = NULL`, and nothing equals NULL in SQL --
    // so a scopeless exclusive key matched nothing and guarded nothing. Every earlier test
    // supplied a scope, which is why it went unnoticed.
    scope === null ? isNull(schema.knowledgeItems.conflictScope) : eq(schema.knowledgeItems.conflictScope, scope),
    ...(input.visibility ? [eq(schema.knowledgeItems.visibility, input.visibility)] : []),
  ));
  return rows.map(mapRowToKnowledgeItem);
}

export async function listActiveConflictKeys(store: StoreHandle = localStore()) {
  const rows = await store.db.select().from(schema.knowledgeItems).where(and(eq(schema.knowledgeItems.status, 'active'), eq(schema.knowledgeItems.conflictExclusive, true)));
  return rows.map(mapRowToKnowledgeItem);
}
