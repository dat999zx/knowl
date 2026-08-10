import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import { DbConnection, getDb } from './database.js';

/**
 * What was true about an item at the instant it was destroyed.
 *
 * WHY THIS IS NOT THE TOMBSTONE. `knowledge_tombstones` answers a different question and has to
 * stay small: it is the record a delete can TRAVEL on, written into every portable export
 * (`portability.ts`) and merged by a monotonic upsert on import. Putting usage numbers there
 * would push local retrieval telemetry into every export, and the upsert would let a peer's
 * import overwrite this machine's audit trail with its own -- or with nulls. So the sync record
 * and the audit record are separate tables, and only one of them leaves the machine.
 *
 * WHY IT EXISTS AT ALL. GC computes a precise reason per candidate -- "State item stale for 47
 * days and never retrieved" -- reports it in the run result, and then drops it: the tombstone was
 * written with the hardcoded literal `'purged'`, so every purge in the store said the same word.
 * The deciding numbers existed for the length of one function call. That makes a collection policy
 * unfalsifiable after the fact: you cannot ask which items were taken while they were still being
 * retrieved, and you cannot retune a threshold against what it actually did, because nothing
 * remembers what it did.
 *
 * Append-only, one row per destroyed item, and deliberately NOT foreign-keyed to
 * `knowledge_items` -- the row it describes is gone by the time this is written, and a cascade
 * would delete the record at the moment it became the only copy.
 */
export type ForgetLogEntry = {
  itemId: string;
  title: string;
  category: string;
  /** Standing and status as they stood at deletion, not as some later import believes them. */
  tier: string | null;
  status: string | null;
  /**
   * The repo that OWNED the item, copied off it at deletion -- not the repo that ran the
   * collection. Several repos share one database in workspace v2, so this is what makes
   * "which of my items were taken" answerable. NULL outside a workspace.
   */
  originRepo: string | null;
  deletedAt: string;
  /** Which mechanism destroyed it. `reason` says why in words; this says who. */
  policy: string;
  /**
   * The RULE that fired, as an enumerated code, beside the human sentence rather than replacing
   * it. Taken from Lethe's `forget_log.py` (MIT), which keeps its reasons as module constants
   * because they are "part of the public ForgetLog contract -- anyone reading the log needs to
   * know what the strings mean". A log whose only reason is prose cannot be aggregated: "how many
   * were merged versus collected cold" should be a GROUP BY, not a regex over English.
   */
  reasonCode: ForgetReasonCode;
  reason: string;
  /**
   * For a duplicate collection, the item that absorbed this one. Recoverable before only by
   * parsing it back out of the `Duplicate of <id>` sentence; a column makes "what was merged
   * into X" answerable, and `knowl forget-log` can print the survivor.
   */
  mergedIntoId: string | null;
  /**
   * A bounded snapshot of what was destroyed, because by the time anyone reads this row the item
   * is gone -- a purge is a hard delete. Judging whether a policy was right usually means seeing
   * the thing it took. Bounded at MAX_PREVIEW_CHARS so the audit trail cannot quietly undo the
   * reclamation the collection was for; the commit log still holds the whole `before` item.
   */
  contentPreview: string | null;
  /** The retrieval evidence the policy decided against. Zero is a finding, not a gap. */
  retrievalCount: number;
  lastRetrievedAt: string | null;
  /** Days between the item's last update and its deletion. */
  ageDays: number | null;
  bytes: number | null;
};

/**
 * The rules that can destroy an item, as a closed set.
 *
 * Public contract, deliberately: a new collection rule adds a code here rather than inventing
 * another English sentence nothing can group by.
 */
export type ForgetReasonCode = 'gc:duplicate' | 'delete:unspecified' | 'unspecified';

export const FORGET_REASON_DUPLICATE = 'gc:duplicate';
export const FORGET_REASON_MANUAL = 'delete:unspecified';
export const FORGET_LOG_POLICY_MANUAL = 'delete';

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

/**
 * Written through the caller's connection, so a delete and its log entry land in one
 * transaction -- the same reason `deleteKnowledgeItem` writes the tombstone that way. A purge
 * that lost its log entry would be exactly the silent loss this table exists to prevent.
 */
export async function recordForgetLogEntry(
  entry: ForgetLogEntry,
  dbConnection?: DbConnection,
): Promise<void> {
  const conn = (dbConnection ?? getDb()) as any;
  await conn.run(sql`
    INSERT INTO knowledge_forget_log (
      id, knowledge_item_id, title, category, tier, status, origin_repo, deleted_at,
      policy, reason_code, reason, merged_into_id, content_preview,
      retrieval_count, last_retrieved_at, age_days, bytes
    ) VALUES (
      ${generateId()}, ${entry.itemId}, ${entry.title}, ${entry.category},
      ${entry.tier ?? null}, ${entry.status ?? null}, ${entry.originRepo ?? null},
      ${entry.deletedAt},
      ${entry.policy}, ${entry.reasonCode}, ${entry.reason},
      ${entry.mergedIntoId ?? null}, ${entry.contentPreview ?? null},
      ${entry.retrievalCount},
      ${entry.lastRetrievedAt ?? null}, ${entry.ageDays ?? null}, ${entry.bytes ?? null}
    )
  `);
}

/**
 * Newest first: the question this answers is almost always "what just went missing".
 *
 * Unfiltered by default even in a shared workspace database. Scoping silently to the calling
 * repo would make an audit trail that answers "nothing was collected" when a neighbour took
 * fifty items, which is the failure this table exists to rule out. Pass `originRepo` to narrow
 * deliberately.
 */
export async function listForgetLog(
  options: { limit?: number; originRepo?: string } = {},
  dbConnection?: DbConnection,
): Promise<ForgetLogEntry[]> {
  const conn = (dbConnection ?? getDb()) as any;
  const limit = Math.max(1, Math.min(options.limit ?? 50, 1000));
  const repo = options.originRepo;
  const rows = await conn.all(sql`
    SELECT knowledge_item_id, title, category, tier, status, origin_repo, deleted_at,
           policy, reason_code, reason, merged_into_id, content_preview,
           retrieval_count, last_retrieved_at, age_days, bytes
    FROM knowledge_forget_log
    WHERE ${repo === undefined ? sql`1 = 1` : sql`origin_repo = ${repo}`}
    ORDER BY deleted_at DESC, rowid DESC
    LIMIT ${limit}
  `);
  return rows.map((row: any) => ({
    itemId: String(row.knowledge_item_id),
    title: String(row.title),
    category: String(row.category),
    tier: row.tier === null || row.tier === undefined ? null : String(row.tier),
    status: row.status === null || row.status === undefined ? null : String(row.status),
    originRepo: row.origin_repo === null || row.origin_repo === undefined ? null : String(row.origin_repo),
    deletedAt: String(row.deleted_at),
    policy: String(row.policy),
    reasonCode: String(row.reason_code ?? 'unspecified') as ForgetReasonCode,
    reason: String(row.reason),
    mergedIntoId: row.merged_into_id === null || row.merged_into_id === undefined
      ? null
      : String(row.merged_into_id),
    contentPreview: row.content_preview === null || row.content_preview === undefined
      ? null
      : String(row.content_preview),
    retrievalCount: Number(row.retrieval_count ?? 0),
    lastRetrievedAt: row.last_retrieved_at === null || row.last_retrieved_at === undefined
      ? null
      : String(row.last_retrieved_at),
    ageDays: row.age_days === null || row.age_days === undefined ? null : Number(row.age_days),
    bytes: row.bytes === null || row.bytes === undefined ? null : Number(row.bytes),
  }));
}

/**
 * Bounded only on request, unlike `pruneTombstones`, which prunes at 90 days on every GC run.
 *
 * The asymmetry is the point. A tombstone older than any plausible export round cannot change a
 * future import, so it has no remaining job. A forget-log row's job is to still be there when
 * somebody asks whether a threshold was ever right, and that question arrives months late or not
 * at all -- pruning on the same schedule would mean the answer is reliably gone by the time
 * anyone wants it. One row per destroyed item is a rounding error next to the item bodies GC
 * exists to reclaim, so the default is to keep them.
 */
export async function pruneForgetLog(
  olderThanDays: number,
  now: Date = new Date(),
  dbConnection?: DbConnection,
): Promise<number> {
  const conn = (dbConnection ?? getDb()) as any;
  const cutoff = new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  const result = await conn.run(sql`DELETE FROM knowledge_forget_log WHERE deleted_at < ${cutoff}`);
  return Number(result?.rowsAffected ?? 0);
}
