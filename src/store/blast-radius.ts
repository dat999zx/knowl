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
  const rows = (await getClient().execute({
    sql: `SELECT other.id FROM knowledge_items corrected
          JOIN knowledge_items other ON other.source = corrected.source AND other.id != corrected.id
          WHERE corrected.id = ? AND corrected.source IS NOT NULL AND corrected.source != ''`,
    args: [itemId],
  })).rows;
  return rows.map(row => String(row.id));
}

async function siblingsFromSharedEvidence(itemId: string): Promise<string[]> {
  const rows = (await getClient().execute({
    sql: `SELECT DISTINCT other.knowledge_item_id AS id
          FROM knowledge_evidence own
          JOIN knowledge_evidence other ON other.evidence_id = own.evidence_id
          WHERE own.knowledge_item_id = ? AND other.knowledge_item_id != ?`,
    args: [itemId, itemId],
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

  // Only items still standing on their original claim are worth flagging: an inactive
  // item is already out of retrieval's default path, and one already stale or flagged
  // has nothing further to learn from this correction.
  const eligible: { id: string; item: Awaited<ReturnType<typeof repo.getKnowledgeItem>> }[] = [];
  for (const id of candidateIds) {
    const item = await repo.getKnowledgeItem(id);
    if (item && item.status === 'active' && item.freshness === 'fresh') {
      eligible.push({ id, item });
    }
  }
  if (eligible.length === 0) return { flaggedIds: [], capped: false };

  const capped = eligible.length > MAX_BLAST_RADIUS;
  const toFlag = eligible.slice(0, MAX_BLAST_RADIUS);

  const changes: CommitChange[] = [];
  for (const { id, item } of toFlag) {
    const updated = await repo.updateKnowledgeItem(id, { freshness: 'needs_review' });
    changes.push({ itemId: id, action: 'update', before: item, after: updated });
  }
  await repo.createKnowledgeCommit(
    projectId,
    `Correction blast radius: ${changes.length} sibling(s) of ${reason}`,
    changes,
  );

  return { flaggedIds: toFlag.map(entry => entry.id), capped };
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
