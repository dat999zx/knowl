/**
 * What the new rule would say about the observations the old one produced.
 *
 * Read-only. Replays the real store's currently-flagged items through the shipped matcher and
 * classifier, so the noise-reduction claim is measured against production data rather than
 * against fixtures. Run: npx tsx scripts/measure-drift-precision.ts <path-to-repo>
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { normalizePathForKnowledge, sourcePaths } from '../src/store/freshness.js';
import { classifyDriftPaths, isChurnPath } from '../src/store/drift.js';

const repoRoot = process.argv[2];
if (!repoRoot) throw new Error('usage: measure-drift-precision.ts <path-to-repo>');

/**
 * Every rename in the whole history, as a set of the paths renames moved AWAY from.
 *
 * Production reads renames from the same window diff that produced the changed files. A
 * retrospective replay has no window, so it asks history — and it must ask with a whole-tree diff,
 * because `git log -- <path>` limits the diff to that pathspec and hides the destination, which is
 * exactly what made the first audit of this rule report zero renames when 30 of 44 flagged items
 * were renames.
 */
function renamedPaths(): Set<string> {
  const sources = new Set<string>();
  try {
    const log = execFileSync('git', ['log', '--all', '-M40%', '--diff-filter=R', '--name-status', '--format='],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    for (const line of log.split(/\r?\n/)) {
      const match = /^R\d*\t(.+?)\t(.+)$/.exec(line);
      if (match) sources.add(normalizePathForKnowledge(match[1]));
    }
  } catch {
    // No git, or a repo too large to buffer: report without rename awareness rather than not at all.
  }
  return sources;
}

const renamedFrom = renamedPaths();

const db = createClient({ url: `file:${path.join(repoRoot, '.knowl', 'knowl.db').replace(/\\/g, '/')}` });

const rows = (await db.execute(`
  SELECT id, affected_paths, source, tags
  FROM knowledge_items
  WHERE status='active' AND last_drift_at IS NOT NULL AND freshness='fresh'`)).rows;

const parse = (value: unknown): string[] => {
  try {
    const decoded = JSON.parse(String(value ?? '[]'));
    return Array.isArray(decoded) ? decoded : [];
  } catch {
    return [];
  }
};

let survives = 0;
let droppedNoCitation = 0;
let droppedChurnOnly = 0;
let droppedStillThere = 0;
let droppedMoved = 0;

for (const row of rows) {
  // Exactly what the matcher now considers: affectedPaths plus parsed source paths, no tags.
  const cited = [...parse(row.affected_paths), ...sourcePaths(row.source as string | null)];
  if (cited.length === 0) {
    droppedNoCitation++;
    continue;
  }

  const informative = cited.filter(candidate => !isChurnPath(candidate));
  if (informative.length === 0) {
    droppedChurnOnly++;
    continue;
  }

  const { removed, moved } = classifyDriftPaths(
    informative,
    candidate => existsSync(path.join(repoRoot, candidate)),
    renamedFrom,
  );
  if (removed.length > 0) survives++;
  else if (moved.length > 0) droppedMoved++;
  else droppedStillThere++;
}

const pct = (n: number) => `${((n / rows.length) * 100).toFixed(1)}%`;
console.log(`\nrepo: ${repoRoot}`);
console.log(`observations the OLD rule produced: ${rows.length}`);
console.log(`  survive the new rule (a cited path is gone): ${survives}  (${pct(survives)})`);
console.log(`  dropped -- cited file still exists:          ${droppedStillThere}  (${pct(droppedStillThere)})`);
console.log(`  dropped -- cited file only MOVED:            ${droppedMoved}  (${pct(droppedMoved)})`);
console.log(`  dropped -- cites only churn paths:           ${droppedChurnOnly}  (${pct(droppedChurnOnly)})`);
console.log(`  dropped -- cites nothing once tags are out:  ${droppedNoCitation}  (${pct(droppedNoCitation)})`);
console.log(`\n  noise removed: ${pct(rows.length - survives)} of what was reported before`);
console.log('  (symbol evidence and the untracked opt-in are not replayed here: both survive on');
console.log('   their own and would only add to the surviving count.)');
