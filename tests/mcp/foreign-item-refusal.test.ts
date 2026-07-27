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

const HOME = path.resolve('./.knowl-foreign-home');
const A = path.resolve('./.knowl-foreign-a');
const B = path.resolve('./.knowl-foreign-b');
const SOLO = path.resolve('./.knowl-foreign-solo');

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
  const initialized = new Promise<any>(resolve => { transport.onSend = m => { if (m.id === 'init') resolve(m); }; });
  transport.onmessage!({
    jsonrpc: '2.0', id: 'init', method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  });
  await initialized;
  transport.onmessage!({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const response = new Promise<any>(resolve => { transport.onSend = m => { if (m.id === 'call') resolve(m); }; });
  transport.onmessage!({ jsonrpc: '2.0', id: 'call', method: 'tools/call', params: { name, arguments: args } });
  const result = await response;
  await server.close();
  return result.result;
}

async function seed(root: string, name: string, title: string, content: string, visibility: string): Promise<string> {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
  await initDb(root);
  await getClient().execute('DELETE FROM knowledge_commits');
  await getClient().execute('DELETE FROM knowledge_items');
  const projectId = (await repo.createProject(root, name)).id;
  const stored = await storeKnowledgeItemDeduped(projectId, { category: 'decision', title, content });
  await getClient().execute({
    sql: 'UPDATE knowledge_items SET visibility = ?, origin_repo = ? WHERE id = ?',
    args: [visibility, name, stored.item.id],
  });
  await closeDb();
  return stored.item.id;
}

async function peerContent(id: string): Promise<string> {
  await initDb(B);
  try {
    const rows = await getClient().execute({ sql: 'SELECT content FROM knowledge_items WHERE id = ?', args: [id] });
    return String(rows.rows[0]?.content ?? '');
  } finally {
    await closeDb();
  }
}

describe('item-scoped tools and foreign items', () => {
  let foreignId = '';
  let localId = '';
  let soloId = '';

  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B, SOLO]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));
    localId = await seed(A, 'a', 'Local auth note', 'Auth tokens expire locally.', 'repo');
    foreignId = await seed(B, 'b', 'Auth token TTL', 'Auth tokens expire after fifteen minutes.', 'workspace');
    soloId = await seed(SOLO, 'solo', 'Solo note', 'A note in an unlinked repo.', 'repo');
    await joinWorkspace({ projectRoot: A, workspaceName: 'ws', repoName: 'a' });
    await joinWorkspace({ projectRoot: B, workspaceName: 'ws', repoName: 'b' });
  });

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B, SOLO]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('knowl_update refuses an item this repo does not own, naming the owner', async () => {
    await initDb(A);
    const result = await callTool(A, await loadConfig(A), 'knowl_update', { id: foreignId, content: 'Rewritten from the wrong repo.' });
    await closeDb();
    expect(result.content[0].text).toMatch(/belongs to repo "b"/);
  });

  it('the refused update really did not write', async () => {
    const before = await peerContent(foreignId);
    await initDb(A);
    await callTool(A, await loadConfig(A), 'knowl_update', { id: foreignId, content: 'Rewritten from the wrong repo.' });
    await closeDb();
    expect(await peerContent(foreignId)).toBe(before);
  });

  it('knowl_timeline and knowl_evidence_list refuse a foreign id', async () => {
    await initDb(A);
    const config = await loadConfig(A);
    for (const tool of ['knowl_timeline', 'knowl_evidence_list']) {
      const result = await callTool(A, config, tool, { itemId: foreignId });
      expect(result.content[0].text).toMatch(/belongs to repo "b"/);
    }
    await closeDb();
  });

  it('knowl_feedback refuses a foreign id', async () => {
    await initDb(A);
    const result = await callTool(A, await loadConfig(A), 'knowl_feedback', { itemId: foreignId, used: true });
    await closeDb();
    expect(result.content[0].text).toMatch(/belongs to repo "b"/);
  });

  it('local items are unaffected', async () => {
    await initDb(A);
    const result = await callTool(A, await loadConfig(A), 'knowl_update', { id: localId, content: 'Updated locally, which is allowed.' });
    await closeDb();
    expect(result.content[0].text).not.toMatch(/belongs to repo/);
  });

  it('an unlinked repo behaves exactly as before', async () => {
    await initDb(SOLO);
    const result = await callTool(SOLO, await loadConfig(SOLO), 'knowl_update', { id: soloId, content: 'Fine, no workspace here.' });
    await closeDb();
    expect(result.content[0].text).not.toMatch(/belongs to repo/);
  });
});
