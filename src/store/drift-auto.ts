import { getClient } from './database.js';
import { checkKnowledgeDrift, getCurrentGitCommit, listChangedFilesSince } from './drift.js';

export type AutoDriftResult = {
  /** False on the run that only learns the baseline; nothing was compared. */
  checked: boolean;
  /** Items whose files changed since the watermark. Detection only — nothing is flipped. */
  candidateCount: number;
  /** Up to the first few candidate titles, for the session-start warning. */
  candidateTitles: string[];
  /** The watermark the diff ran from; absent when nothing was compared. */
  sinceCommit?: string;
};

const WARNING_TITLE_LIMIT = 3;

/**
 * The drift check that `pr check` runs by hand, run automatically at session start —
 * as DETECTION ONLY.
 *
 * `checkKnowledgeDrift` has existed since the pr command shipped, but its only caller was
 * a command someone had to remember to type, so in practice knowledge went stale exactly
 * as if the check did not exist. The session boundary is the right chokepoint: it is the
 * moment before an agent starts relying on memory.
 *
 * Why detection does not auto-apply: measured on a real, documentation-heavy repository,
 * one commit window matched 36 of 301 atoms and fifteen windows matched a third of the
 * store — atoms annotate hot files, hot files change every day, and an automatic flip
 * would hold those atoms at needs_review permanently. Run by hand after a PR, that flag
 * volume is a review worklist; applied silently at every session start, it is corpus-wide
 * ranking damage and a warning that cries wolf. So the automatic path names what moved
 * and the exact command to review it, and flipping freshness stays a deliberate act.
 *
 * The watermark is the last git commit a check ran against, keyed by project root.
 * rowid-style head tracking (change-watermark.ts) does not work here: the thing that
 * moves is the git history, not the knowledge log. It advances even when candidates go
 * unreviewed — the warning carries the pinned `pr check --since` command for acting
 * later, and repeating the same warning forever would punish exactly the sessions that
 * cannot deal with it yet.
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

  if (watermark === current) return { checked: true, candidateCount: 0, candidateTitles: [], sinceCommit: watermark };

  // First run learns the baseline and reports nothing: diffing from the repository's
  // root commit would announce most of the store as drift candidates in one wall.
  if (!watermark) {
    await writeWatermark(projectRoot, current);
    return { checked: false, candidateCount: 0, candidateTitles: [] };
  }

  let changedFiles: string[];
  try {
    changedFiles = listChangedFilesSince(projectRoot, watermark, current);
  } catch {
    // The watermark commit no longer exists — rebase, aggressive gc, a rewritten branch.
    // Re-baseline rather than guess; the next real change is caught from the new baseline.
    await writeWatermark(projectRoot, current);
    return { checked: false, candidateCount: 0, candidateTitles: [] };
  }

  let candidateCount = 0;
  let candidateTitles: string[] = [];
  if (changedFiles.length > 0) {
    const result = await checkKnowledgeDrift(projectId, {
      sinceCommit: watermark,
      currentCommit: current,
      changedFiles,
      apply: false,
    });
    candidateCount = result.candidates.length;
    candidateTitles = result.candidates.slice(0, WARNING_TITLE_LIMIT).map(candidate => candidate.title);
  }

  await writeWatermark(projectRoot, current);
  return { checked: true, candidateCount, candidateTitles, sinceCommit: watermark };
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
 * The session-start warning. Rendered here so the hook path and any future surface
 * (doctor, status) say it the same way. Carries the pinned review command because the
 * watermark has already advanced: this line is the only record of the window.
 */
export function describeAutoDrift(result: AutoDriftResult | null): string | undefined {
  if (!result || result.candidateCount === 0) return undefined;
  const names = result.candidateTitles.length > 0
    ? ` (${result.candidateTitles.map(title => `"${title}"`).join(', ')}${result.candidateCount > result.candidateTitles.length ? ', …' : ''})`
    : '';
  const since = result.sinceCommit ? ` --since ${result.sinceCommit.slice(0, 12)}` : '';
  return `DRIFT: ${result.candidateCount} knowledge item(s) reference files changed since the last session${names}. Verify before relying on them; review and apply with \`knowl pr check${since}\`.`;
}
