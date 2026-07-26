import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { createKnowledgeItem } from '../../src/store/repository.js';
import { queryKnowledgeForAgent } from '../../src/store/agent-query.js';
import { evaluateRetrieval, type RetrievalEvaluationCase } from '../../src/store/retrieval-evaluation.js';
import { queryFederated } from '../../src/workspace/federated-query.js';
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
  await saveConfig(root, { ...DEFAULT_CONFIG });
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

  it('meets the recorded cross-repo baseline', async () => {
    const byId = new Map(SUITE.cases.map(entry => [entry.id, entry]));
    const cases: RetrievalEvaluationCase[] = SUITE.cases.map(entry => ({
      id: entry.id,
      query: entry.query,
      expectedItemIds: toRealIds(entry.expectedItemIds),
      mustNotReturn: toRealIds(entry.mustNotReturn),
      limit: entry.limit,
    }));

    const evaluation = await evaluateRetrieval(cases, async testCase => {
      const spec = byId.get(testCase.id)!;
      const root = ROOTS[spec.queryFrom];
      const started = Date.now();
      await initDb(root);
      try {
        const local = await queryKnowledgeForAgent('local', { query: testCase.query, limit: 10, surface: 'eval' });
        const active = (await resolveWorkspace(root))!;
        const federated = await queryFederated({
          workspace: active, localItems: local, query: testCase.query, limit: testCase.limit,
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

    // Recorded so a future weighting change can be shown to help or hurt. A drop here is a
    // regression, not noise.
    //
    // Every expected item is found within the top 3, and no repo-private item ever crosses.
    expect(evaluation.metrics.recallAt3).toBe(1);
    expect(evaluation.metrics.forbiddenHitCount).toBe(0);
    expect(evaluation.failedCaseIds).toEqual([]);

    // MRR is 0.833, not 1, and that is the honest number rather than a target to tune to.
    // In `xrepo-answer-elsewhere` the correct answer ranks second: web's "Web scratch note"
    // mentions "auth" in passing and, as rank 1 of its own corpus, scores identically to
    // server's rank-1 "Auth token TTL" -- so the local tie-break puts the weaker local
    // match first.
    //
    // This is the cost of shipping fusion with no weights, recorded deliberately. It is the
    // number a future weighting change has to beat, and it cannot be beaten by accident:
    // raising it means giving cross-corpus scores real comparability, which is the work the
    // ablation exists to justify.
    expect(evaluation.metrics.mrr).toBeCloseTo(0.833, 2);
  });

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
      expect(federated.items.some(item => item.id === realIds.get('server-private'))).toBe(false);
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
      expect(federated.items[0].repo).toBe('web');
    } finally {
      await closeDb();
    }
  });
});
