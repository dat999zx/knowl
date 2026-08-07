/**
 * What floor value, if any, separates real questions from junk on THIS store?
 *
 * The shipped per-model floors were fitted against a 50-fixture corpus. This reports the raw
 * best-cosine the floor actually tests, for on-topic and off-topic queries, against the live
 * store -- so the question "is 0.76 too high, would 0.3 be better" is answered with the two
 * distributions rather than with intuition about what a cosine ought to look like.
 *
 * Usage: npx tsx scripts/diagnose-floor-threshold.ts
 */
import { findProjectRoot, loadConfig } from '../src/core/config.js';
import { createLocalEmbeddingProvider } from '../src/ai/embeddings.js';
import { closeDb, initDb } from '../src/store/database.js';
import { getProjectByRootPath } from '../src/store/repository.js';
import { searchKnowledgeEmbeddings } from '../src/store/vector.js';

const OFF_TOPIC = [
  'best hiking trails in patagonia',
  'how to make sourdough starter',
  'premier league fixtures this weekend',
  'symptoms of vitamin d deficiency',
  'cheapest flights to reykjavik',
  'who won the 1998 world cup',
  'recipe for lemon drizzle cake',
  'when did the roman empire fall',
];

const ON_TOPIC = [
  'supersession retires the predecessor at write time',
  'embedding profile fingerprint provider model dtype pooling',
  'memoryagentbench conflict resolution benchmark',
  'relevance floor per model calibration',
  'knowl eval retrieval vector fixtures',
  'transcript search opt in off by default',
  'what does knowl store about a decision',
  'how are stale atoms handled',
];

const root = await findProjectRoot(process.cwd());
const config = await loadConfig(root);
const embedder = await createLocalEmbeddingProvider(config, root);
await initDb(root);
const project = await getProjectByRootPath(root);
if (!project) throw new Error('Project not found in database.');

async function bestCosine(query: string): Promise<number> {
  const hits = await searchKnowledgeEmbeddings(project!.id, {
    vector: await embedder.embedQuery(query),
    status: 'active',
    profileFingerprint: embedder.profileFingerprint,
    limit: 1,
  } as any);
  const top: any = hits[0];
  if (!top) return 0;
  // Whatever the row calls it, the floor compares a similarity in [0,1].
  return Number(top.score ?? top.similarity ?? (top.distance !== undefined ? 1 - top.distance : 0));
}

const off: number[] = [];
const on: number[] = [];
console.log(`model floor as shipped: ${embedder.relevanceFloor}\n`);
console.log('OFF-TOPIC best cosine:');
for (const q of OFF_TOPIC) {
  const c = await bestCosine(q);
  off.push(c);
  console.log(`  ${c.toFixed(4)}  "${q}"`);
}
console.log('\nON-TOPIC best cosine:');
for (const q of ON_TOPIC) {
  const c = await bestCosine(q);
  on.push(c);
  console.log(`  ${c.toFixed(4)}  "${q}"`);
}

const offMax = Math.max(...off);
const onMin = Math.min(...on);
console.log(`\noff-topic highest: ${offMax.toFixed(4)}`);
console.log(`on-topic lowest:   ${onMin.toFixed(4)}`);
console.log(
  onMin > offMax
    ? `=> separable. Any floor between ${offMax.toFixed(4)} and ${onMin.toFixed(4)} works.`
    : `=> NOT separable. Junk scores as high as ${offMax.toFixed(4)} while a real question scores as low as ${onMin.toFixed(4)}, so no single number can split them: every floor either answers junk or silences real questions.`,
);

await closeDb();
