import { sql } from 'drizzle-orm';
import { getDb, withClientTransaction } from './database.js';
import type { DbConnection } from './database.js';
import * as repo from './repository.js';
import { pruneTombstones } from './tombstones.js';
import { getAccessSummary, KnowledgeAccessSummary } from './access-feedback.js';
import { carriesNothingNew, KnowledgePayload } from './knowledge-writer.js';
import { CommitChange, KnowledgeCategory, KnowledgeItem } from '../core/types.js';

export type KnowledgeGcAction = 'archive' | 'compress' | 'purge';

export interface KnowledgeGcCandidate {
  itemId: string;
  action: KnowledgeGcAction;
  title: string;
  category: KnowledgeCategory;
  status: string;
  reason: string;
  duplicateOfId?: string;
  beforeBytes: number;
  afterBytes: number;
  replacementContent?: string;
}

export interface KnowledgeGcOptions {
  now?: string;
  staleStateDays?: number;
  compressArchivedDays?: number;
  minCompressBytes?: number;
  /** Archive stale state items even if they are hot (recently/frequently retrieved). */
  ignoreAccess?: boolean;
  /** Remove delete records older than this many days. Defaults to 90. */
  tombstoneDays?: number;
}

export interface KnowledgeGcResult {
  /** Delete records removed by retention; present only on apply. */
  prunedTombstones?: number;
  candidates: KnowledgeGcCandidate[];
  summary: Record<KnowledgeGcAction, number>;
}

const DEFAULT_STALE_STATE_DAYS = 60;
const DEFAULT_COMPRESS_ARCHIVED_DAYS = 30;
const DEFAULT_MIN_COMPRESS_BYTES = 180;
// A "hot" item — retrieved this often, or this recently — is protected from decay
// even once it passes the staleness age, so useful memory is not archived away.
const HOT_RETRIEVAL_COUNT = 3;
const HOT_RECENT_DAYS = 21;

export function isHot(itemId: string, access: Map<string, KnowledgeAccessSummary>, now: Date): boolean {
  const a = access.get(itemId);
  if (!a) return false;
  if (a.retrievalCount >= HOT_RETRIEVAL_COUNT) return true;
  return daysSince(a.lastRetrievedAt, now) <= HOT_RECENT_DAYS;
}
const PROTECTED_CATEGORIES = new Set<KnowledgeCategory>([
  'decision',
  'constraint',
  'architecture',
  'skill',
]);

function daysSince(isoDate: string, now: Date): number {
  const then = new Date(isoDate).getTime();
  return Math.floor((now.getTime() - then) / 86_400_000);
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function duplicateKey(item: KnowledgeItem): string {
  return [
    item.category,
    normalizeText(item.title),
    normalizeText(item.content),
  ].join('|');
}

/**
 * What an item holds outside `knowledge_items`, so a purge cannot destroy it unseen.
 *
 * Two grouped reads for the whole store, not one per item: this runs on every preview.
 */
export type ItemHistory = { evidence: string[]; assertions: number };

async function loadItemHistory(dbConnection?: DbConnection): Promise<Map<string, ItemHistory>> {
  const conn = (dbConnection ?? getDb()) as any;
  const history = new Map<string, ItemHistory>();
  const entry = (id: string): ItemHistory => {
    const existing = history.get(id);
    if (existing) return existing;
    const created: ItemHistory = { evidence: [], assertions: 0 };
    history.set(id, created);
    return created;
  };

  for (const row of await conn.all(sql`SELECT knowledge_item_id AS item, evidence_id AS ev FROM knowledge_evidence`)) {
    entry(String(row.item)).evidence.push(String(row.ev));
  }
  for (const row of await conn.all(sql`SELECT knowledge_item_id AS item, COUNT(*) AS n FROM knowledge_assertions GROUP BY knowledge_item_id`)) {
    entry(String(row.item)).assertions = Number(row.n);
  }
  return history;
}

function payloadOf(item: KnowledgeItem, history: Map<string, ItemHistory>): KnowledgePayload {
  return {
    ...item,
    // Excluded deliberately: confidence is a quality signal, not information the item carries,
    // and it is already the first tie-break below. Including it would stop collection whenever
    // two identical copies happened to disagree about how sure they were.
    confidence: undefined,
    evidence: history.get(item.id)?.evidence ?? [],
  };
}

/**
 * Whether `survivor` holds everything `loser` holds, so deleting `loser` destroys nothing.
 *
 * The duplicate key is category, title and content. Reasoning, tags, affectedPaths, the source
 * commit, provenance, evidence and the assertion trail are all invisible to it -- and the
 * survivor was then picked by confidence and recency alone, so the newer, barer copy won and
 * the purge hard deleted the richer one, cascading its evidence and history with it. A delete
 * is the one GC action with no undo, so it now has to be provably redundant first.
 */
function subsumes(survivor: KnowledgeItem, loser: KnowledgeItem, history: Map<string, ItemHistory>): boolean {
  if (!carriesNothingNew(payloadOf(loser, history), payloadOf(survivor, history))) return false;
  return (history.get(loser.id)?.assertions ?? 0) <= (history.get(survivor.id)?.assertions ?? 0);
}

function preferredDuplicate(left: KnowledgeItem, right: KnowledgeItem): KnowledgeItem {
  if (left.confidence !== right.confidence) {
    return left.confidence > right.confidence ? left : right;
  }
  return left.updatedAt >= right.updatedAt ? left : right;
}

/**
 * The copy that may absorb every other in its bucket, or null when there is no such copy.
 *
 * Null is the honest answer when two twins each carry something the other lacks: neither is
 * redundant, so neither is collected. Keeping both is recoverable; hard deleting either is not.
 */
function survivorOf(bucket: KnowledgeItem[], history: Map<string, ItemHistory>): KnowledgeItem | null {
  let best: KnowledgeItem | null = null;
  for (const candidate of bucket) {
    if (!bucket.every(other => other.id === candidate.id || subsumes(candidate, other, history))) continue;
    best = best ? preferredDuplicate(best, candidate) : candidate;
  }
  return best;
}

function summarize(item: KnowledgeItem): string {
  const source = item.content.replace(/\s+/g, ' ').trim();
  const summary = source.length > 120 ? `${source.slice(0, 117).trim()}...` : source;
  return `Compressed summary: ${summary}`;
}

function emptySummary(): Record<KnowledgeGcAction, number> {
  return { archive: 0, compress: 0, purge: 0 };
}

function summarizeCandidates(candidates: KnowledgeGcCandidate[]): Record<KnowledgeGcAction, number> {
  const summary = emptySummary();
  for (const candidate of candidates) {
    summary[candidate.action]++;
  }
  return summary;
}

function buildCandidates(
  items: KnowledgeItem[],
  options: KnowledgeGcOptions,
  access: Map<string, KnowledgeAccessSummary>,
  history: Map<string, ItemHistory>,
): KnowledgeGcCandidate[] {
  const now = new Date(options.now || new Date().toISOString());
  const staleStateDays = options.staleStateDays ?? DEFAULT_STALE_STATE_DAYS;
  const compressArchivedDays = options.compressArchivedDays ?? DEFAULT_COMPRESS_ARCHIVED_DAYS;
  const minCompressBytes = options.minCompressBytes ?? DEFAULT_MIN_COMPRESS_BYTES;
  const candidates: KnowledgeGcCandidate[] = [];
  const buckets = new Map<string, KnowledgeItem[]>();

  for (const item of items) {
    if (item.status !== 'active') continue;
    const key = duplicateKey(item);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }

  // Resolved per bucket rather than by folding pairwise: "which copy absorbs all the others"
  // is a property of the whole bucket, and a fold can elect a survivor that subsumes the one
  // it beat but not the one it never met.
  const bestByDuplicateKey = new Map<string, KnowledgeItem>();
  for (const [key, bucket] of buckets) {
    const survivor = bucket.length > 1 ? survivorOf(bucket, history) : bucket[0];
    if (survivor) bestByDuplicateKey.set(key, survivor);
  }

  for (const item of items) {
    const beforeBytes = Buffer.byteLength(item.content, 'utf8');

    if (item.status === 'active') {
      const duplicateOf = bestByDuplicateKey.get(duplicateKey(item));
      if (
        duplicateOf &&
        duplicateOf.id !== item.id &&
        !PROTECTED_CATEGORIES.has(item.category)
      ) {
        candidates.push({
          itemId: item.id,
          action: 'purge',
          title: item.title,
          category: item.category,
          status: item.status,
          reason: `Duplicate of ${duplicateOf.id}`,
          duplicateOfId: duplicateOf.id,
          beforeBytes,
          afterBytes: 0,
        });
        continue;
      }

      if (
        item.category === 'state' &&
        daysSince(item.updatedAt, now) >= staleStateDays &&
        (options.ignoreAccess || !isHot(item.id, access, now))
      ) {
        const retrievals = access.get(item.id)?.retrievalCount ?? 0;
        candidates.push({
          itemId: item.id,
          action: 'archive',
          title: item.title,
          category: item.category,
          status: item.status,
          reason: `State item stale for ${daysSince(item.updatedAt, now)} days${retrievals === 0 ? ' and never retrieved' : ''}`,
          beforeBytes,
          afterBytes: beforeBytes,
        });
      }
      continue;
    }

    if (
      item.status === 'archived' &&
      beforeBytes >= minCompressBytes &&
      !item.content.startsWith('Compressed summary:') &&
      daysSince(item.updatedAt, now) >= compressArchivedDays
    ) {
      const replacementContent = summarize(item);
      // Compression that grows the item is not compression. `summarize` truncates on UTF-16
      // *length* (>120 chars) while the gate above and the report below measure *bytes*, so any
      // content averaging >=1.5 bytes/char -- CJK, emoji, accented Latin -- could clear the
      // 180-byte gate, stay under the 120-char limit, and come back whole plus the 20-byte
      // `Compressed summary: ` prefix. Measured 189 -> 209 bytes, applied, with the original
      // content destroyed in exchange for the growth. Skipping leaves the item archived and
      // intact, which is the correct outcome for something already small enough.
      if (Buffer.byteLength(replacementContent, 'utf8') >= beforeBytes) continue;
      candidates.push({
        itemId: item.id,
        action: 'compress',
        title: item.title,
        category: item.category,
        status: item.status,
        reason: `Archived item cold for ${daysSince(item.updatedAt, now)} days`,
        beforeBytes,
        afterBytes: Buffer.byteLength(replacementContent, 'utf8'),
        replacementContent,
      });
    }
  }

  return candidates;
}

export async function previewKnowledgeGc(
  projectId: string,
  options: KnowledgeGcOptions = {}
): Promise<KnowledgeGcResult> {
  const items = await repo.listKnowledgeItems();
  const access = await getAccessSummary();
  const candidates = buildCandidates(items, options, access, await loadItemHistory());
  return {
    candidates,
    summary: summarizeCandidates(candidates),
  };
}

export async function applyKnowledgeGc(
  projectId: string,
  options: KnowledgeGcOptions = {}
): Promise<KnowledgeGcResult> {
  const access = await getAccessSummary();
  // Drizzle's wrapper opens its own BEGIN on the shared connection, outside the queue that
  // serializes every other transaction, so an ordinary write racing `knowl gc` died on
  // "cannot start a transaction within a transaction". Collection is also the longest
  // transaction the store ever opens, which makes it the likeliest thing for a write to race.
  //
  // Measured separately (2026-08-04): this call is NOT exposed to the wrapper's exit crash.
  // That crash counts `db.transaction()` calls, not statements, and collection makes exactly
  // one of them however many candidates it has -- 5,000 purges, 10,000 statements, clean exit.
  return withClientTransaction(async (tx) => {
    const items = await repo.listKnowledgeItems(tx);
    const candidates = buildCandidates(items, options, access, await loadItemHistory(tx));
    const byId = new Map(items.map(item => [item.id, item]));
    const changes: CommitChange[] = [];

    for (const candidate of candidates) {
      const before = byId.get(candidate.itemId);
      if (!before) continue;

      if (candidate.action === 'purge') {
        await repo.deleteKnowledgeItem(candidate.itemId, tx);
        changes.push({
          itemId: candidate.itemId,
          action: 'delete',
          before,
          after: null,
        });
      } else if (candidate.action === 'archive') {
        const after = await repo.updateKnowledgeItem(candidate.itemId, { status: 'archived' }, undefined, tx);
        changes.push({
          itemId: candidate.itemId,
          action: 'archive',
          before,
          after,
        });
      } else {
        const after = await repo.updateKnowledgeItem(
          candidate.itemId,
          {
            content: candidate.replacementContent || summarize(before),
            reasoning: candidate.reason,
          },
          undefined,
          tx
        );
        changes.push({
          itemId: candidate.itemId,
          action: 'update',
          before,
          after,
        });
      }
    }

    if (changes.length > 0) {
      await repo.createKnowledgeCommit(projectId, 'Apply knowledge GC', changes, tx);
    }

    // Tombstones are the only unbounded table this feature adds. One older than any
    // plausible export round cannot change the outcome of a future import.
    const prunedTombstones = await pruneTombstones(options.tombstoneDays ?? 90, undefined, tx);

    return {
      candidates,
      summary: summarizeCandidates(candidates),
      prunedTombstones,
    };
  });
}
