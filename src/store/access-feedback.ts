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

export type KnowledgeAccess = Omit<KnowledgeAccessInput, 'query' | 'retrievedAt'> & {
  id: string;
  queryFingerprint: string | null;
  /**
   * Optional to supply, never absent once recorded: `retrieved_at` is NOT NULL, and both
   * producers -- the insert below and `mapAccess` -- always have a value. Carrying the
   * input's optionality through would describe a row the column cannot hold, and
   * `undefined` is not a value the driver will bind at all.
   */
  retrievedAt: string;
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

/**
 * Surfaces that record something other than the ranker choosing to show an item.
 *
 * `feedback` is an agent reporting on an item it already had. `rederived` is a write the store
 * recognised as something it already holds -- the agent concluded it again from scratch. Neither
 * is a read, and counting either as one would inflate `retrievalCount`, which is the number
 * behind the never-read lens and behind GC's `isHot`. That number has been measured and argued
 * about; quietly widening what it counts would invalidate every one of those measurements.
 */
const REDERIVED_SURFACE = 'rederived';

/**
 * SQL fragment rather than a bound parameter: both queries below are aggregates run with no
 * args, and these values are compile-time constants, never anything a caller supplies.
 */
const IS_RETRIEVAL = `surface NOT IN ('feedback', '${REDERIVED_SURFACE}')`;

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

/**
 * Record that a write turned out to be something the store already holds.
 *
 * This is the only POSITIVE capture signal in the system: every other rule says what not to
 * store. An agent that reaches the same conclusion again, in a later session, without the store
 * having handed it the answer, is evidence the fact is load-bearing -- and unlike a read it is
 * not the ranker's opinion, it is the agent's own reasoning over the code arriving in the same
 * place twice.
 *
 * It is NOT the retrieval feedback loop the store refuses elsewhere: a no-op write stores
 * nothing, so no amount of re-derivation can multiply copies of a bad atom. Dedup is what
 * stands in the way of that loop, and this counts the times dedup fired.
 *
 * ponytail: an agent that retrieved the atom this session and then re-stored it verbatim also
 * lands here, and `knowledge_access` has no session column to tell the two apart. That inflates
 * the count without creating atoms or ranking pressure, which is why this protects from GC and
 * is deliberately not wired into ranking. Wire it there only behind a measurement.
 */
export async function recordRederivationBestEffort(itemId: string): Promise<void> {
  await recordKnowledgeAccessBestEffort({ itemId, surface: REDERIVED_SURFACE, rank: 0 });
}

export async function listKnowledgeAccess(itemId: string): Promise<KnowledgeAccess[]> {
  const result = await getClient().execute({
    // Ties break on rowid, not id. `retrieved_at` is millisecond text, so an access and the
    // feedback answering it commonly share one, and `id` is random hex -- which made the
    // order of an append-only log a coin flip. rowid is the insertion counter, so equal
    // timestamps read back in the order they were written.
    sql: 'SELECT * FROM knowledge_access WHERE knowledge_item_id = ? ORDER BY retrieved_at ASC, rowid ASC',
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
      SUM(CASE WHEN ka.${IS_RETRIEVAL} THEN 1 ELSE 0 END) AS retrieval_count,
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
  /**
   * Null when an item has only ever been re-derived and never retrieved. A caller that reads
   * this as a date must handle that: treating the absence as "read just now" is how a
   * never-read atom would silently become protected.
   */
  lastRetrievedAt: string | null;
  /** Times a write was recognised as something the store already held. */
  rederivedCount: number;
};

// Per-item retrieval frequency and recency — used by GC to protect hot memory
// from decay and to collect only genuinely cold items.
export async function getAccessSummary(): Promise<Map<string, KnowledgeAccessSummary>> {
  const rows = (await getClient().execute(`
    SELECT knowledge_item_id,
      SUM(CASE WHEN ${IS_RETRIEVAL} THEN 1 ELSE 0 END) AS retrieval_count,
      MAX(CASE WHEN ${IS_RETRIEVAL} THEN retrieved_at END) AS last_retrieved_at,
      SUM(CASE WHEN surface = '${REDERIVED_SURFACE}' THEN 1 ELSE 0 END) AS rederived_count
    FROM knowledge_access GROUP BY knowledge_item_id
  `)).rows;
  const summary = new Map<string, KnowledgeAccessSummary>();
  for (const row of rows) {
    summary.set(String(row.knowledge_item_id), {
      retrievalCount: Number(row.retrieval_count),
      // Null survives as null: an item with only re-derivations has no read to date.
      lastRetrievedAt: row.last_retrieved_at == null ? null : String(row.last_retrieved_at),
      rederivedCount: Number(row.rederived_count),
    });
  }
  return summary;
}
