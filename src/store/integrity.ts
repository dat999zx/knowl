import { sql } from 'drizzle-orm';
import { KnowledgeWriteValidationOptions } from '../core/types.js';
import { KnowledgeValidationError, validateKnowledgeWrite } from '../core/knowledge-validation.js';
import { getDb } from './database.js';
import { isNormalizedConflictKey, normalizeConflictKey } from './conflicts.js';

export type IntegrityFinding = {
  code: 'secret' | 'dangling-reference' | 'missing-index-row' | 'invalid-json' | 'invalid-status' | 'unnormalized-conflict-key';
  severity: 'error' | 'warning';
  itemId?: string;
  detail: string;
};

export type IntegrityReport = { findings: IntegrityFinding[] };

const VALID_STATUSES = new Set(['active', 'deprecated', 'rejected', 'archived', 'superseded']);

function parseStringArray(value: unknown): string[] | null | undefined {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value) && value.every(entry => typeof entry === 'string')) return value;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every(entry => typeof entry === 'string') ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function auditKnowledgeStore(
  validationOptions?: KnowledgeWriteValidationOptions,
): Promise<IntegrityReport> {
  const db = getDb() as any;
  const findings: IntegrityFinding[] = [];
  const rows = await db.all(sql`SELECT id, title, content, reasoning, source, alternatives, tags, affected_paths, status, conflict_key FROM knowledge_items`);

  for (const row of rows) {
    // Every lookup matches on the normalized form, so a key that is not already in that
    // form matches nothing — the row is unreachable by the conflict check meant to keep it
    // unique and by the reader meant to retire it. Cheap to assert, and it is the invariant
    // that would have caught the update path writing keys raw.
    if (row.conflict_key !== null && row.conflict_key !== undefined && !isNormalizedConflictKey(String(row.conflict_key))) {
      findings.push({
        code: 'unnormalized-conflict-key',
        severity: 'error',
        itemId: String(row.id),
        detail: `Conflict key "${row.conflict_key}" is not in storage shape (expected "${normalizeConflictKey(String(row.conflict_key))}"); the row is invisible to every conflict lookup.`,
      });
    }

    const alternatives = parseStringArray(row.alternatives);
    const tags = parseStringArray(row.tags);
    const affectedPaths = parseStringArray(row.affected_paths);
    if (alternatives === undefined || tags === undefined || affectedPaths === undefined) {
      findings.push({ code: 'invalid-json', severity: 'error', itemId: String(row.id), detail: 'Knowledge item has an invalid JSON array field.' });
    }
    if (!VALID_STATUSES.has(String(row.status))) {
      findings.push({ code: 'invalid-status', severity: 'error', itemId: String(row.id), detail: 'Knowledge item has an invalid status.' });
    }
    try {
      validateKnowledgeWrite({
        title: row.title,
        content: row.content,
        reasoning: row.reasoning,
        source: row.source,
        affectedPaths: affectedPaths ?? undefined,
      }, validationOptions);
    } catch (error) {
      if (error instanceof KnowledgeValidationError) {
        findings.push({ code: 'secret', severity: 'error', itemId: String(row.id), detail: `Knowledge validation failed: ${error.code}.` });
      } else {
        throw error;
      }
    }
  }

  const missingFts = await db.all(sql`
    SELECT id FROM knowledge_items
    WHERE NOT EXISTS (SELECT 1 FROM knowledge_items_fts WHERE item_id = knowledge_items.id)
  `);
  for (const row of missingFts) {
    findings.push({ code: 'missing-index-row', severity: 'warning', itemId: String(row.id), detail: 'Knowledge item is missing its FTS index row.' });
  }

  const dangling = await db.all(sql`
    SELECT knowledge_item_id FROM skill_steps
    WHERE NOT EXISTS (SELECT 1 FROM knowledge_items WHERE id = skill_steps.knowledge_item_id)
    UNION ALL
    SELECT knowledge_item_id FROM skill_metadata
    WHERE NOT EXISTS (SELECT 1 FROM knowledge_items WHERE id = skill_metadata.knowledge_item_id)
    UNION ALL
    SELECT knowledge_item_id FROM knowledge_embeddings
    WHERE NOT EXISTS (SELECT 1 FROM knowledge_items WHERE id = knowledge_embeddings.knowledge_item_id)
  `);
  for (const row of dangling) {
    findings.push({ code: 'dangling-reference', severity: 'error', itemId: String(row.knowledge_item_id), detail: 'A dependent knowledge record references a missing item.' });
  }

  return { findings };
}
