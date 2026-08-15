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
 * Fetching an atom a linked repo owns.
 *
 * The refusal this replaces was a *not-found*: `getKnowledgeItem` reads the local store, so a
 * sibling's id was simply absent, and the message explained that absence in ownership terms.
 * Withholding the record was never the protection -- the protection is that `affectedPaths` and
 * evidence resolve against the OWNING repo's checkout and database, which is why they stay
 * omitted here exactly as they already are on the search path.
 */

// Under os.tmpdir() for the reason the sibling refusal suite records: inside the repository,
// saveConfig raced a Windows EPERM rename during full-suite runs.
const HOME = path.join(os.tmpdir(), 'knowl-fetch-home');
const A = path.join(os.tmpdir(), 'knowl-fetch-a');
const B = path.join(os.tmpdir(), 'knowl-fetch-b');
const SOLO = path.join(os.tmpdir(), 'knowl-fetch-solo');

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

async function seed(root: string, name: string, title: string, content: string, reasoning: string): Promise<string> {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
  await initDb(root);
  await getClient().execute('DELETE FROM knowledge_commits');
  await getClient().execute('DELETE FROM knowledge_items');
  const projectId = (await repo.createProject(root, name)).id;
  const stored = await storeKnowledgeItemDeduped(projectId, { category: 'decision', title, content, reasoning });
  await getClient().execute({
    sql: 'UPDATE knowledge_items SET visibility = ?, origin_repo = ?, affected_paths = ? WHERE id = ?',
    args: ['workspace', name, JSON.stringify([`src/${name}-only.ts`]), stored.item.id],
  });
  await closeDb();
  return stored.item.id;
}

/** A second row in an already-seeded repo, kept private -- what `workspace promote` exists to change. */
async function seedPrivate(root: string, name: string, title: string, content: string): Promise<string> {
  await initDb(root);
  const project = await repo.getProjectByRootPath(root);
  const stored = await storeKnowledgeItemDeduped(project!.id, { category: 'decision', title, content });
  await getClient().execute({
    sql: 'UPDATE knowledge_items SET visibility = ?, origin_repo = ? WHERE id = ?',
    args: ['repo', name, stored.item.id],
  });
  await closeDb();
  return stored.item.id;
}

describe('knowl_query fetch-by-id reaches a linked repo', () => {
  let foreignId = '';
  let foreignPrivateId = '';
  let localId = '';
  let soloId = '';

  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B, SOLO]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));
    localId = await seed(A, 'a', 'Local auth note', 'Auth tokens expire locally.', 'LOCAL-REASONING-SENTINEL');
    foreignId = await seed(B, 'b', 'Auth token TTL', 'Auth tokens expire after fifteen minutes.', 'PEER-REASONING-SENTINEL');
    foreignPrivateId = await seedPrivate(B, 'b', 'Rotation key procedure', 'PRIVATE-SENTINEL: b never shared this.');
    soloId = await seed(SOLO, 'solo', 'Solo note', 'A note in an unlinked repo.', 'SOLO-REASONING');
    await joinWorkspace({ projectRoot: A, workspaceName: 'ws', repoName: 'a' });
    await joinWorkspace({ projectRoot: B, workspaceName: 'ws', repoName: 'b' });
  });

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B, SOLO]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('returns the peer\'s atom whole, naming the repo that owns it', async () => {
    await initDb(A);
    const result = await callTool(A, await loadConfig(A), 'knowl_query', { id: foreignId });
    await closeDb();

    expect(result.isError).toBeFalsy();
    const [item] = JSON.parse(result.content[0].text);
    expect(item.id).toBe(foreignId);
    expect(item.title).toBe('Auth token TTL');
    expect(item.content).toContain('fifteen minutes');
    // The fields a search result drops are the reason fetch-by-id exists.
    expect(item.reasoning).toContain('PEER-REASONING-SENTINEL');
    expect(item.foreign.repo).toBe('b');
  });

  it('omits the paths, which point into another checkout', async () => {
    await initDb(A);
    const result = await callTool(A, await loadConfig(A), 'knowl_query', { id: foreignId });
    await closeDb();

    const [item] = JSON.parse(result.content[0].text);
    expect(item).not.toHaveProperty('affectedPaths');
    // And says so, rather than leaving an absent key to be read as "this atom cites nothing".
    expect(item.foreign.note).toMatch(/affectedPaths/);
    expect(item.foreign.note).toContain('b');
  });

  it('still omits evidence for a foreign item even when asked, matching the search path', async () => {
    await initDb(A);
    const result = await callTool(A, await loadConfig(A), 'knowl_query', { id: foreignId, includeEvidence: true });
    await closeDb();

    const [item] = JSON.parse(result.content[0].text);
    expect(item).not.toHaveProperty('evidence');
    expect(item.foreign.note).toMatch(/evidence/);
  });

  it('leaves a local fetch exactly as it was, paths and evidence included', async () => {
    await initDb(A);
    const config = await loadConfig(A);
    const plain = await callTool(A, config, 'knowl_query', { id: localId });
    const withEvidence = await callTool(A, config, 'knowl_query', { id: localId, includeEvidence: true });
    await closeDb();

    const [item] = JSON.parse(plain.content[0].text);
    expect(item.affectedPaths).toEqual(['src/a-only.ts']);
    expect(item).not.toHaveProperty('foreign');
    // Without this the suite would pass with evidence switched off for everyone.
    expect(JSON.parse(withEvidence.content[0].text)[0]).toHaveProperty('evidence');
  });

  it('refuses a peer\'s repo-private id, exactly as a search for it would', async () => {
    // The reach of this fetch is "what the workspace shares", not "whatever the peer's file
    // happens to hold". `federated-query.ts` puts `visibility = 'workspace'` in the SQL so a
    // private row is never read into this process; an id must not be a way around that. It is
    // reported as a miss rather than as a refusal, because saying "that one is private" would
    // confirm the row exists -- and the caller was never entitled to know that either.
    await initDb(A);
    const result = await callTool(A, await loadConfig(A), 'knowl_query', { id: foreignPrivateId });
    await closeDb();

    expect(result.isError).toBe(true);
    expect(String(result.content[0].text)).not.toContain('PRIVATE-SENTINEL');
    expect(String(result.content[0].text)).not.toMatch(/private/i);
  });

  it('the owning repo still reads its own private row, which is the point of it being private', async () => {
    // Or the fix has simply deleted the row rather than scoped it.
    await initDb(B);
    const result = await callTool(B, await loadConfig(B), 'knowl_query', { id: foreignPrivateId });
    await closeDb();

    expect(result.isError).toBeFalsy();
    const [item] = JSON.parse(result.content[0].text);
    expect(item.content).toContain('PRIVATE-SENTINEL');
    expect(item).not.toHaveProperty('foreign');
  });

  it('still refuses an id no repo in the workspace holds', async () => {
    await initDb(A);
    const result = await callTool(A, await loadConfig(A), 'knowl_query', { id: 'no-such-item-000' });
    await closeDb();

    expect(result.isError).toBe(true);
    expect(String(result.content[0].text)).toMatch(/No knowledge item/i);
  });

  it('an unlinked repo behaves exactly as before', async () => {
    await initDb(SOLO);
    const config = await loadConfig(SOLO);
    const found = await callTool(SOLO, config, 'knowl_query', { id: soloId });
    const missing = await callTool(SOLO, config, 'knowl_query', { id: 'no-such-item-000' });
    await closeDb();

    expect(JSON.parse(found.content[0].text)[0].id).toBe(soloId);
    expect(missing.isError).toBe(true);
  });
}, 120_000);
