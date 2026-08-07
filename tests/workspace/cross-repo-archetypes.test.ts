import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { createKnowledgeItem } from '../../src/store/repository.js';
import { reindexKnowledgeEmbeddings } from '../../src/store/vector-index.js';
import { createLocalEmbeddingProvider } from '../../src/ai/embeddings.js';
import { evaluateRetrieval, type RetrievalEvaluationCase } from '../../src/store/retrieval-evaluation.js';
import { queryFederated } from '../../src/workspace/federated-query.js';
import { resolveWorkspace } from '../../src/workspace/resolve.js';
import { createManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { joinWorkspace } from '../../src/workspace/membership.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

/**
 * Cross-repo retrieval across several WORKSPACE SHAPES, not just one.
 *
 * `cross-repo-suite.json` holds three cases over a single two-repo fixture. Three cases cannot
 * establish whether a ranking change generalises -- which was demonstrated the expensive way: a
 * change measured as a clear win over one real three-repo workspace (12 queries, 9 unchanged,
 * every regression accounted for) broke two of those three cases the moment it met a fixture
 * built by somebody else. The sample was not small, it was *narrow*: every query, every label
 * and every counterexample came from one person's data and one person's judgement.
 *
 * So this suite varies the thing that was held constant. Each archetype is a genuinely different
 * shape of workspace, with its own failure mode:
 *
 * - **monorepo-split** -- one codebase cut in three; heavy vocabulary overlap by construction.
 * - **fork-siblings** -- diverged forks where a same-named concept means different things.
 * - **client-projects** -- unrelated clients sharing generic words, plus a house toolkit whose
 *   rules are correct everywhere.
 * - **asymmetric-trio** -- a big service, a small client library and a prose handbook; questions
 *   asked from the small repos are often answered by the big one.
 * - **polyglot-services** -- four independent services where most cross-repo hits are noise and
 *   only the shared infra conventions should travel.
 *
 * Ground truth was authored per archetype WITHOUT sight of the ranking rules, from one question
 * only: "a developer in this repo typed this -- which item genuinely answers them?" Nothing in
 * the labelling refers to which repo an item lives in, so the labels cannot encode a preference
 * the ranker is then congratulated for having.
 *
 * `tier` carries the archetype name, so `byTier` reports each shape separately. That is the
 * point: a change that lifts the pooled number while wrecking one shape is the failure this
 * exists to catch, and a pooled average is exactly what would hide it.
 */

type Fixture = { id: string; category: string; title: string; content: string; visibility: string };
type Case = RetrievalEvaluationCase & { queryFrom: string; why: string };
type Archetype = { name: string; repos: Record<string, Fixture[]>; cases: Case[] };

const SUITE_PATH = path.resolve('./docs/evals/cross-repo-archetypes.json');
const BASELINE_PATH = path.resolve('./docs/evals/cross-repo-archetype-baseline.json');

const suite = JSON.parse(await fs.readFile(SUITE_PATH, 'utf-8')) as {
  version: number;
  description: string;
  archetypes: Archetype[];
};
const baseline = JSON.parse(await fs.readFile(BASELINE_PATH, 'utf-8')) as {
  recordedAt: string;
  note: string;
  positional: Record<string, { mrr: number; recallAt3: number }>;
  semantic: Record<string, { mrr: number; recallAt3: number }>;
  /**
   * How many `mustNotReturn` items the ranker still shows, per path. A CEILING, not an
   * invariant -- these are the suites' quality preferences ("the other client's same-named
   * setting should not crowd this page"), which a future ranker may legitimately improve on and
   * which the current one does not fully satisfy. The hard guarantee -- a peer's repo-private
   * row never crossing -- is asserted separately and at exactly zero.
   */
  softForbidden: { positional: number; semantic: number };
};

const HOME = path.resolve('./.knowl-arche-home');
const rootFor = (archetype: string, repoName: string) =>
  path.resolve(`./.knowl-arche-${archetype}-${repoName}`);

// See cross-repo-semantic.test.ts: a throwaway KNOWL_HOME would send every run back to
// huggingface.co for the weights, making a rate limiter part of the build.
const MODEL_CACHE = path.resolve('./.knowl/models');
const CONFIG = {
  ...DEFAULT_CONFIG,
  search: { ...DEFAULT_CONFIG.search, vector: { ...DEFAULT_CONFIG.search?.vector, cacheDir: MODEL_CACHE } },
};

/**
 * Fixture ids are the suite's assertion vocabulary, but item ids are generated and referenced by
 * assertions and evidence under cascading foreign keys, so a primary key cannot be rewritten.
 * Keyed by archetype as well as fixture id, since two archetypes may reuse a slug.
 */
const realIds = new Map<string, string>();
const key = (archetype: string, fixtureId: string) => `${archetype}::${fixtureId}`;

const allRoots = () => suite.archetypes.flatMap(archetype =>
  Object.keys(archetype.repos).map(repoName => rootFor(archetype.name, repoName)));

async function seedRepo(archetype: Archetype, repoName: string) {
  const root = rootFor(archetype.name, repoName);
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, CONFIG);
  await initDb(root);
  await repo.createProject(root, repoName);
  for (const fixture of archetype.repos[repoName]) {
    const created = await createKnowledgeItem('local', {
      category: fixture.category as never,
      title: fixture.title,
      content: fixture.content,
    });
    await getClient().execute({
      sql: 'UPDATE knowledge_items SET visibility = ?, origin_repo = ? WHERE id = ?',
      args: [fixture.visibility, repoName, created.id],
    });
    realIds.set(key(archetype.name, fixture.id), created.id);
  }
  await closeDb();
}

async function embedRepo(archetype: Archetype, repoName: string) {
  const root = rootFor(archetype.name, repoName);
  await initDb(root);
  await reindexKnowledgeEmbeddings('local', await createLocalEmbeddingProvider(CONFIG, root));
  await closeDb();
}

/** Unknown fixture ids pass through unmapped, so a typo in the suite fails loudly as a miss. */
const toRealIds = (archetype: string, ids: string[]) => ids.map(id => realIds.get(key(archetype, id)) ?? id);

async function scoreAll(semantic: boolean) {
  const cases: RetrievalEvaluationCase[] = [];
  const specs = new Map<string, { archetype: Archetype; spec: Case }>();

  for (const archetype of suite.archetypes) {
    for (const spec of archetype.cases) {
      // Ids are namespaced so two archetypes can both have a `retry-policy` case.
      const id = `${archetype.name}/${spec.id}`;
      specs.set(id, { archetype, spec });
      cases.push({
        id,
        query: spec.query,
        expectedItemIds: toRealIds(archetype.name, spec.expectedItemIds),
        mustNotReturn: toRealIds(archetype.name, spec.mustNotReturn ?? []),
        limit: spec.limit,
        tier: archetype.name,
      });
    }
  }

  return await evaluateRetrieval(cases, async testCase => {
    const { archetype, spec } = specs.get(testCase.id)!;
    const root = rootFor(archetype.name, spec.queryFrom);
    const started = Date.now();
    await initDb(root);
    try {
      const active = (await resolveWorkspace(root))!;
      let vector;
      if (semantic) {
        const embedder = await createLocalEmbeddingProvider(CONFIG, root);
        const [embedding] = await embedder.embed([testCase.query]);
        vector = {
          enabled: true,
          profileFingerprint: embedder.profileFingerprint,
          embedding,
          relevanceFloor: embedder.relevanceFloor,
        };
      }
      const federated = await queryFederated({
        workspace: active, query: testCase.query, limit: testCase.limit, vector,
      });
      return {
        itemIds: federated.items.map(item => item.id),
        staleItemIds: [],
        latencyMs: Date.now() - started,
        contextChars: federated.items.reduce((sum, item) => sum + item.title.length + item.content.length, 0),
      };
    } finally {
      await closeDb();
    }
  });
}

describe('cross-repo retrieval across workspace archetypes', () => {
  beforeAll(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, ...allRoots()]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});

    for (const archetype of suite.archetypes) {
      // One workspace per archetype: they are separate worlds and must not see each other.
      await writeManifest(workspaceManifestPath(archetype.name), createManifest(archetype.name, null));
      for (const repoName of Object.keys(archetype.repos)) await seedRepo(archetype, repoName);
      for (const repoName of Object.keys(archetype.repos)) {
        await joinWorkspace({
          projectRoot: rootFor(archetype.name, repoName),
          workspaceName: archetype.name,
          repoName,
        });
      }
    }
  }, 600_000);

  afterAll(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, ...allRoots()]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }, 120_000);

  it('never lets a peer repo-private item cross, in any archetype', async () => {
    // Computed from the fixtures' own visibility, NOT from the suites' `mustNotReturn`.
    //
    // Those two are different claims and merging them would be a mistake in the suite's favour.
    // `mustNotReturn` mixes a hard guarantee ("this is private to another repo and may never be
    // returned") with a ranking preference ("the other repo's same-named setting should not
    // crowd the page"). The first is an invariant that must be exactly zero forever; the second
    // is a quality bar that a future ranker may legitimately move. Asserting them together
    // would mean a ranking regression could be waved through as a privacy failure, or worse, a
    // privacy failure hidden inside a tolerance granted for ranking.
    const leaks: string[] = [];
    for (const archetype of suite.archetypes) {
      const privateTo = new Map<string, string>();
      for (const [repoName, items] of Object.entries(archetype.repos)) {
        for (const item of items) if (item.visibility === 'repo') privateTo.set(item.id, repoName);
      }
      const idToFixture = new Map(
        [...privateTo.keys()].map(fixtureId => [realIds.get(key(archetype.name, fixtureId))!, fixtureId]),
      );

      for (const spec of archetype.cases) {
        const root = rootFor(archetype.name, spec.queryFrom);
        await initDb(root);
        try {
          const active = (await resolveWorkspace(root))!;
          const federated = await queryFederated({
            workspace: active, query: spec.query, limit: Math.max(spec.limit, 10),
          });
          for (const item of federated.items) {
            const fixtureId = idToFixture.get(item.id);
            if (!fixtureId) continue;
            const ownerRepo = privateTo.get(fixtureId)!;
            if (ownerRepo !== spec.queryFrom) {
              leaks.push(`${archetype.name}/${spec.id}: ${fixtureId} is private to ${ownerRepo}`);
            }
          }
        } finally {
          await closeDb();
        }
      }
    }
    expect(leaks).toEqual([]);
  }, 900_000);

  it('holds the recorded baseline on the positional fallback path', async () => {
    const evaluation = await scoreAll(false);
    for (const [archetype, metrics] of Object.entries(evaluation.byTier)) {
      console.log(`POSITIONAL ${archetype.padEnd(20)} MRR=${metrics.mrr.toFixed(4)} R@3=${metrics.recallAt3.toFixed(4)}`);
    }
    console.log(`POSITIONAL soft-forbidden shown: ${evaluation.metrics.forbiddenHitCount}`);
    expect(evaluation.metrics.forbiddenHitCount).toBeLessThanOrEqual(baseline.softForbidden.positional);
    for (const [archetype, recorded] of Object.entries(baseline.positional)) {
      const actual = evaluation.byTier[archetype];
      expect(actual, `archetype ${archetype} missing from results`).toBeDefined();
      expect(actual.mrr, `${archetype} MRR regressed`).toBeGreaterThanOrEqual(recorded.mrr - 1e-9);
      expect(actual.recallAt3, `${archetype} recall@3 regressed`).toBeGreaterThanOrEqual(recorded.recallAt3 - 1e-9);
    }
  }, 600_000);

  it('holds the recorded baseline on the semantic path, which is the production default', async () => {
    for (const archetype of suite.archetypes) {
      for (const repoName of Object.keys(archetype.repos)) await embedRepo(archetype, repoName);
    }
    const evaluation = await scoreAll(true);
    for (const [archetype, metrics] of Object.entries(evaluation.byTier)) {
      console.log(`SEMANTIC ${archetype.padEnd(20)} MRR=${metrics.mrr.toFixed(4)} R@3=${metrics.recallAt3.toFixed(4)}`);
    }
    console.log(`SEMANTIC soft-forbidden shown: ${evaluation.metrics.forbiddenHitCount}`);
    expect(evaluation.metrics.forbiddenHitCount).toBeLessThanOrEqual(baseline.softForbidden.semantic);
    for (const [archetype, recorded] of Object.entries(baseline.semantic)) {
      const actual = evaluation.byTier[archetype];
      expect(actual, `archetype ${archetype} missing from results`).toBeDefined();
      expect(actual.mrr, `${archetype} MRR regressed`).toBeGreaterThanOrEqual(recorded.mrr - 1e-9);
      expect(actual.recallAt3, `${archetype} recall@3 regressed`).toBeGreaterThanOrEqual(recorded.recallAt3 - 1e-9);
    }
  }, 900_000);
});
