import path from 'node:path';
import { closeDb, initDb } from '../store/database.js';
import { createSnapshot } from '../store/snapshots.js';
import { applyDoctorRemedies } from './doctor-fix.js';
import { runDoctor } from './doctor-report.js';
import { upgradeExistingRepository } from './upgrade.js';

export type SweepOptions = {
  /** Re-embed unembedded items. Off by default: the cost scales with each store's size. */
  reindex?: boolean;
  /** Snapshot each repository before touching it. On by default. */
  snapshot?: boolean;
};

export type RepoSweepResult = {
  root: string;
  ready: boolean;
  claimedItems: number;
  applied: string[];
  deferred: string[];
  failed: Array<{ remedy: string; error: string }>;
  /** Findings with no automatic repair, still present after the sweep. */
  unfixable: string[];
  /** Everything still not OK after the repairs, as printed lines. */
  warnings: string[];
  /** Set when the repository could not be swept at all. */
  error?: string;
};

async function sweepOne(root: string, options: SweepOptions): Promise<RepoSweepResult> {
  const result: RepoSweepResult = {
    root, ready: false, claimedItems: 0, applied: [], deferred: [], failed: [], unfixable: [], warnings: [],
  };

  // Before anything is changed: `upgrade` runs schema migrations, and a snapshot is a file
  // copy of a database that is almost always small.
  if (options.snapshot !== false) {
    await initDb(root);
    try {
      await createSnapshot(root);
    } finally {
      await closeDb();
    }
  }

  const upgraded = await upgradeExistingRepository(root, path.basename(root) || 'My Project');
  result.claimedItems = upgraded.claimedItems;

  const diagnosed = await runDoctor(root);
  const fixes = await applyDoctorRemedies(root, diagnosed.checks, { reindex: options.reindex });
  result.applied = fixes.applied;
  result.deferred = fixes.deferred;
  result.failed = fixes.failed;

  // Re-run rather than assuming the repairs worked. A remedy that reported success without
  // actually resolving its finding is exactly the failure a sweep must not hide.
  const verified = await runDoctor(root);
  result.ready = verified.ready;
  result.warnings = verified.checks
    .filter(check => check.status !== 'OK')
    .map(check => `[${check.status}] ${check.message}`);
  result.unfixable = verified.checks
    .filter(check => check.status !== 'OK' && !check.remedy)
    .map(check => check.message);

  return result;
}

/**
 * Upgrade and repair a list of repositories, one after another.
 *
 * Sequential and in-process. Sequential because two repositories sharing one process would
 * interleave database connections that are keyed by path but opened globally; in-process
 * because the alternative is spawning the CLI per repository and reading its results back out
 * of printed text, which is the fragility this command exists to remove.
 *
 * A repository that throws is recorded and the sweep continues. One broken checkout must not
 * decide that the other three go un-upgraded -- that is the entire reason to have this rather
 * than a shell loop that stops on the first error.
 */
export async function sweepRepos(roots: string[], options: SweepOptions): Promise<RepoSweepResult[]> {
  const results: RepoSweepResult[] = [];

  for (const root of roots) {
    try {
      results.push(await sweepOne(root, options));
    } catch (error: any) {
      results.push({
        root, ready: false, claimedItems: 0, applied: [], deferred: [], failed: [], unfixable: [], warnings: [],
        error: error?.message ?? String(error),
      });
      // The failing repository may have left a connection open, and the next repository's
      // `initDb` would then be handed it.
      await closeDb().catch(() => {});
    }
  }

  return results;
}

function summarize(result: RepoSweepResult): string {
  if (result.error) return `failed: ${result.error}`;

  const parts: string[] = [];
  if (result.claimedItems > 0) parts.push(`claimed ${result.claimedItems}`);
  if (result.applied.length > 0) parts.push(`fixed ${result.applied.join(', ')}`);
  if (result.deferred.length > 0) parts.push(`deferred ${result.deferred.join(', ')}`);
  if (result.failed.length > 0) parts.push(`could not fix ${result.failed.map(entry => entry.remedy).join(', ')}`);
  return parts.length > 0 ? parts.join('; ') : 'no changes needed';
}

/**
 * The sweep's report.
 *
 * Everything a repository did is on its own lines, and everything still wrong is repeated at
 * the end with the command to investigate it. A deferred repair is listed rather than
 * dropped: the user chose not to run it, which is not the same as it not being needed.
 */
export function formatSweepReport(results: RepoSweepResult[]): string {
  const lines = ['KNOWL SWEEP', ''];

  for (const result of results) {
    lines.push(`${result.ready ? 'READY    ' : 'NOT READY'}  ${path.basename(result.root)}  (${result.root})`);
    lines.push(`           ${summarize(result)}`);
    for (const warning of result.warnings) lines.push(`           ${warning}`);
    for (const failure of result.failed) lines.push(`           ${failure.remedy} failed: ${failure.error}`);
    lines.push('');
  }

  const ready = results.filter(result => result.ready);
  lines.push(`${ready.length} of ${results.length} repositor${results.length === 1 ? 'y' : 'ies'} ready.`);

  const attention = results.filter(result => !result.ready);
  if (attention.length > 0) {
    lines.push('');
    lines.push('Still needing attention:');
    for (const result of attention) lines.push(`  cd "${result.root}" && knowl doctor`);
  }

  return lines.join('\n');
}
