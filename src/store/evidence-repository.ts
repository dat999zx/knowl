import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Evidence, EvidenceInput, EvidenceRelationship, EvidenceType, KnowledgeEvidence, KnowledgeItem } from '../core/types.js';
import { validateKnowledgeWrite } from '../core/knowledge-validation.js';
import { getClient } from './database.js';
import { getKnowledgeItem } from './repository.js';
import { containedRepoPath, normalizeLocator as normalizeReadSetLocator } from './read-set.js';

const MAX_EXCERPT_LENGTH = 2_000;

export type SymbolEvidenceResolution = {
  stale: boolean;
  suggestedLocator?: string;
};

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

/**
 * Canonical locator form, which is per type rather than global.
 *
 * - **`file` — a bare repo-relative path.** `isEvidenceStale` hands it straight to
 *   `path.resolve(projectRoot, ...)`, so a `file://` prefix would resolve to `<root>/file:/...`,
 *   which cannot exist, and every file evidence row would report stale permanently.
 * - **`symbol` — keeps its `symbol://path#name` scheme.** That string is `code_symbols.locator`,
 *   the primary key `resolveSymbolEvidence` looks up; stripped of the scheme it matches no row
 *   and every symbol evidence falls through to the rename path or straight to stale.
 * - **Everything else — an opaque identifier, left alone.** A commit SHA, an agent name. None of
 *   them reach the filesystem in `isEvidenceStale`, and running a path validator over a SHA would
 *   reject data that is perfectly valid.
 *
 * `file` and `symbol` are also the only two types whose locator can escape the project root, and
 * a locator that names a file outside the repository is not a locator -- so it is refused here
 * rather than stored and resolved later. `isEvidenceStale` checks containment a second time at
 * the point of use, because rows also arrive from `cloud/sync-apply.ts` and `store/portability.ts`
 * without passing through this function at all.
 */
function normalizeEvidenceLocator(type: EvidenceType, locator: string): string {
  const trimmed = (locator ?? '').trim().replace(/\\/g, '/');

  if (type === 'symbol') {
    const normalized = normalizeReadSetLocator(trimmed.startsWith('symbol://') ? trimmed : `symbol://${trimmed}`);
    if (normalized === null) {
      throw new Error(`Invalid symbol evidence locator, expected symbol://<repo-relative path>#<name>: ${locator}`);
    }
    return normalized;
  }

  if (type === 'file') {
    const bare = trimmed.startsWith('file://') ? trimmed.slice('file://'.length) : trimmed;
    const contained = containedRepoPath(bare);
    if (contained === null) {
      throw new Error(`Invalid file evidence locator, expected a repo-relative path inside the project: ${locator}`);
    }
    return contained;
  }

  return trimmed;
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

function parseSymbolLocator(locator: string): { filePath: string; qualifiedName: string } | null {
  const match = /^symbol:\/\/(.+)#([^#]+)$/.exec(locator);
  return match ? { filePath: match[1], qualifiedName: match[2] } : null;
}

function normalizedName(value: string): string {
  return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function nameSimilarity(left: string, right: string): number {
  const a = normalizedName(left);
  const b = normalizedName(right);
  if (!a || !b) return 0;
  const row = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const next = row[j];
      row[j] = a[i - 1] === b[j - 1] ? previous + 1 : Math.max(row[j], row[j - 1]);
      previous = next;
    }
  }
  return row[b.length] / Math.max(a.length, b.length);
}

/**
 * Record one piece of evidence, normalizing its locator to the canonical form for its type.
 *
 * **The canonical form is per type, and the `file` case is a bare repo-relative path** --
 * `src/store/read-set.ts`, never `file://src/store/read-set.ts`. That is what every row in the
 * table already holds and the only form `isEvidenceStale` can resolve, since it passes the
 * locator to `path.resolve` unchanged. `symbol` keeps its `symbol://path#name` scheme because
 * that string is `code_symbols.locator`; every other type is an opaque identifier and is stored
 * as given. See `normalizeEvidenceLocator`.
 *
 * **Throws on a `file` or `symbol` locator that escapes the project root**, rather than storing
 * a row that cites a file the repository does not contain.
 */
export async function createEvidence(input: Omit<Evidence, 'id'>): Promise<Evidence> {
  const client = getClient();
  const locator = normalizeEvidenceLocator(input.type, input.locator);
  // Both columns are nullable and both inputs are optional, so absent becomes null once,
  // here, rather than at each of the three places that go on to use it. The driver binds
  // null; undefined it refuses outright.
  const contentHash = input.contentHash ?? null;
  const excerpt = input.excerpt ? input.excerpt.slice(0, MAX_EXCERPT_LENGTH) : null;
  const metadata = input.metadata ? JSON.stringify(input.metadata) : null;
  validateKnowledgeWrite({ content: excerpt, reasoning: metadata });

  const existing = await client.execute({
    sql: 'SELECT * FROM evidence WHERE type = ? AND locator = ? AND content_hash IS ? LIMIT 1',
    args: [input.type, locator, contentHash],
  });
  if (existing.rows[0]) return mapEvidence(existing.rows[0]);

  const evidence: Evidence = {
    id: generateId(), type: input.type, locator, contentHash,
    excerpt, observedAt: input.observedAt, metadata: input.metadata ?? null,
  };
  await client.execute({
    sql: 'INSERT INTO evidence (id, type, locator, content_hash, excerpt, observed_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)',
    args: [evidence.id, evidence.type, evidence.locator, contentHash, excerpt, evidence.observedAt, metadata],
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

export async function resolveSymbolEvidence(evidence: Evidence): Promise<SymbolEvidenceResolution> {
  const exact = await getClient().execute({
    sql: 'SELECT signature_hash FROM code_symbols WHERE locator = ?',
    args: [evidence.locator],
  });
  if (exact.rows[0]) {
    return { stale: Boolean(evidence.contentHash && String(exact.rows[0].signature_hash ?? '') !== evidence.contentHash) };
  }

  const original = parseSymbolLocator(evidence.locator);
  const symbolKind = typeof evidence.metadata?.symbolKind === 'string' ? evidence.metadata.symbolKind : null;
  if (!original || !symbolKind) return { stale: true };

  const candidates = await getClient().execute({
    sql: 'SELECT locator, qualified_name FROM code_symbols WHERE file_path = ? AND kind = ?',
    args: [original.filePath, symbolKind],
  });
  const plausible = candidates.rows
    .map(row => ({ locator: String(row.locator), score: nameSimilarity(original.qualifiedName, String(row.qualified_name)) }))
    .filter(candidate => candidate.score >= 0.6);

  return plausible.length === 1 ? { stale: true, suggestedLocator: plausible[0].locator } : { stale: true };
}

export async function isEvidenceStale(evidence: Evidence, projectRoot: string): Promise<boolean> {
  if (evidence.type === 'symbol') {
    return (await resolveSymbolEvidence(evidence)).stale;
  }
  if (evidence.type !== 'file' || !evidence.contentHash) return false;
  // Checked here as well as on write, because `createEvidence` is not the only writer:
  // `cloud/sync-apply.ts` upserts locator and content_hash verbatim from a sync payload and
  // `store/portability.ts` inserts on import, neither passing through any normalizer. Refusing
  // outright rather than resolving and letting `readFile` fail keeps the answer independent of
  // anything outside the root -- a locator that escapes reveals nothing about the file it names.
  if (containedRepoPath(evidence.locator) === null) return true;
  try {
    const content = await fs.readFile(path.resolve(projectRoot, evidence.locator));
    return crypto.createHash('sha256').update(content).digest('hex') !== evidence.contentHash;
  } catch {
    return true;
  }
}
