import fs from 'node:fs/promises';
import os from 'node:os';
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

/**
 * `knowl_dissent`, and the `disputed` mark it puts on every later read.
 *
 * The mark is the whole product decision. A dissent that only sat in a queue would leave the
 * system knowingly serving a fact one of its repos has flagged as wrong; marking it means the
 * correction reaches whoever is about to rely on it, at the moment they ask.
 */

const HOME = path.join(os.tmpdir(), 'knowl-dtool-home');
const A = path.join(os.tmpdir(), 'knowl-dtool-a');
const B = path.join(os.tmpdir(), 'knowl-dtool-b');

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

async function seed(root: string, name: string, title: string, content: string): Promise<string> {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
  await initDb(root);
  await getClient().execute('DELETE FROM knowledge_commits');
  await getClient().execute('DELETE FROM knowledge_items');
  const projectId = (await repo.createProject(root, name)).id;
  const stored = await storeKnowledgeItemDeduped(projectId, { category: 'decision', title, content });
  await getClient().execute({
    sql: 'UPDATE knowledge_items SET visibility = ?, origin_repo = ? WHERE id = ?',
    args: ['workspace', name, stored.item.id],
  });
  await closeDb();
  return stored.item.id;
}

describe('knowl_dissent', { timeout: 180_000 }, () => {
  let ownedByB = '';

  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await writeManifest(workspaceManifestPath('dws'), createManifest('dws', null));
    await seed(A, 'a', 'Local note', 'Something only this repo knows.');
    ownedByB = await seed(B, 'b', 'Auth token TTL', 'Auth tokens expire after fifteen minutes.');
    await joinWorkspace({ projectRoot: A, workspaceName: 'dws', repoName: 'a' });
    await joinWorkspace({ projectRoot: B, workspaceName: 'dws', repoName: 'b' });
  });

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  async function recordFromA(claim = 'The TTL is five minutes, not fifteen.') {
    await initDb(A);
    const result = await callTool(A, await loadConfig(A), 'knowl_dissent', {
      action: 'record', itemId: ownedByB, claim,
    });
    await closeDb();
    return result;
  }

  it('records, and says plainly that the other repo was not edited', async () => {
    const result = await recordFromA();
    expect(result.isError).toBeFalsy();
    const text = String(result.content[0].text);
    expect(text).toContain('"b"');
    expect(text).toMatch(/Nothing in that repo changed/i);
    expect(text).toMatch(/only its owner can supersede or retire/i);
  });

  it('marks the disputed atom on a later fetch by id — the whole point of the feature', async () => {
    await recordFromA();
    await initDb(B);
    const result = await callTool(B, await loadConfig(B), 'knowl_query', { id: ownedByB });
    await closeDb();

    const [item] = JSON.parse(result.content[0].text);
    expect(item.disputed).toHaveLength(1);
    expect(item.disputed[0].by).toBe('a');
    expect(item.disputed[0].claim).toContain('five minutes');
  });

  it('the owner lists it, rejects it, and it stops marking the atom', async () => {
    await recordFromA();
    await initDb(B);
    const config = await loadConfig(B);
    const listed = await callTool(B, config, 'knowl_dissent', { action: 'list' });
    const { incoming } = JSON.parse(listed.content[0].text);
    expect(incoming).toHaveLength(1);

    const rejected = await callTool(B, config, 'knowl_dissent', {
      action: 'reject', dissentId: incoming[0].dissentId, targetItemId: ownedByB, reason: 'Measured at fifteen.',
    });
    expect(rejected.isError).toBeFalsy();
    expect(String(rejected.content[0].text)).toMatch(/reopen/i);

    const after = await callTool(B, config, 'knowl_query', { id: ownedByB });
    await closeDb();
    expect(JSON.parse(after.content[0].text)[0]).not.toHaveProperty('disputed');
  });

  it('a rejection can be undone, so reconsidering stays possible', async () => {
    await recordFromA();
    await initDb(B);
    const config = await loadConfig(B);
    const { incoming } = JSON.parse((await callTool(B, config, 'knowl_dissent', { action: 'list' })).content[0].text);
    await callTool(B, config, 'knowl_dissent', { action: 'reject', dissentId: incoming[0].dissentId, targetItemId: ownedByB });
    await callTool(B, config, 'knowl_dissent', { action: 'reopen', dissentId: incoming[0].dissentId });
    const after = await callTool(B, config, 'knowl_query', { id: ownedByB });
    await closeDb();

    expect(JSON.parse(after.content[0].text)[0].disputed).toHaveLength(1);
  });

  it('defaults to listing, so an omitted action never writes', async () => {
    await initDb(A);
    const result = await callTool(A, await loadConfig(A), 'knowl_dissent', {});
    await closeDb();
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toHaveProperty('incoming');
  });

  it('refuses this repo\'s own item through the tool surface too', async () => {
    await initDb(B);
    const result = await callTool(B, await loadConfig(B), 'knowl_dissent', {
      action: 'record', itemId: ownedByB, claim: 'Wrong.',
    });
    await closeDb();
    expect(result.isError).toBe(true);
    expect(String(result.content[0].text)).toMatch(/yours to change/i);
  });

  it('the refused foreign update now points at the remedy instead of only refusing', async () => {
    await initDb(A);
    const result = await callTool(A, await loadConfig(A), 'knowl_update', {
      id: ownedByB, content: 'Rewritten from the wrong repo.',
    });
    await closeDb();
    expect(String(result.content[0].text)).toMatch(/belongs to repo "b"/);
    expect(String(result.content[0].text)).toMatch(/dissent/i);
  });
});
