/**
 * Per-case diagnostic for a fixture-backed retrieval suite.
 *
 * `knowl eval retrieval` reports pooled and per-tier metrics plus `failedCaseIds`, which says
 * *that* a case failed but not what outranked the answer. This mirrors that command's store
 * setup exactly -- same fixtures, same reindex, same `rankKnowledge` call -- and dumps the
 * ranking for every case so a failure can be attributed.
 *
 * Usage: npx tsx scripts/diagnose-semantic-suite.ts [dataset.json]
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findProjectRoot, loadConfig } from '../src/core/config.js';
import { createLocalEmbeddingProvider, isVectorSearchEnabled } from '../src/ai/embeddings.js';
import { closeDb, initDb } from '../src/store/database.js';
import * as repo from '../src/store/repository.js';
import { rankKnowledge } from '../src/store/agent-query.js';
import { reindexKnowledgeEmbeddings } from '../src/store/vector-index.js';

const datasetPath = path.resolve(process.argv[2] ?? 'docs/evals/semantic-suite.json');

type Fixture = { id: string; category: any; title: string; content: string; tags?: string[] };
type Case = {
  id: string;
  tier?: string;
  query: string;
  expectedItemIds: string[];
  mustNotReturn: string[];
  limit?: number;
};

const dataset = JSON.parse(await fs.readFile(datasetPath, 'utf-8')) as {
  cases: Case[];
  fixtures: Fixture[];
};

// Walk up for the config, exactly as `knowl eval retrieval` does: a git worktree has no
// `.knowl/` of its own, so the embedding profile comes from the checkout above it.
const root = await findProjectRoot(process.cwd());
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-diag-'));
await fs.mkdir(path.join(fixtureRoot, '.knowl'), { recursive: true });
await initDb(fixtureRoot);
const project = await repo.createProject(fixtureRoot, 'Suite diagnostic');

/** fixture id -> real row id, and the reverse so a returned row can be named. */
const toRowId = new Map<string, string>();
const toFixtureId = new Map<string, string>();
const titleOf = new Map<string, string>();
for (const fixture of dataset.fixtures) {
  const item = await repo.createKnowledgeItem(project.id, fixture);
  toRowId.set(fixture.id, item.id);
  toFixtureId.set(item.id, fixture.id);
  titleOf.set(item.id, fixture.title);
}

const config = await loadConfig(root);
if (!isVectorSearchEnabled(config)) throw new Error('Vector search is not enabled.');
const embedder = await createLocalEmbeddingProvider(config, root);
const indexed = await reindexKnowledgeEmbeddings(project.id, embedder);
console.log(`Embedded ${indexed.indexed} fixtures · ${dataset.cases.length} cases\n`);

const rows: Array<{
  id: string;
  tier: string;
  query: string;
  rank: number;
  forbidden: string[];
  top3: string[];
  vectorRank: number | null;
  bm25Rank: number | null;
}> = [];

for (const testCase of dataset.cases) {
  const expected = new Set(testCase.expectedItemIds.map(id => toRowId.get(id) ?? id));
  const banned = new Set(testCase.mustNotReturn.map(id => toRowId.get(id) ?? id));
  const items = await rankKnowledge(project.id, {
    query: testCase.query,
    status: 'active',
    limit: testCase.limit ?? 10,
    vector: {
      enabled: true,
      profileFingerprint: embedder.profileFingerprint,
      embedding: await embedder.embedQuery(testCase.query),
      relevanceFloor: embedder.relevanceFloor,
    },
  });
  const ids = items.map(item => item.id);
  const expectedItem: any = items.find(item => expected.has(item.id));
  rows.push({
    id: testCase.id,
    tier: testCase.tier ?? '-',
    query: testCase.query,
    // 1-indexed position of the expected answer; 0 means it never appeared.
    rank: ids.findIndex(id => expected.has(id)) + 1,
    forbidden: ids.filter(id => banned.has(id)).map(id => toFixtureId.get(id) ?? id),
    top3: ids.slice(0, 3).map(id => `${toFixtureId.get(id) ?? id}`),
    vectorRank: expectedItem?.explanation?.vectorRank ?? null,
    bm25Rank: expectedItem?.explanation?.bm25Rank ?? null,
  });
}

const notFirst = rows.filter(r => r.rank !== 1);
const withForbidden = rows.filter(r => r.forbidden.length > 0);

console.log(`=== ${notFirst.length} cases where the expected answer is not rank 1 ===`);
for (const r of notFirst) {
  console.log(
    `[${r.tier.padEnd(8)}] ${r.id.padEnd(22)} rank=${r.rank === 0 ? 'ABSENT' : r.rank}  "${r.query}"\n` +
    `${' '.repeat(12)}top3: ${r.top3.join(' > ')}`,
  );
}

console.log(`\n=== ${withForbidden.length} cases returning a forbidden item ===`);
for (const r of withForbidden) {
  console.log(
    `[${r.tier.padEnd(8)}] ${r.id.padEnd(22)} rank=${r.rank === 0 ? 'ABSENT' : r.rank}  forbidden: ${r.forbidden.join(', ')}\n` +
    `${' '.repeat(12)}"${r.query}"  top3: ${r.top3.join(' > ')}`,
  );
}

/**
 * Score forensics for the worst cases.
 *
 * The question a rank alone cannot answer: did the embedding fail to find the item, or did it
 * find it and fusion bury it? `vectorRank` and `bm25Rank` separate those. A good vectorRank
 * beside a bad final position is a fusion problem and fixable in the ranker; a bad vectorRank
 * is the embedding model and is not.
 */
const WORST = [
  'alerting-pager-x1', 'migrations-forward-m1', 'cdn-assets-m1', 'soft-delete-x1', 'hard-purge-m1',
];
console.log('\n=== score forensics for the worst cases ===');
for (const caseId of WORST) {
  const testCase = dataset.cases.find(c => c.id === caseId);
  if (!testCase) continue;
  const expectedRows = new Set(testCase.expectedItemIds.map(id => toRowId.get(id) ?? id));
  const explained = await rankKnowledge(project.id, {
    query: testCase.query,
    status: 'active',
    limit: testCase.limit ?? 10,
    vector: {
      enabled: true,
      profileFingerprint: embedder.profileFingerprint,
      embedding: await embedder.embedQuery(testCase.query),
      relevanceFloor: embedder.relevanceFloor,
    },
  });
  console.log(`\n${caseId}  "${testCase.query}"`);
  explained.forEach((item: any, index: number) => {
    const mark = expectedRows.has(item.id) ? ' <-- EXPECTED' : '';
    const e = item.explanation;
    console.log(
      `  ${String(index + 1).padStart(2)}. ${(toFixtureId.get(item.id) ?? item.id).padEnd(22)}` +
      ` score=${Number(e.finalScore).toFixed(4)}` +
      ` bm25Rank=${e.bm25Rank ?? '-'}`.padEnd(16) +
      ` vectorRank=${e.vectorRank ?? '-'}`.padEnd(17) + mark,
    );
  });
}

const byTier: Record<string, { n: number; first: number; absent: number }> = {};
for (const r of rows) {
  const t = (byTier[r.tier] ??= { n: 0, first: 0, absent: 0 });
  t.n++;
  if (r.rank === 1) t.first++;
  if (r.rank === 0) t.absent++;
}
/**
 * The claim under test: fusion demotes items the embedding ranked well, because *having* a BM25
 * match outweighs *being* the best vector hit. If true, the fix is in the ranker, not the model.
 */
const found = rows.filter(r => r.rank > 0);
const vectorNailedIt = found.filter(r => r.vectorRank !== null && r.vectorRank <= 3);
const buried = vectorNailedIt.filter(r => r.rank > 3);
const buriedNoBm25 = buried.filter(r => r.bm25Rank === null);
console.log('\n=== does fusion bury good vector hits? ===');
console.log(`cases where the answer was a top-3 vector hit:      ${vectorNailedIt.length}`);
console.log(`  ...but finished outside the top 3 overall:        ${buried.length}`);
console.log(`  ...and of those, had NO bm25 match at all:        ${buriedNoBm25.length}`);
for (const r of buried) {
  console.log(`    ${r.id.padEnd(22)} vectorRank=${r.vectorRank} bm25Rank=${r.bm25Rank ?? '-'} -> final ${r.rank}`);
}

const vectorBest = found.filter(r => r.vectorRank === 1);
const vectorBestLost = vectorBest.filter(r => r.rank !== 1);
const lostNoBm25 = vectorBestLost.filter(r => r.bm25Rank === null);
console.log(`\nanswer was the #1 vector hit:                        ${vectorBest.length}`);
console.log(`  ...but did not finish #1 overall:                 ${vectorBestLost.length}`);
console.log(`  ...and of those, had NO bm25 match:               ${lostNoBm25.length}`);
const rank1 = found.filter(r => r.rank === 1).length;
console.log(`\nvector alone would put ${vectorBest.length}/110 first; fusion delivers ${rank1}/110.`);

console.log('\n=== per tier ===');
for (const [tier, t] of Object.entries(byTier)) {
  console.log(`${tier.padEnd(9)} n=${String(t.n).padStart(3)} rank1=${t.first} absent=${t.absent}`);
}

await closeDb();
await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
