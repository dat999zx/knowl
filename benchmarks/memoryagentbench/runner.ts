import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/core/config.js';
import { resolveVectorProfile, type VectorProfile } from '../../src/core/vector-profile.js';
import { createLocalEmbeddingProvider, isVectorSearchEnabled } from '../../src/ai/embeddings.js';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { queryKnowledgeForAgent } from '../../src/store/agent-query.js';
import { queryKnowledgeBase } from '../../src/store/queries.js';
import { reindexKnowledgeEmbeddings } from '../../src/store/vector-index.js';
import {
  buildSupersededValues,
  conflictGroups,
  parseFacts,
  scoreCr,
  type CrCaseResult,
  type CrInstance,
  type CrReport,
} from './facts.js';

export type CrRunOptions = {
  instancePath: string;
  projectRoot: string;
  topK: number;
  vector: boolean;
  /**
   * When false, facts are inserted with the raw repository call so nothing is ever retired and
   * both the old and new value stay active. This is the ablation that isolates what supersession
   * contributes: same corpus, same retrieval, governance switched off.
   */
  supersede: boolean;
  questionLimit?: number;
  onProgress?: (progress: { completed: number; total: number }) => void;
};

export type CrRunResult = {
  instance: string;
  timestamp: string;
  retrieval: 'vector+bm25' | 'bm25';
  /**
   * The embedding profile the vector arm actually ran on, or null for a bm25-only run.
   *
   * Recorded because a result was otherwise distinguishable only by `timestamp`: the default
   * preset moved from minilm-l6-en to granite-small-en-r2 on 2026-08-02, which shifted cr-sh-6k
   * top-1 from 96% to 98%, and the checked-in 32k/64k runs predate it. Subtracting one preset's
   * number from another's is exactly the mistake this file's README warns about for filenames.
   */
  embedding: VectorProfile | null;
  supersede: boolean;
  topK: number;
  facts: number;
  conflictGroups: number;
  supersededAtWrite: number;
  activeAfterIngest: number;
  report: CrReport;
  cases: CrCaseResult[];
};

// Benchmark facts are public trivia; the secret detector fires on ordinary proper nouns and a
// rejected write would silently remove a candidate. Field length is raised for the same reason
// the ceiling exists at all -- truncating a fact would delete the value under test.
const BENCHMARK_VALIDATION = { rejectSecrets: false, maxFieldLength: 100_000 };

async function removeWithRetry(target: string, attempts = 8): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return true;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  return false;
}

export async function runConflictResolution(options: CrRunOptions): Promise<CrRunResult> {
  const instance = JSON.parse(await fs.readFile(options.instancePath, 'utf-8')) as CrInstance;
  const facts = parseFacts(instance.context);
  const groups = conflictGroups(facts);
  const superseded = buildSupersededValues(facts);

  let embedder: Awaited<ReturnType<typeof createLocalEmbeddingProvider>> | null = null;
  let embedding: VectorProfile | null = null;
  if (options.vector) {
    const config = await loadConfig(options.projectRoot);
    if (!isVectorSearchEnabled(config)) {
      throw new Error('Vector search is not enabled. Set search.vector.enabled true, or pass --no-vector.');
    }
    embedding = resolveVectorProfile(config);
    embedder = await createLocalEmbeddingProvider(config, options.projectRoot);
  }

  const storeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-mab-'));
  try {
    await fs.mkdir(path.join(storeRoot, '.knowl'), { recursive: true });
    await initDb(storeRoot);
    const project = await repo.createProject(storeRoot, 'MemoryAgentBench CR');

    // Ingest in context order. Recency comes from that order alone -- nothing tells the store
    // which fact is an update, which is the whole point of the track.
    let supersededAtWrite = 0;
    for (const fact of facts) {
      if (!options.supersede) {
        await repo.createKnowledgeItem(
          project.id,
          { category: 'fact', title: fact.key, content: fact.text },
          undefined,
          undefined,
          BENCHMARK_VALIDATION,
        );
        continue;
      }
      const result = await storeKnowledgeItemDeduped(
        project.id,
        { category: 'fact', title: fact.key, content: fact.text },
        undefined,
        BENCHMARK_VALIDATION,
      );
      if (result.superseded) supersededAtWrite++;
    }

    if (embedder) await reindexKnowledgeEmbeddings(project.id, embedder);

    // Active count after ingest is the clearest signal that supersession happened: with every
    // conflicting pair resolved, this lands at (facts - superseded), not at (facts).
    const activeAfterIngest = (await queryKnowledgeBase(project.id, { status: 'active', limit: 100_000 })).length;

    const questions = options.questionLimit
      ? instance.questions.slice(0, options.questionLimit)
      : instance.questions;

    const cases: CrCaseResult[] = [];
    for (const [index, question] of questions.entries()) {
      const startedAt = Date.now();
      const vector = embedder
        ? {
            enabled: true,
            // Required by RankOptions since the embedding-profile guard landed: rows written
            // under a different model, dtype or pooling are in a different space and must be
            // excluded. Without it every run of this benchmark died on `undefined cannot be
            // passed as argument to the database`, which is why the newest recorded result
            // here is 2.8.0. `provider` and `model` were never read by the ranker.
            profileFingerprint: embedder.profileFingerprint,
            embedding: (await embedder.embed([question]))[0],
          }
        : undefined;
      const items = await queryKnowledgeForAgent(project.id, {
        query: question,
        status: 'active',
        surface: 'bench_mab_cr',
        limit: options.topK,
        vector,
      });
      cases.push({
        question,
        golds: instance.answers[index] ?? [],
        topContent: items[0]?.content ?? null,
        returnedContents: items.map(item => item.content),
        latencyMs: Date.now() - startedAt,
      });
      options.onProgress?.({ completed: cases.length, total: questions.length });
    }

    return {
      instance: options.instancePath,
      timestamp: new Date().toISOString(),
      retrieval: options.vector ? 'vector+bm25' : 'bm25',
      embedding,
      supersede: options.supersede,
      topK: options.topK,
      facts: facts.length,
      conflictGroups: groups.size,
      supersededAtWrite,
      activeAfterIngest,
      report: scoreCr(cases, superseded),
      cases,
    };
  } finally {
    await closeDb();
    await removeWithRetry(storeRoot);
  }
}
