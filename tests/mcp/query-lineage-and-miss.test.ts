import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { createManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { joinWorkspace } from '../../src/workspace/membership.js';
import { updateRepoSettings } from '../../src/workspace/repo-settings.js';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../../src/core/config.js';
import type { ProjectConfig } from '../../src/core/types.js';

const HOME = path.resolve('./.knowl-lineage-home');
const A = path.resolve('./.knowl-lineage-a');
const B = path.resolve('./.knowl-lineage-b');
const MODEL_CACHE = path.resolve('./.knowl/models');

class InMemoryTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: any) => void;
  onSend?: (message: any) => void;
  async start(): Promise<void> {}
  async send(message: any): Promise<void> { this.onSend?.(message); }
  async close(): Promise<void> { this.onclose?.(); }
}

async function callTool(root: string, config: ProjectConfig, name: string, args: Record<string, unknown>) {
  const server = createMcpServer('local', root, config);
  const transport = new InMemoryTransport();
  await server.connect(transport as any);

  const initialized = new Promise<any>(resolve => { transport.onSend = message => { if (message.id === 'init') resolve(message); }; });
  transport.onmessage!({
    jsonrpc: '2.0', id: 'init', method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  });
  await initialized;
  transport.onmessage!({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const response = new Promise<any>(resolve => { transport.onSend = message => { if (message.id === 'call') resolve(message); }; });
  transport.onmessage!({ jsonrpc: '2.0', id: 'call', method: 'tools/call', params: { name, arguments: args } });
  const result = await response;
  await server.close();
  return result.result;
}

async function seed(root: string, name: string, items: Array<{ title: string; content: string; visibility: string }>) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, {
    ...DEFAULT_CONFIG,
    search: { ...DEFAULT_CONFIG.search, vector: { ...DEFAULT_CONFIG.search?.vector, cacheDir: MODEL_CACHE } },
  });
  await initDb(root);
  const projectId = (await repo.createProject(root, name)).id;
  for (const item of items) {
    const stored = await storeKnowledgeItemDeduped(projectId, { category: 'decision', title: item.title, content: item.content });
    await getClient().execute({
      sql: 'UPDATE knowledge_items SET visibility = ?, origin_repo = ? WHERE id = ?',
      args: [item.visibility, name, stored.item.id],
    });
  }
  await closeDb();
}

const blocksOf = (result: any) => result.content.map((block: any) => String(block.text));

/**
 * Build the vector index for a seeded repo.
 *
 * The suite disables write-time embedding, and the relevance floor turns itself off entirely
 * when nothing is embedded -- correctly, since an unindexed row scores low by absence rather
 * than by verdict. So an abstention test on an unindexed fixture proves nothing at all: it
 * would pass on the theory that the store has no answer and on the theory that the floor is
 * disconnected, which are the two things it exists to tell apart.
 */
async function index(root: string) {
  const { reindexKnowledgeEmbeddings } = await import('../../src/store/vector-index.js');
  const { createLocalEmbeddingProvider } = await import('../../src/ai/embeddings.js');
  const config = await loadConfig(root);
  await initDb(root);
  await reindexKnowledgeEmbeddings('local', await createLocalEmbeddingProvider(config, root));
  await closeDb();
}

describe('knowl_query lineage notice', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));
    await seed(A, 'a', [{ title: 'Local auth note', content: 'Auth tokens expire locally.', visibility: 'repo' }]);
    await seed(B, 'b', [
      { title: 'Auth token TTL is fifteen minutes', content: 'Auth tokens expire after fifteen minutes.', visibility: 'workspace' },
      { title: 'Auth refresh policy', content: 'Auth refresh happens on every request.', visibility: 'workspace' },
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

  it('warns once that a peer shares this repo\'s lineage', async () => {
    await updateRepoSettings({ workspaceName: 'ws', repoName: 'a', settings: { kin: 'lineage' } });
    await updateRepoSettings({ workspaceName: 'ws', repoName: 'b', settings: { kin: 'lineage' } });

    await initDb(A);
    const result = await callTool(A, await loadConfig(A), 'knowl_query', { query: 'auth', limit: 5 });
    await closeDb();

    const lineage = blocksOf(result).filter((text: string) => text.startsWith('SHARED LINEAGE:'));
    // Two kin results are on the page. One notice, not two: a per-row warning on a five-row
    // response is noise the reader learns to skip.
    expect(lineage).toHaveLength(1);
    expect(lineage[0]).toContain('b');
  });

  it('says nothing about lineage when the repos are merely linked', async () => {
    await initDb(A);
    const result = await callTool(A, await loadConfig(A), 'knowl_query', { query: 'auth', limit: 5 });
    await closeDb();

    expect(blocksOf(result).some((text: string) => text.includes('SHARED LINEAGE'))).toBe(false);
  });

  it('keeps the notice out of the payload, so the first block parses on its own', async () => {
    // The claim here was always about the lineage notice living in its own block rather than
    // being folded into the payload; "bare array" was how that was spelled before a workspace
    // response could be keyed by repo. A peer answers this query, so the payload is an object
    // now -- what must hold is that block 0 is complete JSON and carries no prose.
    await updateRepoSettings({ workspaceName: 'ws', repoName: 'a', settings: { kin: 'lineage' } });
    await updateRepoSettings({ workspaceName: 'ws', repoName: 'b', settings: { kin: 'lineage' } });

    await initDb(A);
    const result = await callTool(A, await loadConfig(A), 'knowl_query', { query: 'auth', limit: 5 });
    await closeDb();

    expect(() => JSON.parse(result.content[0].text)).not.toThrow();
    expect(result.content[0].text).not.toContain('SHARED LINEAGE');
    expect(result.content.slice(1).map((block: any) => block.text).join('\n')).toContain('SHARED LINEAGE');
  });
});

/**
 * An abstention is the one moment the agent has concluded memory is empty.
 *
 * That is exactly when transcript search can still answer -- past sessions are indexed
 * separately and `knowl_query` does not touch them -- and the notice said nothing about it. The
 * fault path only closes if the caller is told the tool exists, and only where it does.
 */
describe('knowl_query miss notice', () => {
  const OFF_TOPIC = 'sourdough bread hydration percentage';

  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));
    await seed(A, 'a', [{ title: 'Local auth note', content: 'Auth tokens expire locally.', visibility: 'repo' }]);
    await seed(B, 'b', [{ title: 'Auth token TTL', content: 'Access tokens expire after fifteen minutes.', visibility: 'workspace' }]);
    await index(A);
    await index(B);
    await joinWorkspace({ projectRoot: A, workspaceName: 'ws', repoName: 'a' });
    await joinWorkspace({ projectRoot: B, workspaceName: 'ws', repoName: 'b' });
  }, 180_000);

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  const missNotice = (result: any) =>
    blocksOf(result).find((text: string) => text.startsWith('NO CONFIDENT MATCH:'));

  it('reaches the notice at all on a federated query', async () => {
    // The regression this guards: with the floor unplumbed, a linked repo could not produce
    // this block on any query, however off-topic.
    await initDb(A);
    const config = await loadConfig(A);
    const result = await callTool(A, config, 'knowl_query', { query: OFF_TOPIC, limit: 5 });
    await closeDb();

    expect(missNotice(result)).toBeDefined();
  });

  it('names transcript search when this repo has it enabled', async () => {
    await initDb(A);
    const config = await loadConfig(A);
    const result = await callTool(
      A,
      { ...config, search: { ...config.search, transcripts: { ...config.search?.transcripts, enabled: true } } },
      'knowl_query',
      { query: OFF_TOPIC, limit: 5 },
    );
    await closeDb();

    expect(missNotice(result)).toContain('knowl_transcript_search');
  });

  it('does not name a tool this build does not expose', async () => {
    // Transcripts are off by default. Naming the tool unconditionally sends the caller to
    // something that is not there, which is worse than saying nothing.
    await initDb(A);
    const config = await loadConfig(A);
    const result = await callTool(
      A,
      { ...config, search: { ...config.search, transcripts: { ...config.search?.transcripts, enabled: false } } },
      'knowl_query',
      { query: OFF_TOPIC, limit: 5 },
    );
    await closeDb();

    expect(missNotice(result)).toBeDefined();
    expect(missNotice(result)).not.toContain('knowl_transcript_search');
  });
});
