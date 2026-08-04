import { sql } from 'drizzle-orm';
import { KnowledgeWriteValidationOptions } from '../core/types.js';
import { KnowledgeValidationError, validateKnowledgeWrite } from '../core/knowledge-validation.js';
import { getDb } from './database.js';
import { isNormalizedConflictKey, normalizeConflictKey } from './conflicts.js';
import { supersedeKnowledgeItem } from './repository.js';

export type IntegrityFinding = {
  code: 'secret' | 'dangling-reference' | 'missing-index-row' | 'invalid-json' | 'invalid-status'
    | 'raw-conflict-key' | 'duplicate-conflict-identity' | 'missing-assertion';
  severity: 'error' | 'warning';
  itemId?: string;
  detail: string;
  /** Present only on a repairing audit, so a report-only run stays exactly as it was. */
  repaired?: boolean;
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

/**
 * Conflict identities stored raw, and the duplicates that repairing them exposes.
 *
 * A key written through the update path used to bypass normalization, so one logical identity
 * could sit raw in one row and normalized in another and never collide. Normalizing is what
 * makes the collision visible -- which is why the repair has to settle it in the same pass,
 * or it hands back a database with two active rows claiming one exclusive identity.
 */
async function auditConflictIdentities(db: any, repair: boolean): Promise<IntegrityFinding[]> {
  const findings: IntegrityFinding[] = [];

  const stored = await db.all(sql`SELECT id, conflict_key FROM knowledge_items WHERE conflict_key IS NOT NULL`);
  for (const row of stored) {
    const key = String(row.conflict_key);
    if (isNormalizedConflictKey(key)) continue;
    const normalized = normalizeConflictKey(key);
    if (repair) {
      await db.run(sql`UPDATE knowledge_items SET conflict_key = ${normalized} WHERE id = ${row.id}`);
      // The assertion history is what conflict auditing and knowl_timeline read back, so
      // leaving it raw would keep the divergence alive in the record of what was claimed.
      await db.run(sql`UPDATE knowledge_assertions SET conflict_key = ${normalized} WHERE knowledge_item_id = ${row.id} AND conflict_key = ${key}`);
    }
    findings.push({
      code: 'raw-conflict-key',
      severity: 'warning',
      itemId: String(row.id),
      detail: repair
        ? `Conflict key "${key}" was stored raw and has been normalized to "${normalized}".`
        : `Conflict key "${key}" is stored raw, so it cannot collide with the same identity stored normally.`,
      repaired: repair,
    });
  }

  const active = await db.all(sql`
    SELECT id, conflict_key, conflict_scope, updated_at FROM knowledge_items
    WHERE status = 'active' AND conflict_exclusive = 1 AND conflict_key IS NOT NULL
  `);
  const groups = new Map<string, Array<{ id: string; updatedAt: string }>>();
  for (const row of active) {
    const identity = `${row.conflict_key} / ${row.conflict_scope ?? 'no scope'}`;
    const bucket = groups.get(identity) ?? [];
    bucket.push({ id: String(row.id), updatedAt: String(row.updated_at ?? '') });
    groups.set(identity, bucket);
  }
  for (const [identity, bucket] of groups) {
    if (bucket.length < 2) continue;
    // The newest row wins and the rest are superseded into it -- the direction every other
    // replacement in this store runs. Ties break on id so a repair is deterministic.
    const [winner, ...losers] = [...bucket]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    for (const loser of losers) {
      if (repair) await supersedeKnowledgeItem(loser.id, winner.id);
      findings.push({
        code: 'duplicate-conflict-identity',
        // A warning, not an error, because `restoreSnapshot` refuses any snapshot whose audit
        // reports an error. These duplicates exist precisely because of the bug fixed here, so
        // treating them as fatal would make a user's existing backups unrestorable over data
        // this same audit can repair in place.
        severity: 'warning',
        itemId: loser.id,
        detail: repair
          ? `Superseded by ${winner.id}; both claimed the exclusive identity ${identity}.`
          : `Shares the exclusive identity ${identity} with ${winner.id}.`,
        repaired: repair,
      });
    }
  }

  return findings;
}

export async function auditKnowledgeStore(
  validationOptions?: KnowledgeWriteValidationOptions,
  options: { repair?: boolean } = {},
): Promise<IntegrityReport> {
  const db = getDb() as any;
  const findings: IntegrityFinding[] = [];
  const rows = await db.all(sql`SELECT id, title, content, reasoning, source, alternatives, tags, affected_paths, status FROM knowledge_items`);

  for (const row of rows) {
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

  // An item with no open assertion is not a cosmetic gap: `updateKnowledgeItemWithCommit`
  // refuses every content edit on one, so the item is readable and permanently unwritable.
  // This check exists because a snapshot restore used to produce exactly that state across
  // the whole store and then pass its own audit -- the audit only looked for dangling
  // children, and an item whose history was cascaded away has no children to dangle.
  const withoutAssertion = await db.all(sql`
    SELECT id FROM knowledge_items
    WHERE NOT EXISTS (
      SELECT 1 FROM knowledge_assertions
      WHERE knowledge_item_id = knowledge_items.id AND valid_to IS NULL
    )
    LIMIT 50
  `);
  for (const row of withoutAssertion) {
    findings.push({
      code: 'missing-assertion',
      severity: 'error',
      itemId: String(row.id),
      detail: 'Knowledge item has no open assertion, so every content update on it will fail.',
    });
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

  findings.push(...await auditConflictIdentities(db, options.repair === true));

  return { findings };
}
