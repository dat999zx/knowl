import type { Client } from '@libsql/client';
import { KNOWLEDGE_CATEGORIES, type KnowledgeCategory, type ProjectConfig } from '../core/types.js';
import { storeKnowledgeAtomsDeduped } from '../store/knowledge-writer.js';
import { candidateToAtom, listCandidates, type ExtractionCandidate } from './extract-candidates.js';

/**
 * Promoting a staged candidate into the knowledge store, one explicit decision at a time.
 *
 * This is the half that makes bulk extraction safe to have. Extraction is cheap to re-run and
 * writes nothing anybody has to trust; everything that reaches a future query passes through
 * here, and only because somebody named it.
 *
 * Promotion goes through `storeKnowledgeAtomsDeduped` -- the same writer `knowl_ingest_atoms`
 * uses -- so a candidate meets the checks everything else passes: secret validation, confidence
 * range, dedup against what is already stored, workspace ownership. A transcript is the least
 * reviewed text in the system, an archive full of things that were true for ten minutes, so the
 * last thing it should get is a shortcut around those.
 *
 * **Not `runDecisionPipeline`, and the reason is load-bearing.** That path runs `runVerify`,
 * which calls the model to adjudicate against existing items in the same category -- so it works
 * on an empty store and starts throwing "AI provider has not been initialized" on the second
 * atom of the very first bulk run. Approval must not require AI: extraction already does, and
 * making the human's decision depend on a provider too would mean a configured key is needed to
 * accept work that has already been paid for.
 */

export type ApprovalResult = {
  approved: number;
  /** Candidates the merge path folded into an item that already said this. */
  deduped: number;
  failed: { id: string; reason: string }[];
  itemIds: string[];
};

function parseTags(raw: unknown): string[] | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : null;
  } catch {
    return null;
  }
}

async function loadCandidates(db: Client, ids: string[]): Promise<(ExtractionCandidate & { tags: string[] | null })[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = (await db.execute({
    sql: `SELECT id, session_id, source_path, harness, category, title, content, confidence, status, tags
          FROM transcript_candidates
          WHERE id IN (${placeholders}) AND status = 'pending'`,
    args: ids,
  })).rows;

  return rows.map(row => ({
    id: String(row.id),
    sessionId: String(row.session_id),
    sourcePath: String(row.source_path),
    harness: String(row.harness ?? 'claude'),
    category: String(row.category),
    title: String(row.title),
    content: String(row.content),
    confidence: Number(row.confidence ?? 0),
    status: String(row.status),
    tags: parseTags(row.tags),
  }));
}

/**
 * Promote the named candidates, or every pending one.
 *
 * Each is promoted in its own call rather than as a batch, so one bad atom fails alone. A batch
 * would be faster and would mean a single rejected secret took the whole run's work with it --
 * on a path whose input is a thousand model-written atoms, of which some will be wrong.
 *
 * A candidate that fails stays `pending`. It can be retried after the cause is fixed, or
 * discarded; what it must not do is silently disappear into a status that reads like a decision
 * somebody made.
 */
export async function approveCandidates(
  db: Client,
  projectId: string,
  config: ProjectConfig,
  selection: { ids?: string[]; all?: boolean; limit?: number },
): Promise<ApprovalResult> {
  const targets = selection.all
    ? (await listCandidates(db, { status: 'pending', limit: selection.limit ?? 1_000 }))
      .map(candidate => candidate.id)
    : selection.ids ?? [];

  const candidates = await loadCandidates(db, targets);
  const result: ApprovalResult = { approved: 0, deduped: 0, failed: [], itemIds: [] };

  for (const candidate of candidates) {
    try {
      // Checked here rather than trusted from the row. These titles and categories were written
      // by a model over unreviewed text, and nothing between the provider and this line refuses a
      // category that does not exist -- a `not-a-category` atom reached `knowledge_items` intact
      // before this guard existed, where every reader downstream assumes the enum.
      if (!KNOWLEDGE_CATEGORIES.includes(candidate.category as KnowledgeCategory)) {
        throw new Error(`Unknown category "${candidate.category}"`);
      }

      // `config.security` carries this repo's secret patterns, exactly as `knowl_ingest_atoms`
      // passes them. Omitting it would have run the weakest secret validation available on the
      // one input most likely to contain a key: a transcript is a recording of a working session,
      // and working sessions paste credentials.
      const batch = await storeKnowledgeAtomsDeduped(
        projectId,
        [candidateToAtom(candidate, candidate.tags)],
        `Approve transcript candidate from session ${candidate.sessionId}`,
        config?.security,
      );

      const outcome = batch.outcomes[0];
      const itemId = outcome?.itemId ?? null;
      // A duplicate is a success and is counted apart: on a bulk run it is the number that says
      // whether extraction is producing knowledge or echoes of what is already stored.
      if (outcome?.action === 'duplicate') result.deduped += 1;

      await db.execute({
        sql: `UPDATE transcript_candidates
              SET status = 'approved', decided_at = ?, promoted_item_id = ?
              WHERE id = ? AND status = 'pending'`,
        args: [new Date().toISOString(), itemId, candidate.id],
      });

      result.approved += 1;
      if (itemId) result.itemIds.push(itemId);
    } catch (error) {
      result.failed.push({ id: candidate.id, reason: (error as Error).message });
    }
  }

  return result;
}

/**
 * Mark candidates rejected, without deleting them.
 *
 * Kept rather than removed so a rerun of extraction does not resurrect what somebody has already
 * turned down -- the session watermark stops the model being paid twice, and this stops the human
 * being asked twice.
 */
export async function discardCandidates(
  db: Client,
  selection: { ids?: string[]; all?: boolean },
): Promise<number> {
  if (selection.all) {
    const result = await db.execute({
      sql: `UPDATE transcript_candidates SET status = 'discarded', decided_at = ? WHERE status = 'pending'`,
      args: [new Date().toISOString()],
    });
    return Number(result.rowsAffected ?? 0);
  }

  const ids = selection.ids ?? [];
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(', ');
  const result = await db.execute({
    sql: `UPDATE transcript_candidates SET status = 'discarded', decided_at = ?
          WHERE id IN (${placeholders}) AND status = 'pending'`,
    args: [new Date().toISOString(), ...ids],
  });
  return Number(result.rowsAffected ?? 0);
}
