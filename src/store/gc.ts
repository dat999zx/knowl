import { getDb } from './database.js';
import * as repo from './repository.js';
import { pruneTombstones } from './tombstones.js';
import { getAccessSummary, KnowledgeAccessSummary } from './access-feedback.js';
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

function preferredDuplicate(left: KnowledgeItem, right: KnowledgeItem): KnowledgeItem {
  if (left.confidence !== right.confidence) {
    return left.confidence > right.confidence ? left : right;
  }
  return left.updatedAt >= right.updatedAt ? left : right;
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

function buildCandidates(items: KnowledgeItem[], options: KnowledgeGcOptions, access: Map<string, KnowledgeAccessSummary>): KnowledgeGcCandidate[] {
  const now = new Date(options.now || new Date().toISOString());
  const staleStateDays = options.staleStateDays ?? DEFAULT_STALE_STATE_DAYS;
  const compressArchivedDays = options.compressArchivedDays ?? DEFAULT_COMPRESS_ARCHIVED_DAYS;
  const minCompressBytes = options.minCompressBytes ?? DEFAULT_MIN_COMPRESS_BYTES;
  const candidates: KnowledgeGcCandidate[] = [];
  const bestByDuplicateKey = new Map<string, KnowledgeItem>();

  for (const item of items) {
    if (item.status !== 'active') continue;
    const key = duplicateKey(item);
    const currentBest = bestByDuplicateKey.get(key);
    bestByDuplicateKey.set(key, currentBest ? preferredDuplicate(currentBest, item) : item);
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
  const candidates = buildCandidates(items, options, access);
  return {
    candidates,
    summary: summarizeCandidates(candidates),
  };
}

export async function applyKnowledgeGc(
  projectId: string,
  options: KnowledgeGcOptions = {}
): Promise<KnowledgeGcResult> {
  const db = getDb();
  const access = await getAccessSummary();
  return db.transaction(async (tx) => {
    const items = await repo.listKnowledgeItems(tx);
    const candidates = buildCandidates(items, options, access);
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
