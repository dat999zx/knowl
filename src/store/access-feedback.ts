import crypto from 'node:crypto';
import { getClient } from './database.js';

export type KnowledgeAccessInput = {
  itemId: string;
  query?: string;
  surface: string;
  rank: number;
  retrievedAt?: string;
  used?: boolean;
  useful?: boolean;
  causedCorrection?: boolean;
};

export type KnowledgeAccess = Omit<KnowledgeAccessInput, 'query'> & {
  id: string;
  queryFingerprint: string | null;
};

export type KnowledgeAccessReportItem = {
  itemId: string;
  title: string;
  freshness: string;
  retrievalCount: number;
  usefulCount: number;
  causedCorrectionCount: number;
};

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

function fingerprint(query?: string): string | null {
  return query ? crypto.createHash('sha256').update(query).digest('hex') : null;
}

function mapAccess(row: any): KnowledgeAccess {
  return {
    id: String(row.id),
    itemId: String(row.knowledge_item_id),
    queryFingerprint: row.query_fingerprint ? String(row.query_fingerprint) : null,
    retrievedAt: String(row.retrieved_at),
    surface: String(row.surface),
    rank: Number(row.rank),
    used: row.used === null ? undefined : Boolean(row.used),
    useful: row.useful === null ? undefined : Boolean(row.useful),
    causedCorrection: row.caused_correction === null ? undefined : Boolean(row.caused_correction),
  };
}

export async function recordKnowledgeAccess(input: KnowledgeAccessInput): Promise<KnowledgeAccess> {
  const access: KnowledgeAccess = {
    id: generateId(),
    itemId: input.itemId,
    queryFingerprint: fingerprint(input.query),
    retrievedAt: input.retrievedAt ?? new Date().toISOString(),
    surface: input.surface,
    rank: input.rank,
    used: input.used,
    useful: input.useful,
    causedCorrection: input.causedCorrection,
  };
  await getClient().execute({
    sql: `INSERT INTO knowledge_access (
      id, knowledge_item_id, query_fingerprint, retrieved_at, surface, rank, used, useful, caused_correction
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      access.id, access.itemId, access.queryFingerprint, access.retrievedAt, access.surface, access.rank,
      access.used === undefined ? null : Number(access.used),
      access.useful === undefined ? null : Number(access.useful),
      access.causedCorrection === undefined ? null : Number(access.causedCorrection),
    ],
  });
  return access;
}

export async function recordKnowledgeAccessBestEffort(input: KnowledgeAccessInput): Promise<void> {
  try {
    await recordKnowledgeAccess(input);
  } catch {
    // Telemetry must not alter retrieval behavior.
  }
}

export async function recordKnowledgeFeedback(input: Omit<KnowledgeAccessInput, 'query' | 'surface' | 'rank'>): Promise<KnowledgeAccess> {
  return recordKnowledgeAccess({ ...input, surface: 'feedback', rank: 0 });
}

export async function listKnowledgeAccess(itemId: string): Promise<KnowledgeAccess[]> {
  const result = await getClient().execute({
    sql: 'SELECT * FROM knowledge_access WHERE knowledge_item_id = ? ORDER BY retrieved_at ASC, id ASC',
    args: [itemId],
  });
  return result.rows.map(mapAccess);
}

function mapReportItem(row: any): KnowledgeAccessReportItem {
  return {
    itemId: String(row.item_id), title: String(row.title), freshness: String(row.freshness),
    retrievalCount: Number(row.retrieval_count), usefulCount: Number(row.useful_count),
    causedCorrectionCount: Number(row.caused_correction_count),
  };
}

export async function getKnowledgeAccessReport(): Promise<{
  highValue: KnowledgeAccessReportItem[];
  staleFrequentlyRetrieved: KnowledgeAccessReportItem[];
  repeatedlyCorrected: KnowledgeAccessReportItem[];
}> {
  const result = await getClient().execute(`
    SELECT ki.id AS item_id, ki.title, ki.freshness,
      SUM(CASE WHEN ka.surface != 'feedback' THEN 1 ELSE 0 END) AS retrieval_count,
      SUM(CASE WHEN ka.useful = 1 THEN 1 ELSE 0 END) AS useful_count,
      SUM(CASE WHEN ka.caused_correction = 1 THEN 1 ELSE 0 END) AS caused_correction_count
    FROM knowledge_items ki
    JOIN knowledge_access ka ON ka.knowledge_item_id = ki.id
    GROUP BY ki.id, ki.title, ki.freshness
  `);
  const items = result.rows.map(mapReportItem);
  return {
    highValue: items.filter(item => item.usefulCount > 0).sort((a, b) => b.usefulCount - a.usefulCount || b.retrievalCount - a.retrievalCount),
    staleFrequentlyRetrieved: items.filter(item => item.freshness !== 'fresh' && item.retrievalCount > 0).sort((a, b) => b.retrievalCount - a.retrievalCount),
    repeatedlyCorrected: items.filter(item => item.causedCorrectionCount > 1).sort((a, b) => b.causedCorrectionCount - a.causedCorrectionCount),
  };
}

export type KnowledgeAccessSummary = {
  retrievalCount: number;
  lastRetrievedAt: string;
  /** Times explicitly marked useful. Direct evidence of worth, unlike a retrieval count. */
  usefulCount: number;
  /** Times explicitly marked NOT useful — evidence the row is noise in results it wins. */
  notUsefulCount: number;
};

// Per-item retrieval frequency and recency — used by GC to protect hot memory
// from decay and to collect only genuinely cold items. Retrieval counts still exclude
// feedback rows (a verdict is not a retrieval), but the verdicts themselves are now
// summarised alongside, because retrieval volume on its own cannot tell a load-bearing
// item from one that keeps polluting result sets.
export async function getAccessSummary(): Promise<Map<string, KnowledgeAccessSummary>> {
  const rows = (await getClient().execute(`
    SELECT knowledge_item_id,
      SUM(CASE WHEN surface != 'feedback' THEN 1 ELSE 0 END) AS retrieval_count,
      MAX(CASE WHEN surface != 'feedback' THEN retrieved_at END) AS last_retrieved_at,
      SUM(CASE WHEN useful = 1 THEN 1 ELSE 0 END) AS useful_count,
      SUM(CASE WHEN useful = 0 THEN 1 ELSE 0 END) AS not_useful_count
    FROM knowledge_access GROUP BY knowledge_item_id
  `)).rows;
  const summary = new Map<string, KnowledgeAccessSummary>();
  for (const row of rows) {
    summary.set(String(row.knowledge_item_id), {
      retrievalCount: Number(row.retrieval_count),
      // A row with feedback but no retrievals has no last-retrieved instant; the epoch keeps
      // it unambiguously cold rather than accidentally recent via an empty string.
      lastRetrievedAt: row.last_retrieved_at === null ? new Date(0).toISOString() : String(row.last_retrieved_at),
      usefulCount: Number(row.useful_count),
      notUsefulCount: Number(row.not_useful_count),
    });
  }
  return summary;
}
