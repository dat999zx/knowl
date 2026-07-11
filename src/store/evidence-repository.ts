import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Evidence, EvidenceInput, EvidenceRelationship, EvidenceType, KnowledgeEvidence, KnowledgeItem } from '../core/types.js';
import { validateKnowledgeWrite } from '../core/knowledge-validation.js';
import { getClient } from './database.js';
import { getKnowledgeItem } from './repository.js';

const MAX_EXCERPT_LENGTH = 2_000;

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

function normalizeLocator(locator: string): string {
  return locator.trim().replace(/\\/g, '/');
}

function parseMetadata(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'object') return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mapEvidence(row: any): Evidence {
  return {
    id: String(row.id),
    type: row.type as EvidenceType,
    locator: String(row.locator),
    contentHash: row.content_hash ? String(row.content_hash) : null,
    excerpt: row.excerpt ? String(row.excerpt) : null,
    observedAt: String(row.observed_at),
    metadata: parseMetadata(row.metadata),
  };
}

export async function createEvidence(input: Omit<Evidence, 'id'>): Promise<Evidence> {
  const client = getClient();
  const locator = normalizeLocator(input.locator);
  const excerpt = input.excerpt ? input.excerpt.slice(0, MAX_EXCERPT_LENGTH) : null;
  const metadata = input.metadata ? JSON.stringify(input.metadata) : null;
  validateKnowledgeWrite({ content: excerpt, reasoning: metadata });

  const existing = await client.execute({
    sql: 'SELECT * FROM evidence WHERE type = ? AND locator = ? AND content_hash IS ? LIMIT 1',
    args: [input.type, locator, input.contentHash ?? null],
  });
  if (existing.rows[0]) return mapEvidence(existing.rows[0]);

  const evidence: Evidence = {
    id: generateId(), type: input.type, locator, contentHash: input.contentHash ?? null,
    excerpt, observedAt: input.observedAt, metadata: input.metadata ?? null,
  };
  await client.execute({
    sql: 'INSERT INTO evidence (id, type, locator, content_hash, excerpt, observed_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)',
    args: [evidence.id, evidence.type, evidence.locator, evidence.contentHash, evidence.excerpt, evidence.observedAt, metadata],
  });
  return evidence;
}

export async function linkKnowledgeEvidence(input: KnowledgeEvidence): Promise<void> {
  await getClient().execute({
    sql: 'INSERT OR REPLACE INTO knowledge_evidence (knowledge_item_id, evidence_id, relationship) VALUES (?, ?, ?)',
    args: [input.knowledgeItemId, input.evidenceId, input.relationship],
  });
}

export async function listEvidenceForItem(itemId: string): Promise<Array<Evidence & { relationship: EvidenceRelationship }>> {
  const result = await getClient().execute({
    sql: `SELECT e.*, ke.relationship FROM evidence e JOIN knowledge_evidence ke ON ke.evidence_id = e.id WHERE ke.knowledge_item_id = ? ORDER BY e.observed_at DESC, e.id`,
    args: [itemId],
  });
  return result.rows.map(row => ({ ...mapEvidence(row), relationship: row.relationship as EvidenceRelationship }));
}

export async function listItemsForEvidence(evidenceId: string): Promise<Array<KnowledgeItem & { relationship: EvidenceRelationship }>> {
  const links = await getClient().execute({
    sql: 'SELECT knowledge_item_id, relationship FROM knowledge_evidence WHERE evidence_id = ?', args: [evidenceId],
  });
  const result: Array<KnowledgeItem & { relationship: EvidenceRelationship }> = [];
  for (const link of links.rows) {
    const item = await getKnowledgeItem(String(link.knowledge_item_id));
    if (item) result.push({ ...item, relationship: link.relationship as EvidenceRelationship });
  }
  return result;
}

export async function unlinkKnowledgeEvidence(itemId: string, evidenceId: string): Promise<void> {
  await getClient().execute({
    sql: 'DELETE FROM knowledge_evidence WHERE knowledge_item_id = ? AND evidence_id = ?', args: [itemId, evidenceId],
  });
}

export async function attachEvidenceToKnowledge(
  itemId: string,
  explicit: EvidenceInput[] | undefined,
  compatibility?: { sourceCommit?: string | null; affectedPaths?: string[] | null },
): Promise<void> {
  const inputs = explicit?.length ? explicit : [
    ...(compatibility?.sourceCommit ? [{ type: 'commit' as const, locator: compatibility.sourceCommit, observedAt: new Date().toISOString(), relationship: 'derived_from' as const }] : []),
    ...((compatibility?.affectedPaths || []).map(locator => ({ type: 'file' as const, locator, observedAt: new Date().toISOString(), relationship: 'supports' as const }))),
  ];
  for (const input of inputs) {
    const { relationship = 'supports', ...evidenceInput } = input;
    const evidence = await createEvidence(evidenceInput);
    await linkKnowledgeEvidence({ knowledgeItemId: itemId, evidenceId: evidence.id, relationship });
  }
}

export async function isEvidenceStale(evidence: Evidence, projectRoot: string): Promise<boolean> {
  if (evidence.type !== 'file' || !evidence.contentHash) return false;
  try {
    const content = await fs.readFile(path.resolve(projectRoot, evidence.locator));
    return crypto.createHash('sha256').update(content).digest('hex') !== evidence.contentHash;
  } catch {
    return true;
  }
}
