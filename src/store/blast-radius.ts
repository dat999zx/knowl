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
  /** The siblings, never the corrected item itself — see `correctedItemFlagged` for that. */
  flaggedIds: string[];
  /** True when more siblings matched than the cap allowed; the rest were left untouched. */
  capped: boolean;
  /**
   * Whether the corrected item itself was flagged. False when it was already inactive, stale
   * or flagged — so a caller can report what happened without counting it as a sibling.
   */
  correctedItemFlagged: boolean;
};

/**
 * The commits that mention this item, by index where possible and by scan where not.
 *
 * K-48 recorded that `changes LIKE '%<id>%'` cannot use an index, which is true -- a leading
 * wildcard defeats a B-tree -- and concluded that shrinking the scanned bytes was therefore
 * the only lever. It was not: which items a commit touched is known when the commit is
 * written, and `knowledge_commit_items` now writes it down, so the lookup is an equality
 * search instead of a walk over the whole history.
 *
 * Measured on a copy of a real store, 643 commits and one month old: the scan cost 6.49 ms,
 * payload compaction alone brought it to 0.13 ms, and the same compacted table grown to
 * 20,000 rows -- 2.6 years at that store's 21.5 commits a day -- went back to 2.54 ms, then
 * 30.55 ms at 100,000. Compaction shrinks the bytes and not the row count, and commit rows
 * are never deleted because they are the audit trail, so the scan is O(commits) forever.
 *
 * The fallback is not decoration. A store that reached this build without the backfill has
 * no index rows, and a missing row must cost speed rather than a sibling.
 */
async function insertCommitChanges(itemId: string): Promise<string[]> {
  try {
    const indexed = (await getClient().execute({
      sql: `SELECT commits.changes AS changes FROM knowledge_commits commits
            JOIN knowledge_commit_items entry ON entry.commit_id = commits.id
            WHERE entry.item_id = ? AND entry.action = 'insert'`,
      args: [itemId],
    })).rows;
    if (indexed.length > 0) return indexed.map(row => String(row.changes));
  } catch {
    // No index table on this database yet; the scan below is still correct.
  }

  // Bounded by how often one id appears in commits, which is small by construction.
  const scanned = (await getClient().execute({
    sql: 'SELECT changes FROM knowledge_commits WHERE changes LIKE ?',
    args: [`%${itemId}%`],
  })).rows;
  return scanned.map(row => String(row.changes));
}

async function siblingsFromInsertCommits(itemId: string): Promise<string[]> {
  // The index chooses which commits to open; `changes` still answers who was in them. Making
  // the index the answer would give the audit trail a second, divergeable copy.
  const rows = (await insertCommitChanges(itemId)).map(changes => ({ changes }));

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
async function eligibleForReview(candidateIds: string[]): Promise<string[]> {
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
  // The corrected item is resolved on its own, before the siblings and outside their cap.
  //
  // It used to be the one item in the neighbourhood NOT flagged: `siblingsFromInsertCommits`
  // excludes it by id, so a correction demoted its tier, flipped up to twelve batch-mates to
  // needs_review on the strength of shared provenance, and left the item the agent actually
  // named sitting at `fresh`. Measured on this repo's store: of 14 items that ever caused a
  // correction, 6 were still active and still fresh. Weaker evidence earned the flag and
  // direct evidence did not.
  //
  // Kept out of the candidate pool rather than added to it, for two reasons. The cap below
  // could drop it in a wide batch — the one item that must never be the one dropped — and the
  // empty-candidate early-out would skip it entirely for a correction with no siblings at
  // all, which is the common shape.
  //
  // Same eligibility as a sibling, which is what makes this safe on the deprecate/reject path
  // in `knowledge-actions.ts`: that caller flips status first, so an inactive item filters
  // itself out here and neither caller needs special-casing.
  const self = await eligibleForReview([correctedItemId]);

  const groups = await Promise.all([
    siblingsFromInsertCommits(correctedItemId),
    siblingsFromSource(correctedItemId),
    siblingsFromSharedEvidence(correctedItemId),
  ]);
  const candidateIds = [...new Set(groups.flat())];
  const eligible = candidateIds.length > 0 ? await eligibleForReview(candidateIds) : [];

  const capped = eligible.length > MAX_BLAST_RADIUS;
  const toFlag = [...self, ...eligible.slice(0, MAX_BLAST_RADIUS)];
  if (toFlag.length === 0) return { flaggedIds: [], capped: false, correctedItemFlagged: false };

  // Full rows are loaded only for what is actually flagged — at most the cap, plus the
  // corrected item — because the commit records each item's before state.
  const changes: CommitChange[] = [];
  for (const id of toFlag) {
    const item = await repo.getKnowledgeItem(id);
    if (!item) continue;
    const updated = await repo.updateKnowledgeItem(id, { freshness: 'needs_review' });
    changes.push({ itemId: id, action: 'update', before: item, after: updated });
  }
  // `flaggedIds` stays exactly what it has always meant: the siblings. The corrected item is
  // reported through its own field instead, so no caller has to know to filter an id out of a
  // list named for something else. Both rows are in the commit either way — the audit trail
  // records every write, whatever the return shape calls them.
  const siblingIds = changes.map(change => change.itemId).filter(id => id !== correctedItemId);
  await repo.createKnowledgeCommit(
    projectId,
    `Correction blast radius: ${siblingIds.length} sibling(s) of ${reason}`,
    changes,
  );

  return {
    flaggedIds: siblingIds,
    capped,
    correctedItemFlagged: changes.some(change => change.itemId === correctedItemId),
  };
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
