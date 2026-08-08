import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { createKnowledgeItem } from '../../src/store/repository.js';
import { reindexKnowledgeEmbeddings } from '../../src/store/vector-index.js';
import { createLocalEmbeddingProvider } from '../../src/ai/embeddings.js';
import { flattenGroups, queryFederated } from '../../src/workspace/federated-query.js';
import { resolveWorkspace } from '../../src/workspace/resolve.js';
import { createManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { joinWorkspace } from '../../src/workspace/membership.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

const HOME = path.resolve('./.knowl-abstain-home');
const A = path.resolve('./.knowl-abstain-a');
const B = path.resolve('./.knowl-abstain-b');

// Same reasoning as cross-repo-semantic.test.ts: pin the model cache inside the repo so a
// throwaway KNOWL_HOME does not send every run back to huggingface.co.
const MODEL_CACHE = path.resolve('./.knowl/models');
const CONFIG = {
  ...DEFAULT_CONFIG,
  search: { ...DEFAULT_CONFIG.search, vector: { ...DEFAULT_CONFIG.search?.vector, cacheDir: MODEL_CACHE } },
};

async function seed(root: string, name: string, title: string, content: string, visibility: string) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, CONFIG);
  await initDb(root);
  await repo.createProject(root, name);
  const created = await createKnowledgeItem('local', { category: 'decision', title, content });
  await getClient().execute({
    sql: 'UPDATE knowledge_items SET visibility = ?, origin_repo = ? WHERE id = ?',
    args: [visibility, name, created.id],
  });
  const embedder = await createLocalEmbeddingProvider(CONFIG, root);
  await reindexKnowledgeEmbeddings('local', embedder);
  await closeDb();
}

async function federate(query: string, relevanceFloor: number | null) {
  await initDb(A);
  try {
    const embedder = await createLocalEmbeddingProvider(CONFIG, A);
    const [embedding] = await embedder.embed([query]);
    return await queryFederated({
      workspace: (await resolveWorkspace(A))!,
      query,
      limit: 5,
      vector: { enabled: true, profileFingerprint: embedder.profileFingerprint, embedding, relevanceFloor },
    });
  } finally {
    await closeDb();
  }
}

/**
 * The floor's verdict has to survive federation.
 *
 * `rankKnowledge` passes `vector.relevanceFloor` into the ranker and `queryFederated` did not,
 * so `minRelevance` arrived null on every workspace query, `answerable` was unconditionally
 * true, and no federated result could carry `abstained` -- which made `knowl_query`'s
 * NO CONFIDENT MATCH notice unreachable from the moment a repo was linked. A linked repo is
 * exactly where the verdict matters most: the alternative on offer is another repo's near-miss.
 *
 * The floor is passed explicitly here rather than taken from `relevanceFloorFor(model)`. What
 * is under test is that the number reaches the ranker at all; whether the production constant
 * fires on real queries is a separate, measured question -- and the measurement says it fires
 * rarely, which is why abstention is reported rather than used to delete results.
 */
describe('federated abstention', () => {
  beforeAll(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await writeManifest(workspaceManifestPath('abs'), createManifest('abs', null));
    await seed(A, 'a', 'Local auth note', 'Auth tokens expire locally.', 'repo');
    await seed(B, 'b', 'Auth token TTL', 'Access tokens expire after fifteen minutes.', 'workspace');
    await joinWorkspace({ projectRoot: A, workspaceName: 'abs', repoName: 'a' });
    await joinWorkspace({ projectRoot: B, workspaceName: 'abs', repoName: 'b' });
  }, 180_000);

  afterAll(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('marks every result abstained when nothing clears the floor', async () => {
    // A floor no real cosine reaches: the verdict is "this store does not answer", and the
    // rows still come back, labelled.
    const result = await federate('auth token expiry', 0.99);

    expect(flattenGroups(result).length).toBeGreaterThan(0);
    expect(flattenGroups(result).every(item => item.explanation?.abstained === true)).toBe(true);
  }, 180_000);

  it('marks a peer result too, not just the local ones', async () => {
    // The half a local-only fix would miss. A peer row left unlabelled on an abstained page is
    // the one unlabelled row there, which reads as the answer.
    const result = await federate('auth token expiry', 0.99);
    const fromPeer = flattenGroups(result).find(item => item.repo === 'b');

    expect(fromPeer).toBeDefined();
    expect(fromPeer!.explanation?.abstained).toBe(true);
  }, 180_000);

  it('abstains on nothing when the floor is null', async () => {
    // An uncalibrated model must read as silence, not as a verdict in either direction -- and
    // this is the control that says the labels above come from the floor and not from the
    // query being weak.
    const result = await federate('auth token expiry', null);

    expect(flattenGroups(result).length).toBeGreaterThan(0);
    expect(flattenGroups(result).every(item => item.explanation?.abstained === undefined)).toBe(true);
  }, 180_000);

  it('leaves a real answer unlabelled at the configured floor', async () => {
    // The floor the fixture's own model is calibrated to, read from the provider rather than
    // written in: hardcoding one model's constant into a test whose config pins another is how
    // a passing assertion comes to prove nothing. An on-topic query here scores ~0.78 against
    // a floor of 0.2, which is the margin that makes reporting abstention safe.
    const embedder = await createLocalEmbeddingProvider(CONFIG, A);
    const result = await federate('how long do access tokens last', embedder.relevanceFloor);

    expect(embedder.relevanceFloor).toBeGreaterThan(0);
    expect(flattenGroups(result).every(item => item.explanation?.abstained === undefined)).toBe(true);
  }, 180_000);

  it('abstains on an off-topic query at that same floor', async () => {
    // The production verdict, not a synthetic threshold: nothing in this store is about bread,
    // top cosine is ~0.05, and the floor says so. Corpus size matters here -- the same floor on
    // the real 483-item store admits off-topic queries at ~0.29, because a larger corpus offers
    // more chances at a spurious near-match. That is why abstention cannot be the only evidence
    // for what a workspace fails to answer.
    const embedder = await createLocalEmbeddingProvider(CONFIG, A);
    const result = await federate('sourdough bread hydration percentage', embedder.relevanceFloor);

    expect(flattenGroups(result).length).toBeGreaterThan(0);
    expect(flattenGroups(result).every(item => item.explanation?.abstained === true)).toBe(true);
  }, 180_000);
});
