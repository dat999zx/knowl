import crypto from 'node:crypto';
import { and, desc, eq, gte, isNull, lte, or } from 'drizzle-orm';
import { KnowledgeAssertion } from '../core/types.js';
import { getDb, withClientTransaction } from './database.js';
import * as schema from './schema.js';

const id = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);
const map = (row: typeof schema.knowledgeAssertions.$inferSelect): KnowledgeAssertion => ({
  id: row.id, knowledgeItemId: row.knowledgeItemId, content: row.content, validFrom: row.validFrom,
  validTo: row.validTo, recordedAt: row.recordedAt, replacedAt: row.replacedAt,
  confidence: row.confidence, sourceEvidenceId: row.sourceEvidenceId,
});

export async function createCurrentAssertion(input: { knowledgeItemId: string; content: string; confidence: number; sourceEvidenceId?: string | null }) {
  const db = getDb();
  const existing = await db.select().from(schema.knowledgeAssertions).where(and(eq(schema.knowledgeAssertions.knowledgeItemId, input.knowledgeItemId), isNull(schema.knowledgeAssertions.validTo))).limit(1);
  if (existing[0]) throw new Error('Knowledge item already has an open assertion.');
  const now = new Date().toISOString();
  const assertion = { id: id(), ...input, validFrom: now, validTo: null, recordedAt: now, replacedAt: null, sourceEvidenceId: input.sourceEvidenceId ?? null };
  await db.insert(schema.knowledgeAssertions).values(assertion);
  return assertion as KnowledgeAssertion;
}

export async function replaceCurrentAssertion(input: { knowledgeItemId: string; content: string; confidence: number; sourceEvidenceId?: string | null }) {
  // Client-level, not db.transaction: see withClientTransaction for the measurement.
  return withClientTransaction(async tx => {
    const current = await tx.select().from(schema.knowledgeAssertions).where(and(eq(schema.knowledgeAssertions.knowledgeItemId, input.knowledgeItemId), isNull(schema.knowledgeAssertions.validTo))).limit(1);
    if (!current[0]) throw new Error('Knowledge item has no open assertion.');
    const now = new Date().toISOString();
    await tx.update(schema.knowledgeAssertions).set({ validTo: now, replacedAt: now }).where(eq(schema.knowledgeAssertions.id, current[0].id));
    const assertion = { id: id(), ...input, validFrom: now, validTo: null, recordedAt: now, replacedAt: null, sourceEvidenceId: input.sourceEvidenceId ?? null };
    await tx.insert(schema.knowledgeAssertions).values(assertion);
    return assertion as KnowledgeAssertion;
  });
}

export async function listAssertions(knowledgeItemId: string): Promise<KnowledgeAssertion[]> {
  const rows = await getDb().select().from(schema.knowledgeAssertions).where(eq(schema.knowledgeAssertions.knowledgeItemId, knowledgeItemId)).orderBy(desc(schema.knowledgeAssertions.recordedAt));
  return rows.map(map);
}

export async function findAssertionAsOf(knowledgeItemId: string, asOf: string): Promise<KnowledgeAssertion | null> {
  const rows = await getDb().select().from(schema.knowledgeAssertions).where(and(
    eq(schema.knowledgeAssertions.knowledgeItemId, knowledgeItemId),
    lte(schema.knowledgeAssertions.validFrom, asOf),
    or(isNull(schema.knowledgeAssertions.validTo), gte(schema.knowledgeAssertions.validTo, asOf)),
  )).orderBy(desc(schema.knowledgeAssertions.recordedAt)).limit(1);
  return rows[0] ? map(rows[0]) : null;
}
