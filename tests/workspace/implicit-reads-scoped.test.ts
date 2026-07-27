import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { queryKnowledgeForAgent } from '../../src/store/agent-query.js';
import { getRecentContext } from '../../src/store/recent-context.js';
import { composeContext } from '../../src/store/context-composer.js';
import { startWorkLoop } from '../../src/store/work-loop.js';
import { synthesizeKnowledge } from '../../src/store/synthesis.js';
import { configuredNamespaces } from '../../src/store/namespaces.js';
import { resolveStorage } from '../../src/store/storage-roles.js';
import { queryFederated } from '../../src/workspace/federated-query.js';
import { resolveWorkspace } from '../../src/workspace/resolve.js';
import { createManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { joinWorkspace } from '../../src/workspace/membership.js';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../../src/core/config.js';

const HOME = path.resolve('./.knowl-optin-home');
const A = path.resolve('./.knowl-optin-a');
const B = path.resolve('./.knowl-optin-b');

const PEER_MARKER = 'fifteen minutes';

async function seed(root: string, name: string, items: Array<{ category: 'decision' | 'fact'; title: string; content: string; visibility: string }>) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
  await initDb(root);
  await getClient().execute('DELETE FROM knowledge_commits');
  await getClient().execute('DELETE FROM knowledge_items');
  const projectId = (await repo.createProject(root, name)).id;
  for (const item of items) {
    const stored = await storeKnowledgeItemDeduped(projectId, {
      category: item.category, title: item.title, content: item.content, tags: ['auth'],
    });
    await getClient().execute({
      sql: 'UPDATE knowledge_items SET visibility = ?, origin_repo = ? WHERE id = ?',
      args: [item.visibility, name, stored.item.id],
    });
  }
  await closeDb();
}

/**
 * A guard suite, not a feature suite. In v1 each repo's database holds only its own items,
 * so implicit reads are scoped for free -- provided peers never join the namespace lists.
 *
 * Verified non-vacuous: adding a peer descriptor to `defaultNamespaces` makes the
 * `configuredNamespaces` and `composeContext` assertions fail, the latter by leaking the
 * peer marker straight into an assembled context pack. That is the injection channel this
 * exists to prevent.
 *
 * The `getRecentContext`, `startWorkLoop` and `synthesize` assertions did NOT fail under
 * that injection, because those read the ambient database directly rather than through
 * namespaces. They are deliberately kept: they are the guards that bite in v2, when one
 * shared database really does hold every repo's items and "ambient" stops meaning "mine".
 */
describe('federation is opt-in', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));

    // Two local auth sources, so synthesis has the two it requires without borrowing one.
    await seed(A, 'a', [
      { category: 'fact', title: 'Local auth note', content: 'Auth tokens expire locally in this service.', visibility: 'repo' },
      { category: 'fact', title: 'Local auth refresh', content: 'Auth refresh happens on the local client only.', visibility: 'repo' },
    ]);
    await seed(B, 'b', [
      { category: 'decision', title: 'Auth token TTL', content: `Auth tokens expire after ${PEER_MARKER}.`, visibility: 'workspace' },
    ]);
    await joinWorkspace({ projectRoot: A, workspaceName: 'ws', repoName: 'a' });
    await joinWorkspace({ projectRoot: B, workspaceName: 'ws', repoName: 'b' });
  });

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('configuredNamespaces contains no peer database', async () => {
    // The structural guarantee. If a peer ever appears here, composeContext will inject
    // another repo's knowledge into auto-assembled context without anyone asking.
    const descriptors = configuredNamespaces(A, await loadConfig(A));
    expect(descriptors.map(entry => entry.databasePath)).not.toContain(resolveStorage(B).knowledge);
  });

  it('getRecentContext returns nothing from a linked repo', async () => {
    await initDb(A);
    const recent = await getRecentContext('local', { itemLimit: 20 });
    await closeDb();
    expect(JSON.stringify(recent)).not.toContain(PEER_MARKER);
  });

  it('composeContext returns nothing from a linked repo', async () => {
    await initDb(A);
    const pack = await composeContext('local', { query: 'auth', tokenBudget: 2000, namespaceRoot: A });
    await closeDb();
    expect(JSON.stringify(pack)).not.toContain(PEER_MARKER);
  });

  it('startWorkLoop bootstrap returns nothing from a linked repo', async () => {
    await initDb(A);
    const started = await startWorkLoop('local', 'Investigate auth');
    await closeDb();
    expect(JSON.stringify(started.relevantMemory)).not.toContain(PEER_MARKER);
  });

  it('synthesize cannot draw on a linked repo', async () => {
    await initDb(A);
    const item = await synthesizeKnowledge('local', 'auth');
    await closeDb();
    expect(item.content).not.toContain(PEER_MARKER);
  });

  it('knowl_query does fan out -- federation is opt-in, not absent', async () => {
    // The counterpart assertion. Without it this suite would pass if federation were
    // simply broken.
    await initDb(A);
    const local = await queryKnowledgeForAgent('local', { query: 'auth', limit: 5, surface: 'test' });
    const active = (await resolveWorkspace(A))!;
    const federated = await queryFederated({ workspace: active, localItems: local, query: 'auth', limit: 5 });
    await closeDb();
    expect(federated.items.some(item => item.repo === 'b')).toBe(true);
  });
});
