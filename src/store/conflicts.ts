import { and, eq } from 'drizzle-orm';
import { getDb } from './database.js';
import * as schema from './schema.js';
import { mapRowToKnowledgeItem } from './repository.js';

export function normalizeConflictKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '');
}

export function normalizeConflictScope(scope?: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!scope || Object.keys(scope).length === 0) return null;
  return Object.fromEntries(Object.keys(scope).sort().map(key => [key, scope[key]]));
}

export async function checkKnowledgeConflict(input: { conflictKey?: string | null; conflictScope?: Record<string, unknown> | null; conflictExclusive?: boolean }) {
  if (!input.conflictExclusive || !input.conflictKey) return [];
  const key = normalizeConflictKey(input.conflictKey);
  const scope = normalizeConflictScope(input.conflictScope);
  const rows = await getDb().select().from(schema.knowledgeItems).where(and(eq(schema.knowledgeItems.status, 'active'), eq(schema.knowledgeItems.conflictExclusive, true), eq(schema.knowledgeItems.conflictKey, key), eq(schema.knowledgeItems.conflictScope, scope)));
  return rows.map(mapRowToKnowledgeItem);
}

export async function listActiveConflictKeys() {
  const rows = await getDb().select().from(schema.knowledgeItems).where(and(eq(schema.knowledgeItems.status, 'active'), eq(schema.knowledgeItems.conflictExclusive, true)));
  return rows.map(mapRowToKnowledgeItem);
}
