import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { createKnowledgeItem } from '../../src/store/repository.js';
import { queryKnowledgeForAgent } from '../../src/store/agent-query.js';
import { reindexKnowledgeEmbeddings } from '../../src/store/vector-index.js';
import { createLocalEmbeddingProvider } from '../../src/ai/embeddings.js';
import { evaluateRetrieval, type RetrievalEvaluationCase } from '../../src/store/retrieval-evaluation.js';
import { flattenGroups, queryFederated } from '../../src/workspace/federated-query.js';
import { resolveWorkspace } from '../../src/workspace/resolve.js';
import { createManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { joinWorkspace } from '../../src/workspace/membership.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

const SUITE = JSON.parse(
  await fs.readFile(path.resolve('./docs/evals/cross-repo-suite.json'), 'utf-8'),
) as {
  repos: Record<string, Array<{ id: string; category: string; title: string; content: string; visibility: string }>>;
  cases: Array<RetrievalEvaluationCase & { queryFrom: string; why: string }>;
};

const HOME = path.resolve('./.knowl-xeval-home');
const ROOTS: Record<string, string> = {
  web: path.resolve('./.knowl-xeval-web'),
  server: path.resolve('./.knowl-xeval-server'),
};

// The repo's own cache, as `workspace-query.test.ts` and `write-embedding.test.ts` already do.
// Left unset, `resolveModelCache` lands on `knowlHome()/models` -- and `knowlHome()` here is
// the throwaway HOME above, which `afterAll` deletes. So every run fetched the weights again
// from huggingface.co, which is a rate limiter this suite has no business depending on: a 429
// there fails the build for reasons that have nothing to do with the change under test.
// A stable path inside the repo is one CI can cache and a developer already has warm.
const MODEL_CACHE = path.resolve('./.knowl/models');
const CONFIG = {
  ...DEFAULT_CONFIG,
  search: { ...DEFAULT_CONFIG.search, vector: { ...DEFAULT_CONFIG.search?.vector, cacheDir: MODEL_CACHE } },
};

/**
 * Fixture ids are the suite's assertion vocabulary, but item ids are generated and
 * referenced by assertions and evidence with cascading foreign keys -- rewriting a primary
 * key raises SQLITE_CONSTRAINT_FOREIGNKEY. So the fixture id stays a label and this map
 * translates it to the real id at assertion time.
 */
const realIds = new Map<string, string>();

async function seedRepo(name: string) {
  const root = ROOTS[name];
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, CONFIG);
  await initDb(root);
  await getClient().execute('DELETE FROM knowledge_commits');
  await getClient().execute('DELETE FROM knowledge_items');
  await repo.createProject(root, name);
  for (const fixture of SUITE.repos[name]) {
    const created = await createKnowledgeItem('local', {
      category: fixture.category as never,
      title: fixture.title,
      content: fixture.content,
    });
    await getClient().execute({
      sql: 'UPDATE knowledge_items SET visibility = ?, origin_repo = ? WHERE id = ?',
      args: [fixture.visibility, name, created.id],
    });
    realIds.set(fixture.id, created.id);
  }
  await closeDb();
}

const toRealIds = (fixtureIds: string[]) => fixtureIds.map(id => realIds.get(id) ?? id);

describe('cross-repo retrieval', () => {
  beforeAll(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, ...Object.values(ROOTS)]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await writeManifest(workspaceManifestPath('eval'), createManifest('eval', null));
    for (const name of Object.keys(ROOTS)) await seedRepo(name);
    for (const name of Object.keys(ROOTS)) {
      await joinWorkspace({ projectRoot: ROOTS[name], workspaceName: 'eval', repoName: name });
    }
  });

  afterAll(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, ...Object.values(ROOTS)]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  /**
   * Score the suite on one of the two ranking paths.
   *
   * `semantic` supplies a query embedding and local vectors, which is the production
   * default; without it the fusion falls back to reciprocal rank. Both are measured because
   * both ship, and quoting one number for "cross-repo MRR" would describe neither.
   */
  async function scoreSuite(semantic: boolean) {
    const byId = new Map(SUITE.cases.map(entry => [entry.id, entry]));
    const cases: RetrievalEvaluationCase[] = SUITE.cases.map(entry => ({
      id: entry.id,
      query: entry.query,
      expectedItemIds: toRealIds(entry.expectedItemIds),
      mustNotReturn: toRealIds(entry.mustNotReturn),
      limit: entry.limit,
    }));

    return await evaluateRetrieval(cases, async testCase => {
      const spec = byId.get(testCase.id)!;
      const root = ROOTS[spec.queryFrom];
      const started = Date.now();
      await initDb(root);
      try {
        const active = (await resolveWorkspace(root))!;
        // Federation selects from every repo including this one, so no local pre-query.
        let vector: { enabled: boolean; profileFingerprint: string; embedding?: number[] } | undefined;
        if (semantic) {
          const embedder = await createLocalEmbeddingProvider(CONFIG, root);
          const [embedding] = await embedder.embed([testCase.query]);
          // The fingerprint, not provider/model: those stopped being the eligibility filter
          // when dtype and pooling joined the identity, so the old pair left no fingerprint
          // and the search matched every stored vector regardless of what produced it.
          vector = {
            enabled: true,
            profileFingerprint: embedder.profileFingerprint,
            embedding,
          };
        }
        const federated = await queryFederated({
          workspace: active, query: testCase.query, limit: testCase.limit, vector,
        });
        return {
          itemIds: flattenGroups(federated).map(item => item.id),
          staleItemIds: [],
          latencyMs: Date.now() - started,
          contextChars: flattenGroups(federated).reduce((sum, item) => sum + item.title.length + item.content.length, 0),
        };
      } finally {
        await closeDb();
      }
    });
  }

  it('meets the recorded baseline on the positional fallback path', async () => {
    const evaluation = await scoreSuite(false);

    // Recorded so a future weighting change can be shown to help or hurt. A drop here is a
    // regression, not noise.
    //
    // Every expected item is found within the top 3, and no repo-private item ever crosses.
    expect(evaluation.metrics.recallAt3).toBe(1);
    expect(evaluation.metrics.forbiddenHitCount).toBe(0);
    expect(evaluation.failedCaseIds).toEqual([]);

    // Was 0.833, recorded 2026-07-27 with `xrepo-answer-elsewhere` ranking second: web's
    // "Web scratch note" mentions "auth" in passing and, as rank 1 of its own corpus, scored
    // identically to server's rank-1 "Auth token TTL", so the local tie-break preferred the
    // weaker local match.
    //
    // That entry said the number could only be raised by "giving cross-corpus scores real
    // comparability". That is what happened, by deleting the fusion rather than weighting it:
    // repos are selected separately and every candidate is scored in one pass, so nothing is
    // "rank 1 of its own corpus" relative to anything else. Absolute text-match strength (up
    // to 0.2) now outweighs the corpus-relative rank term (at most ~0.006), and a passing
    // mention no longer ties a direct answer.
    //
    // A drop below this is a regression. No weight was added to reach it -- the semantic
    // path's numbers are unchanged, which is what rules out an accidental re-tune of the
    // shared scorer.
    expect(evaluation.metrics.mrr).toBe(1);
  });

  it('scores the suite on the semantic path, which is the production default', async () => {
    // Embeddings are off suite-wide (KNOWL_DISABLE_WRITE_EMBEDDING), so build them here --
    // this is the only place the shipped default gets measured end to end.
    for (const name of Object.keys(ROOTS)) {
      await initDb(ROOTS[name]);
      const embedder = await createLocalEmbeddingProvider(CONFIG, ROOTS[name]);
      await reindexKnowledgeEmbeddings('local', embedder);
      await closeDb();
    }

    const evaluation = await scoreSuite(true);
     
    console.log(`SEMANTIC cross-repo MRR=${evaluation.metrics.mrr.toFixed(4)} R@3=${evaluation.metrics.recallAt3.toFixed(4)} forbidden=${evaluation.metrics.forbiddenHitCount} failed=[${evaluation.failedCaseIds.join(',')}]`);

    expect(evaluation.metrics.forbiddenHitCount).toBe(0);
    expect(evaluation.metrics.recallAt3).toBe(1);
    // The positional path scores 0.833 here; the semantic path must not be worse.
    expect(evaluation.metrics.mrr).toBeGreaterThanOrEqual(0.8333);
  }, 300_000);

  it('never returns a peer repo-private item, however well it matches', async () => {
    // Its own test because the scored suite cannot express it: evaluateRetrieval treats an
    // empty expectedItemIds as a miss, so "expect nothing back" is not a scorable case.
    const root = ROOTS.web;
    await initDb(root);
    try {
      const query = 'auth debugging scratch';
      const local = await queryKnowledgeForAgent('local', { query, limit: 10, surface: 'eval' });
      const active = (await resolveWorkspace(root))!;
      const federated = await queryFederated({ workspace: active, localItems: local, query, limit: 5 });
      expect(flattenGroups(federated).some(item => item.id === realIds.get('server-private'))).toBe(false);
    } finally {
      await closeDb();
    }
  });

  it('breaks a tie toward the local repo', async () => {
    // Called out separately because it is the property with no test elsewhere: the whole
    // of the local preference in a fusion that carries no weights and no boosts.
    const root = ROOTS.web;
    await initDb(root);
    try {
      const local = await queryKnowledgeForAgent('local', { query: 'retry policy', limit: 10, surface: 'eval' });
      const active = (await resolveWorkspace(root))!;
      const federated = await queryFederated({ workspace: active, localItems: local, query: 'retry policy', limit: 1 });
      expect(flattenGroups(federated)[0].repo).toBe('web');
    } finally {
      await closeDb();
    }
  });
});
