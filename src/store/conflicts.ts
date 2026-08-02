import { and, eq, isNull } from 'drizzle-orm';
import * as schema from './schema.js';
import { mapRowToKnowledgeItem } from './repository.js';
import { localStore, type StoreHandle } from './store-handle.js';
import { getClient } from './database.js';

export function normalizeConflictKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '');
}

export function normalizeConflictScope(scope?: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!scope || Object.keys(scope).length === 0) return null;
  return Object.fromEntries(Object.keys(scope).sort().map(key => [key, scope[key]]));
}

/**
 * Conflict identity in storage shape. EVERY write path must route through this.
 *
 * Create and update used to normalize independently, and update simply forgot: it spread
 * its `updates` object into the row verbatim. A key written raw (`a-b:c` rather than
 * `a.b.c`) stops matching every lookup, which all run on the normalized form — so the row
 * becomes permanently invisible to the conflict check that was supposed to keep it unique
 * and to the reader that was supposed to retire it. Two call sites each having to remember
 * is what made that possible, so there is now one.
 *
 * `undefined` means "leave this column alone" and is preserved as an absent key, so a
 * partial update never clears identity it did not mention.
 */
export function normalizeConflictFields(
  input: { conflictKey?: string | null; conflictScope?: Record<string, unknown> | null },
): { conflictKey?: string | null; conflictScope?: Record<string, unknown> | null } {
  const fields: { conflictKey?: string | null; conflictScope?: Record<string, unknown> | null } = {};
  if (input.conflictKey !== undefined) {
    fields.conflictKey = input.conflictKey ? normalizeConflictKey(input.conflictKey) : null;
  }
  if (input.conflictScope !== undefined) {
    fields.conflictScope = normalizeConflictScope(input.conflictScope);
  }
  return fields;
}

/** True when a stored key is already in storage shape. The doctor invariant. */
export function isNormalizedConflictKey(value: string): boolean {
  return normalizeConflictKey(value) === value;
}

/**
 * Put every stored conflict key back into storage shape.
 *
 * Rows written raw were invisible to the exclusivity check, so the same identity could be
 * claimed more than once. Normalizing them makes those duplicates visible for the first
 * time — so the repair also has to settle them, or it would leave the store asserting two
 * active rows for an identity declared exclusive. Newest wins and the rest are archived,
 * which is the invariant those rows escaped rather than a new policy.
 */
export async function repairUnnormalizedConflictKeys(): Promise<{ repaired: number; archived: number }> {
  const client = getClient();
  const rows = (await client.execute(
    `SELECT id, conflict_key, conflict_scope, conflict_exclusive, status, updated_at
     FROM knowledge_items WHERE conflict_key IS NOT NULL`,
  )).rows;

  const now = new Date().toISOString();
  let repaired = 0;

  for (const row of rows) {
    const stored = String(row.conflict_key);
    const normalized = normalizeConflictKey(stored);
    if (normalized === stored) continue;
    // `updated_at` is deliberately untouched. Repairing a column's spelling is not an edit to
    // what the row says: bumping it would make every repaired row look touched today, which
    // both destroys the recency the duplicate settlement below sorts on and resets the
    // staleness clock that decides when the row can be collected.
    await client.execute({
      sql: 'UPDATE knowledge_items SET conflict_key = ? WHERE id = ?',
      args: [normalized, String(row.id)],
    });
    repaired++;
  }

  if (repaired === 0) return { repaired: 0, archived: 0 };

  // Re-read: identities that were split across raw and normalized spellings are only now
  // comparable, and only the post-repair values say which rows actually collide.
  const settled = (await client.execute(
    `SELECT id, conflict_key, conflict_scope, updated_at FROM knowledge_items
     WHERE conflict_key IS NOT NULL AND conflict_exclusive = 1 AND status = 'active'
     ORDER BY updated_at DESC`,
  )).rows;

  const seen = new Set<string>();
  let archived = 0;
  for (const row of settled) {
    const identity = `${String(row.conflict_key)}\0${row.conflict_scope === null ? '' : String(row.conflict_scope)}`;
    if (!seen.has(identity)) { seen.add(identity); continue; }
    await client.execute({
      sql: `UPDATE knowledge_items SET status = 'archived', freshness = 'stale', updated_at = ? WHERE id = ?`,
      args: [now, String(row.id)],
    });
    archived++;
  }

  return { repaired, archived };
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
