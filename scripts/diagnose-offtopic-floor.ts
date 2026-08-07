/**
 * The check the eval suites structurally cannot perform.
 *
 * A ranking change that lifts scores can push an off-topic query over MIN_VECTOR_RELEVANCE, so
 * the store answers a question it has nothing to say about. No suite sees this: every suite case
 * has a correct answer, so none of them asks "should this have returned anything at all". The
 * recorded precedent is BM25_LEXICAL_WEIGHT, where 8.0 beat 3.0 on every suite metric and broke
 * the floor on one of six off-topic probes.
 *
 * Run against the real store, before and after any scoring change.
 *
 * Usage: npx tsx scripts/diagnose-offtopic-floor.ts
 */
import { findProjectRoot, loadConfig } from '../src/core/config.js';
import { createLocalEmbeddingProvider, isVectorSearchEnabled } from '../src/ai/embeddings.js';
import { closeDb, initDb } from '../src/store/database.js';
import { getProjectByRootPath } from '../src/store/repository.js';
import { rankKnowledge } from '../src/store/agent-query.js';

/** Nothing in a project-memory store should answer any of these. */
const OFF_TOPIC = [
  'best hiking trails in patagonia',
  'how to make sourdough starter',
  'premier league fixtures this weekend',
  'symptoms of vitamin d deficiency',
  'cheapest flights to reykjavik',
  'who won the 1998 world cup',
];

/** Real questions this store genuinely can answer. These must keep answering. */
const ON_TOPIC = [
  'supersession retires the predecessor at write time',
  'embedding profile fingerprint provider model dtype pooling',
  'memoryagentbench conflict resolution benchmark',
  'relevance floor per model calibration',
  'knowl eval retrieval vector fixtures',
  'transcript search opt in off by default',
];

const root = await findProjectRoot(process.cwd());
const config = await loadConfig(root);
if (!isVectorSearchEnabled(config)) throw new Error('Vector search is not enabled.');
const embedder = await createLocalEmbeddingProvider(config, root);
await initDb(root);
const project = await getProjectByRootPath(root);
if (!project) throw new Error('Project not found in database.');

async function probe(query: string) {
  const items = await rankKnowledge(project!.id, {
    query,
    status: 'active',
    limit: 3,
    vector: {
      enabled: true,
      profileFingerprint: embedder.profileFingerprint,
      embedding: await embedder.embedQuery(query),
      relevanceFloor: embedder.relevanceFloor,
    },
  });
  const top: any = items[0];
  return { count: items.length, top: top ? Number(top.explanation?.finalScore ?? 0) : 0 };
}

console.log(`floor for this model: ${embedder.relevanceFloor}\n`);

let answeredOffTopic = 0;
console.log('OFF-TOPIC (want 0 results each):');
for (const query of OFF_TOPIC) {
  const { count, top } = await probe(query);
  if (count > 0) answeredOffTopic++;
  console.log(`  ${count > 0 ? 'ANSWERED' : 'silent  '}  n=${count} top=${top.toFixed(4)}  "${query}"`);
}

let silentOnTopic = 0;
console.log('\nON-TOPIC (want results each):');
for (const query of ON_TOPIC) {
  const { count, top } = await probe(query);
  if (count === 0) silentOnTopic++;
  console.log(`  ${count === 0 ? 'SILENT  ' : 'answered'}  n=${count} top=${top.toFixed(4)}  "${query}"`);
}

console.log(`\noff-topic answered: ${answeredOffTopic}/${OFF_TOPIC.length} (want 0)`);
console.log(`on-topic silent:    ${silentOnTopic}/${ON_TOPIC.length} (want 0)`);
console.log(answeredOffTopic === 0 && silentOnTopic === 0 ? 'FLOOR HOLDS' : 'FLOOR REGRESSED');

await closeDb();
