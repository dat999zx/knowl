import { getClient } from './database.js';
import { checkKnowledgeDrift, getCurrentGitCommit, listChangedFilesSince, listRenamedPathsSince } from './drift.js';

export type AutoDriftResult = {
  /** False on the run that only learns the baseline; nothing was compared. */
  checked: boolean;
  /** Items whose cited files moved since the watermark and survived classification. Each is
   *  flipped to `needs_review` and stamped with `last_drift_at`; see `apply: true` below. */
  candidateCount: number;
  /** Up to the first few candidate titles, for the session-start warning. */
  candidateTitles: string[];
  /** The watermark the diff ran from; absent when nothing was compared. */
  sinceCommit?: string;
};

const WARNING_TITLE_LIMIT = 3;

/**
 * The drift check that `pr check` runs by hand, run automatically at session start.
 *
 * `checkKnowledgeDrift` has existed since the pr command shipped, but its only caller was
 * a command someone had to remember to type, so in practice knowledge went stale exactly
 * as if the check did not exist. The session boundary is the right chokepoint: it is the
 * moment before an agent starts relying on memory.
 *
 * **This was detection-only until 2026-08-13, and that was right for the signal that existed.**
 * Measured on a documentation-heavy repository, one commit window matched 36 of 301 atoms and
 * fifteen windows matched a third of the store — atoms annotate hot files, hot files change
 * every day, and an automatic flip would have held those atoms at needs_review permanently.
 *
 * What changed is the signal, not the appetite for risk. A file being edited no longer counts;
 * only a cited path that is gone does, and a path that a rename merely moved does not count
 * either. On the same store that produced 339 observations, the classified rule leaves 44 —
 * and auditing those found 30 were renames from one refactor, which is why `renamedFrom` is
 * passed below rather than left to existence checks. What remains is small enough that a 6%
 * ranking prior on it is a worklist rather than corpus-wide damage.
 *
 * `last_drift_at` is still stamped per candidate (see `recordDriftObservation`). Nothing reads
 * that column at retrieval time, so it remains the cheap record a later pass can act on.
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
      /**
       * Marks survivors `needs_review`, where this was detection-only until 2026-08-13.
       *
       * The old refusal was correct for the old signal: flipping freshness was measured as
       * corpus-wide ranking damage, because 339 of 867 active items qualified. The damage was
       * breadth, not depth -- the prior is a 6% nudge (`FRESHNESS_PRIOR.needs_review = 0.94`),
       * which is only destructive when it lands on 39% of the corpus. Replayed against the same
       * store, the classified rule leaves 44 before renames are excluded, about 5%.
       *
       * A signal nothing acts on is the state this whole change exists to leave.
       */
      apply: true,
      // The tree, for removal-vs-edit classification only -- `includeUntracked` is deliberately
      // not set, so this keeps its git-only scope. Without a root nothing can be classified and
      // every edited file reports as drift, which is what made this path produce 339 unread
      // observations against 42 real ones on this repo's own store.
      projectRoot,
      // Without this a refactor reads as a mass deletion: auditing the first cut found 30 of 44
      // survivors were one move of `src/store/` files into `src/session/`, every atom still true.
      renamedFrom: listRenamedPathsSince(projectRoot, watermark, current),
    });
    candidateCount = result.candidates.length;
    candidateTitles = result.candidates.slice(0, WARNING_TITLE_LIMIT).map(candidate => candidate.title);
    await recordDriftObservation(result.candidates.map(candidate => candidate.itemId));
  }

  await writeWatermark(projectRoot, current);
  return { checked: true, candidateCount, candidateTitles, sinceCommit: watermark };
}

/** Ids per `UPDATE`, so one window cannot outgrow the driver's bound-parameter limit. */
const DRIFT_STAMP_CHUNK = 250;

/**
 * Record that these items' files moved, so a later pass can still tell.
 *
 * This is what the check leaves behind besides the `needs_review` flip, and it is why the
 * watermark advancing is survivable. `last_drift_at` is a separate column nothing reads at
 * retrieval time, so the stamp itself costs no further ranking and no warning volume beyond
 * what the flip already does. Without it the only trace of a window is the one warning
 * line, and the very next session — which finds `watermark === current` and computes no
 * candidates at all — has no way to know that an item reading `fresh` is a claim about files
 * that changed this morning and that nobody has looked at since.
 *
 * Chunked because a single window can match a third of the store, and the candidate list is
 * bound by the corpus rather than by anything this function controls.
 */
async function recordDriftObservation(itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) return;
  const now = new Date().toISOString();
  const client = getClient();
  for (let start = 0; start < itemIds.length; start += DRIFT_STAMP_CHUNK) {
    const chunk = itemIds.slice(start, start + DRIFT_STAMP_CHUNK);
    await client.execute({
      sql: `UPDATE knowledge_items SET last_drift_at = ? WHERE id IN (${chunk.map(() => '?').join(', ')})`,
      args: [now, ...chunk],
    });
  }
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
  return `DRIFT: ${result.candidateCount} knowledge item(s) reference files changed since the last session${names}. Verify before relying on them; review and apply with \`knowl pr${since}\`.`;
}
