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
import { queryFederated } from '../../src/workspace/federated-query.js';
import { resolveWorkspace } from '../../src/workspace/resolve.js';
import { createManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { joinWorkspace } from '../../src/workspace/membership.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

const HOME = path.resolve('./.knowl-semantic-home');
const WEB = path.resolve('./.knowl-semantic-web');
const SERVER = path.resolve('./.knowl-semantic-server');

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
 * The case recorded in docs/evals/cross-repo-baseline.json as a known weakness.
 *
 * `web` holds a note that merely mentions auth in passing; `server` holds the real answer.
 * Under positional fusion both are rank 1 of their own corpus, tie, and the local
 * tie-break puts the weaker local note first. With a shared embedding identity, cosine
 * separates them on meaning.
 */
const WEB_DISTRACTOR = 'Temporary debugging note about the auth screen layout.';
const SERVER_ANSWER = 'Access tokens issued by the server expire after fifteen minutes and must be refreshed.';

async function seed(root: string, name: string, title: string, content: string, visibility: string) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, CONFIG);
  await initDb(root);
  await getClient().execute('DELETE FROM knowledge_commits');
  await getClient().execute('DELETE FROM knowledge_items');
  await repo.createProject(root, name);
  const created = await createKnowledgeItem('local', { category: 'decision', title, content });
  await getClient().execute({
    sql: 'UPDATE knowledge_items SET visibility = ?, origin_repo = ? WHERE id = ?',
    args: [visibility, name, created.id],
  });
  // The suite disables write-time embedding, so build the index explicitly -- this test
  // exists precisely to exercise the path the rest of the suite cannot.
  const embedder = await createLocalEmbeddingProvider(CONFIG, root);
  await reindexKnowledgeEmbeddings('local', embedder);
  await closeDb();
}

/** The vector config a caller hands federation: identity plus the query embedding. */
async function vectorConfig(query: string) {
  const embedder = await createLocalEmbeddingProvider(CONFIG, WEB);
  const [embedding] = await embedder.embed([query]);
  // The fingerprint, not provider/model: those stopped being the eligibility filter when
  // dtype and pooling joined the identity. Passing the old pair left the query with no
  // fingerprint at all, which used to drop the predicate and score every stored vector.
  return {
    enabled: true,
    profileFingerprint: embedder.profileFingerprint,
    embedding,
  };
}

describe('cross-repo ranking with a shared embedding identity', () => {
  beforeAll(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, WEB, SERVER]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await writeManifest(workspaceManifestPath('sem'), createManifest('sem', null));
    await seed(WEB, 'web', 'Web scratch note', WEB_DISTRACTOR, 'repo');
    await seed(SERVER, 'server', 'Auth token TTL', SERVER_ANSWER, 'workspace');
    await joinWorkspace({ projectRoot: WEB, workspaceName: 'sem', repoName: 'web' });
    await joinWorkspace({ projectRoot: SERVER, workspaceName: 'sem', repoName: 'server' });
  }, 180_000);

  afterAll(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, WEB, SERVER]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('embeds both repos with the identity the workspace pinned', async () => {
    for (const [root, expected] of [[WEB, 1], [SERVER, 1]] as const) {
      await initDb(root);
      const rows = await getClient().execute('SELECT COUNT(*) AS n FROM knowledge_embeddings');
      await closeDb();
      expect(Number(rows.rows[0].n)).toBe(expected);
    }
  }, 180_000);

  it('ranks the correct foreign answer above a weak local match', async () => {
    const query = 'how long do auth tokens last before they expire';
    await initDb(WEB);
    try {
      const active = (await resolveWorkspace(WEB))!;
      const federated = await queryFederated({
        workspace: active, query, limit: 3, vector: await vectorConfig(query),
      });

      // The recorded weakness, resolved: the answer that actually answers the question
      // ranks first even though it lives in another repo and a local item also matched.
      expect(federated.items[0].repo).toBe('server');
      expect(federated.items[0].title).toBe('Auth token TTL');
    } finally {
      await closeDb();
    }
  }, 180_000);

  it('finds a peer item that shares no query token at all', async () => {
    // The case lexical selection cannot reach, and the reason vector search exists. The
    // query says nothing about tokens, expiry or minutes; only meaning connects it.
    const query = 'session credential lifetime policy';
    await initDb(WEB);
    try {
      const active = (await resolveWorkspace(WEB))!;
      const federated = await queryFederated({
        workspace: active, query, limit: 5, vector: await vectorConfig(query),
      });

      expect(federated.items.some(item => item.repo === 'server' && item.title === 'Auth token TTL')).toBe(true);
    } finally {
      await closeDb();
    }
  }, 180_000);

  it('still returns the local item, ranked below it', async () => {
    const query = 'how long do auth tokens last before they expire';
    await initDb(WEB);
    try {
      const active = (await resolveWorkspace(WEB))!;
      const federated = await queryFederated({
        workspace: active, query, limit: 5, vector: await vectorConfig(query),
      });
      // Reordering, not exclusion: the local note is still there, just no longer first.
      expect(federated.items.some(item => item.repo === 'web')).toBe(true);
    } finally {
      await closeDb();
    }
  }, 180_000);
});
