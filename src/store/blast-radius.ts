import { getClient } from './database.js';
import * as repo from './repository.js';
import type { CommitChange } from '../core/types.js';

/**
 * A correction never implicates only itself. The extraction pass, session promotion, or
 * ingest batch that produced one wrong item usually produced more, and the correction is
 * the one moment the system knows where to look. Siblings — items born in the same insert
 * commit, carrying the same source label, or citing the same evidence — are flipped to
 * needs_review, pointing review at the batch instead of pretending the defect was a
 * one-off.
 *
 * Deliberately conservative: only active, currently-fresh items are touched, the total is
 * capped, and nothing recurses — a flip is a freshness update, not a correction, so it
 * cannot implicate a further ring of siblings.
 */

export const MAX_BLAST_RADIUS = 12;

/**
 * Upper bound on candidate ids considered before eligibility. Far above MAX_BLAST_RADIUS so
 * the cap, not this limit, is what decides the outcome in any realistic batch; it exists so
 * a pathologically wide source label cannot build an unbounded `IN (...)` list.
 */
const CANDIDATE_SCAN_LIMIT = 500;

export type BlastRadiusResult = {
  flaggedIds: string[];
  /** True when more siblings matched than the cap allowed; the rest were left untouched. */
  capped: boolean;
};

async function siblingsFromInsertCommits(itemId: string): Promise<string[]> {
  // The changes column is JSON; the id scan is a LIKE because nothing indexes into it.
  // Bounded by how often one id appears in commits, which is small by construction.
  const rows = (await getClient().execute({
    sql: 'SELECT changes FROM knowledge_commits WHERE changes LIKE ?',
    args: [`%${itemId}%`],
  })).rows;

  const siblings = new Set<string>();
  for (const row of rows) {
    let changes: CommitChange[];
    try {
      changes = JSON.parse(String(row.changes));
    } catch {
      continue;
    }
    if (!Array.isArray(changes)) continue;
    // Only the commit that INSERTED the corrected item defines its batch. The commit
    // superseding it also mentions its id, and treating that as a batch would flag the
    // replacement that just corrected it.
    const insertedHere = changes.some(change => change?.itemId === itemId && change.action === 'insert');
    if (!insertedHere) continue;
    for (const change of changes) {
      if (change?.itemId && change.itemId !== itemId && change.action === 'insert') {
        siblings.add(change.itemId);
      }
    }
  }
  return [...siblings];
}

async function siblingsFromSource(itemId: string): Promise<string[]> {
  // `source` is a free-form label, so one value can cover an arbitrarily large batch.
  // Bounded here rather than after loading: the cap decides how many are flagged, and a
  // batch wider than the scan limit is already past every threshold this function has.
  const rows = (await getClient().execute({
    sql: `SELECT other.id FROM knowledge_items corrected
          JOIN knowledge_items other ON other.source = corrected.source AND other.id != corrected.id
          WHERE corrected.id = ? AND corrected.source IS NOT NULL AND corrected.source != ''
            AND other.status = 'active' AND other.freshness = 'fresh'
          LIMIT ?`,
    args: [itemId, CANDIDATE_SCAN_LIMIT],
  })).rows;
  return rows.map(row => String(row.id));
}

async function siblingsFromSharedEvidence(itemId: string): Promise<string[]> {
  const rows = (await getClient().execute({
    sql: `SELECT DISTINCT other.knowledge_item_id AS id
          FROM knowledge_evidence own
          JOIN knowledge_evidence other ON other.evidence_id = own.evidence_id
          JOIN knowledge_items item ON item.id = other.knowledge_item_id
          WHERE own.knowledge_item_id = ? AND other.knowledge_item_id != ?
            AND item.status = 'active' AND item.freshness = 'fresh'
          LIMIT ?`,
    args: [itemId, itemId, CANDIDATE_SCAN_LIMIT],
  })).rows;
  return rows.map(row => String(row.id));
}

/**
 * Eligibility in one round trip. Only items still standing on their original claim are
 * worth flagging: an inactive item is already out of retrieval's default path, and one
 * already stale or flagged has nothing further to learn from this correction.
 *
 * Filtered in SQL rather than by loading each candidate, because the candidate set is
 * bounded by how wide a batch was, not by the cap — a shared source label across hundreds
 * of atoms made a single correction pay hundreds of sequential round trips inside one
 * MCP call. One row over the cap is fetched so the caller can still report the overflow.
 */
async function eligibleSiblings(candidateIds: string[]): Promise<string[]> {
  const scanned = candidateIds.slice(0, CANDIDATE_SCAN_LIMIT);
  const placeholders = scanned.map(() => '?').join(', ');
  const rows = (await getClient().execute({
    sql: `SELECT id FROM knowledge_items
          WHERE id IN (${placeholders}) AND status = 'active' AND freshness = 'fresh'
          LIMIT ?`,
    args: [...scanned, MAX_BLAST_RADIUS + 1],
  })).rows;
  return rows.map(row => String(row.id));
}

export async function flagCorrectionSiblings(
  projectId: string,
  correctedItemId: string,
  reason: string,
): Promise<BlastRadiusResult> {
  const groups = await Promise.all([
    siblingsFromInsertCommits(correctedItemId),
    siblingsFromSource(correctedItemId),
    siblingsFromSharedEvidence(correctedItemId),
  ]);
  const candidateIds = [...new Set(groups.flat())];
  if (candidateIds.length === 0) return { flaggedIds: [], capped: false };

  const eligible = await eligibleSiblings(candidateIds);
  if (eligible.length === 0) return { flaggedIds: [], capped: false };

  const capped = eligible.length > MAX_BLAST_RADIUS;
  const toFlag = eligible.slice(0, MAX_BLAST_RADIUS);

  // Full rows are loaded only for what is actually flagged — at most the cap — because the
  // commit records each item's before state.
  const changes: CommitChange[] = [];
  for (const id of toFlag) {
    const item = await repo.getKnowledgeItem(id);
    if (!item) continue;
    const updated = await repo.updateKnowledgeItem(id, { freshness: 'needs_review' });
    changes.push({ itemId: id, action: 'update', before: item, after: updated });
  }
  await repo.createKnowledgeCommit(
    projectId,
    `Correction blast radius: ${changes.length} sibling(s) of ${reason}`,
    changes,
  );

  return { flaggedIds: changes.map(change => change.itemId), capped };
}

/**
 * The write that triggers a blast radius must never fail because of it: flagging siblings
 * is advisory review pressure, not part of the correction's own contract.
 */
export async function flagCorrectionSiblingsBestEffort(
  projectId: string,
  correctedItemId: string,
  reason: string,
): Promise<BlastRadiusResult | null> {
  try {
    return await flagCorrectionSiblings(projectId, correctedItemId, reason);
  } catch {
    return null;
  }
}
