/**
 * What the new rule would say about the observations the old one produced.
 *
 * Read-only. Replays the real store's currently-flagged items through the shipped matcher and
 * classifier, so the noise-reduction claim is measured against production data rather than
 * against fixtures. Run: npx tsx scripts/measure-drift-precision.ts <path-to-repo>
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { sourcePaths } from '../src/store/freshness.js';
import { classifyDriftPaths, isChurnPath } from '../src/store/drift.js';

const repoRoot = process.argv[2];
if (!repoRoot) throw new Error('usage: measure-drift-precision.ts <path-to-repo>');

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

  const { removed } = classifyDriftPaths(informative, candidate => existsSync(path.join(repoRoot, candidate)));
  if (removed.length > 0) survives++;
  else droppedStillThere++;
}

const pct = (n: number) => `${((n / rows.length) * 100).toFixed(1)}%`;
console.log(`\nrepo: ${repoRoot}`);
console.log(`observations the OLD rule produced: ${rows.length}`);
console.log(`  survive the new rule (a cited path is gone): ${survives}  (${pct(survives)})`);
console.log(`  dropped -- cited file still exists:          ${droppedStillThere}  (${pct(droppedStillThere)})`);
console.log(`  dropped -- cites only churn paths:           ${droppedChurnOnly}  (${pct(droppedChurnOnly)})`);
console.log(`  dropped -- cites nothing once tags are out:  ${droppedNoCitation}  (${pct(droppedNoCitation)})`);
console.log(`\n  noise removed: ${pct(rows.length - survives)} of what was reported before`);
console.log('  (symbol evidence and the untracked opt-in are not replayed here: both survive on');
console.log('   their own and would only add to the surviving count.)');
