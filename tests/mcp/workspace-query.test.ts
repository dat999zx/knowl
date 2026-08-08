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
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../../src/core/config.js';
import type { ProjectConfig } from '../../src/core/types.js';

const HOME = path.resolve('./.knowl-mcpws-home');
const A = path.resolve('./.knowl-mcpws-a');
const B = path.resolve('./.knowl-mcpws-b');
const SOLO = path.resolve('./.knowl-mcpws-solo');
// These tests query through the MCP path, which embeds the query whenever vector search is
// enabled -- and DEFAULT_CONFIG enables it. The pipeline is cached per cacheDir, which
// defaults to `<projectRoot>/.knowl/models`, so leaving it unset makes every fixture root
// materialise its own copy of the model into a directory beforeEach then deletes. That cost
// (~10s per root, unbounded when it has to fetch) is what pushed this file past the 30s
// testTimeout under parallel workers. Sharing the repo's own cache, as write-embedding.test
// does, means the model loads once and every test after it runs in milliseconds.
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

describe('knowl_query in a workspace', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B, SOLO]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));
    await seed(A, 'a', [{ title: 'Local auth note', content: 'Auth tokens expire locally.', visibility: 'repo' }]);
    await seed(B, 'b', [
      { title: 'Auth token TTL is fifteen minutes', content: 'Auth tokens expire after fifteen minutes.', visibility: 'workspace' },
      { title: 'Auth scratch note', content: 'Auth debugging scratch, not for sharing.', visibility: 'repo' },
    ]);
    await seed(SOLO, 'solo', [{ title: 'Solo auth note', content: 'Auth tokens expire in the solo repo.', visibility: 'repo' }]);
    await joinWorkspace({ projectRoot: A, workspaceName: 'ws', repoName: 'a' });
    await joinWorkspace({ projectRoot: B, workspaceName: 'ws', repoName: 'b' });
  });
  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B, SOLO]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('labels every item with its owning repo, by the key it sits under', async () => {
    // The label moved from a per-row field to the group key. It used to be a `repo` string on
    // each row, which is exactly what an agent skimmed past on the way to using a linked repo's
    // answer as this repo's own -- the shape now carries what the field could not.
    await initDb(A);
    const result = await callTool(A, await loadConfig(A), 'knowl_query', { query: 'auth', limit: 5 });
    await closeDb();
    const payload = JSON.parse(result.content[0].text);

    expect(Array.isArray(payload)).toBe(false);
    expect(Object.keys(payload).sort()).toEqual(['a', 'b']);
    expect(Object.values(payload).flat().length).toBeGreaterThan(0);
  });

  it('surfaces the peer workspace item and hides the peer private one', async () => {
    await initDb(A);
    const result = await callTool(A, await loadConfig(A), 'knowl_query', { query: 'auth', limit: 5 });
    await closeDb();
    const titles = Object.values(JSON.parse(result.content[0].text)).flat().map((item: any) => item.title);

    expect(titles).toContain('Auth token TTL is fifteen minutes');
    expect(titles).not.toContain('Auth scratch note');
  });

  it('accepts a repos filter matching the owning repo', async () => {
    await initDb(A);
    const result = await callTool(A, await loadConfig(A), 'knowl_query', { query: 'auth', limit: 5, repos: ['b'] });
    await closeDb();
    const payload = JSON.parse(result.content[0].text);

    // Naming repos is an explicit request for a partitioned view, so the shape is fixed grouped
    // even though only one repo answered.
    expect(Object.keys(payload)).toEqual(['b']);
    expect(payload.b.length).toBeGreaterThan(0);
  });

  it('omits evidence for a foreign item rather than judging it against this filesystem', async () => {
    await initDb(A);
    const result = await callTool(A, await loadConfig(A), 'knowl_query', { query: 'auth', limit: 5, includeEvidence: true });
    await closeDb();
    const foreign = JSON.parse(result.content[0].text).b?.[0];

    expect(foreign).toBeDefined();
    expect(foreign.evidence).toBeUndefined();
  });

  it('keeps the first block a bare JSON array and discloses skips in a second', async () => {
    const { readManifest } = await import('../../src/workspace/manifest.js');
    const manifest = await readManifest(workspaceManifestPath('ws'));
    manifest.repos = manifest.repos.map(entry =>
      entry.name === 'b' ? { ...entry, path: path.resolve('./.knowl-mcpws-never-cloned') } : entry);
    await writeManifest(workspaceManifestPath('ws'), manifest);

    await initDb(A);
    const result = await callTool(A, await loadConfig(A), 'knowl_query', { query: 'auth', limit: 5 });
    await closeDb();
    expect(Array.isArray(JSON.parse(result.content[0].text))).toBe(true);
    expect(result.content[1].text).toContain('b (absent)');
  });

  it('omits repo and says nothing about linked repos when there is no workspace', async () => {
    await initDb(SOLO);
    const result = await callTool(SOLO, await loadConfig(SOLO), 'knowl_query', { query: 'auth', limit: 5 });
    await closeDb();
    const items = JSON.parse(result.content[0].text);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item: any) => item.repo === undefined)).toBe(true);
    // An unlinked repo still gets the skipped-namespace notice fc6171e added, because
    // vector search bypasses the layered path. What must be absent is any mention of
    // linked repos -- the workspace path contributed nothing.
    const blocks = result.content.map((block: any) => String(block.text));
    expect(blocks.some((text: string) => text.includes('linked repos'))).toBe(false);
  });
});
