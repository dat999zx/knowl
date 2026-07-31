import { getClient } from './database.js';
import { checkKnowledgeDrift, getCurrentGitCommit, listChangedFilesSince } from './drift.js';

export type AutoDriftResult = {
  /** False on the run that only learns the baseline; nothing was compared. */
  checked: boolean;
  /** Items flipped to needs_review by this run. */
  flagged: number;
  /** The watermark the diff ran from; absent when nothing was compared. */
  sinceCommit?: string;
};

/**
 * The drift check that `pr check` runs by hand, run automatically at session start.
 *
 * `checkKnowledgeDrift` has existed since the pr command shipped, but its only caller was a
 * command someone had to remember to type — so in practice knowledge went stale exactly as if
 * the check did not exist. The session boundary is the right chokepoint: it is the moment
 * before an agent starts relying on memory, and it is already where lifecycle work happens.
 *
 * The watermark is the last git commit a check ran against, keyed by project root. rowid-style
 * head tracking (change-watermark.ts) does not work here: the thing that moves is the git
 * history, not the knowledge log.
 */
export async function runAutoDriftCheck(projectId: string, projectRoot: string): Promise<AutoDriftResult | null> {
  const current = getCurrentGitCommit(projectRoot);
  if (!current) return null; // not a git repository: nothing to diff against

  const client = getClient();
  const row = (await client.execute({
    sql: 'SELECT last_checked_commit FROM drift_state WHERE project_root = ?',
    args: [projectRoot],
  })).rows[0];
  const watermark = row ? String(row.last_checked_commit) : null;

  if (watermark === current) return { checked: true, flagged: 0, sinceCommit: watermark };

  // First run learns the baseline and flags nothing. Diffing from the repository's root
  // commit would flip most of the store to needs_review in one silent wall — the same
  // reason the embedding backfill was never made automatic.
  if (!watermark) {
    await writeWatermark(projectRoot, current);
    return { checked: false, flagged: 0 };
  }

  let changedFiles: string[];
  try {
    changedFiles = listChangedFilesSince(projectRoot, watermark, current);
  } catch {
    // The watermark commit no longer exists — rebase, aggressive gc, a rewritten branch.
    // Re-baseline rather than guess: a storm of wrong needs_review flags costs more trust
    // than one missed window, and the next real change is caught from the new baseline.
    await writeWatermark(projectRoot, current);
    return { checked: false, flagged: 0 };
  }

  let flagged = 0;
  if (changedFiles.length > 0) {
    const result = await checkKnowledgeDrift(projectId, {
      sinceCommit: watermark,
      currentCommit: current,
      changedFiles,
      apply: true,
    });
    flagged = result.updatedCount;
  }

  await writeWatermark(projectRoot, current);
  return { checked: true, flagged, sinceCommit: watermark };
}

/** Hooks must never fail the host: any error reads as "no drift information this session". */
export async function runAutoDriftCheckBestEffort(projectId: string, projectRoot: string): Promise<AutoDriftResult | null> {
  try {
    return await runAutoDriftCheck(projectId, projectRoot);
  } catch {
    return null;
  }
}

async function writeWatermark(projectRoot: string, commit: string): Promise<void> {
  await getClient().execute({
    sql: `INSERT INTO drift_state (project_root, last_checked_commit, checked_at) VALUES (?, ?, ?)
          ON CONFLICT(project_root) DO UPDATE SET last_checked_commit = excluded.last_checked_commit, checked_at = excluded.checked_at`,
    args: [projectRoot, commit, new Date().toISOString()],
  });
}

/**
 * The one-line session-start warning. Rendered here so the hook path and any future
 * surface (doctor, status) say it the same way.
 */
export function describeAutoDrift(result: AutoDriftResult | null): string | undefined {
  if (!result || result.flagged === 0) return undefined;
  const shortCommit = result.sinceCommit ? result.sinceCommit.slice(0, 7) : 'last check';
  return `DRIFT: ${result.flagged} knowledge item(s) touch files changed since ${shortCommit} and were marked needs_review — verify before relying on them.`;
}
