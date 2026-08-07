/**
 * Does low `supersedes` / `provenance` compliance actually cost anything?
 *
 * The agent-surface study measured 752 real knowl_store calls: `supersedes` supplied on 3.5%,
 * `provenance` on 9.8%. Those look like alarming compliance gaps. Whether they are depends on
 * what the write path and the ranker do when the fields are absent, which is what this measures
 * against the live store rather than against intuition.
 *
 * Usage: npx tsx scripts/diagnose-write-compliance.ts
 */
import { findProjectRoot } from '../src/core/config.js';
import { closeDb, initDb } from '../src/store/database.js';
import { getProjectByRootPath } from '../src/store/repository.js';
import { queryKnowledgeBase } from '../src/store/queries.js';

const root = await findProjectRoot(process.cwd());
await initDb(root);
const project = await getProjectByRootPath(root);
if (!project) throw new Error('Project not found in database.');

const active = await queryKnowledgeBase(project.id, { status: 'active', limit: 100_000 });
const superseded = await queryKnowledgeBase(project.id, { status: 'superseded', limit: 100_000 });

console.log(`active:     ${active.length}`);
console.log(`superseded: ${superseded.length}`);
const total = active.length + superseded.length;
console.log(`supersession fired on ${(superseded.length / total * 100).toFixed(1)}% of all items written\n`);

/**
 * The comparison that settles it. Explicit `supersedes` was supplied on 3.5% of writes. If the
 * share of items actually retired is far above that, the retiring is being done by the write
 * path's own title-subset inference and the caller's field is close to decoration.
 */
const EXPLICIT_SUPERSEDES_RATE = 0.035;
const observed = superseded.length / total;
console.log(`explicit supersedes supplied on:  ${(EXPLICIT_SUPERSEDES_RATE * 100).toFixed(1)}% of writes`);
console.log(`items actually retired:           ${(observed * 100).toFixed(1)}%`);
console.log(
  observed > EXPLICIT_SUPERSEDES_RATE * 2
    ? `=> inference is doing the work, roughly ${(observed / EXPLICIT_SUPERSEDES_RATE).toFixed(1)}x what callers ask for.`
    : '=> retirement tracks caller-supplied ids; the compliance gap is real.',
);

const provenanceCounts: Record<string, number> = {};
for (const item of active) {
  provenanceCounts[(item as any).provenance ?? '(unset)'] = (provenanceCounts[(item as any).provenance ?? '(unset)'] ?? 0) + 1;
}
console.log('\nprovenance on active items:');
for (const [value, count] of Object.entries(provenanceCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${value.padEnd(12)} ${String(count).padStart(4)}  ${(count / active.length * 100).toFixed(1)}%`);
}

/**
 * `scoreCandidates` applies PROVENANCE_INFERRED_PRIOR only when provenance === 'inferred'.
 * Unset takes the same multiplier as 'observed' and 'user_stated', so omitting the field is
 * scored identically to claiming first-hand evidence.
 */
const inferred = provenanceCounts['inferred'] ?? 0;
const unset = provenanceCounts['(unset)'] ?? 0;
console.log(`\nitems the provenance prior can demote: ${inferred} of ${active.length} (${(inferred / active.length * 100).toFixed(1)}%)`);
console.log(`items scored as if first-hand by default: ${unset} (${(unset / active.length * 100).toFixed(1)}%)`);
console.log('Omitting provenance takes the same prior as "observed", so the field only ever costs');
console.log('the writer who marks "inferred" honestly. Non-compliance is not merely tolerated, it');
console.log('is rewarded, which is why asking for it more loudly would not raise it.');

await closeDb();
