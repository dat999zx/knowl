import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { resetWriteOwnershipCache } from '../../src/store/write-ownership.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { createManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { joinWorkspace } from '../../src/workspace/membership.js';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../../src/core/config.js';
import type { ProjectConfig } from '../../src/core/types.js';

/**
 * `repo` on a tool call: do that repo's work from here.
 *
 * The distinction this draws is the one the whole cross-repo design turns on. Acting AS a repo is
 * full rights, because you are doing its work and it is correcting itself -- which folder the
 * terminal happens to sit in is not a fact about the knowledge. Noticing something wrong in
 * passing, while doing THIS repo's work, is the other case and is not this.
 */

const HOME = path.join(os.tmpdir(), 'knowl-mas-home');
const A = path.join(os.tmpdir(), 'knowl-mas-a');
const B = path.join(os.tmpdir(), 'knowl-mas-b');

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
  const projectId = (await repo.createProject(root, name)).id;
  const stored = await storeKnowledgeItemDeduped(projectId, { category: 'decision', title, content });
  await getClient().execute({
    sql: 'UPDATE knowledge_items SET visibility = ?, origin_repo = ? WHERE id = ?',
    args: ['workspace', name, stored.item.id],
  });
  await closeDb();
  return stored.item.id;
}

async function rowIn(root: string, id: string) {
  await initDb(root);
  try {
    const rows = await getClient().execute({
      sql: 'SELECT status, content, origin_repo FROM knowledge_items WHERE id = ?', args: [id],
    });
    return rows.rows[0] ?? null;
  } finally {
    await closeDb();
  }
}

describe('acting as a linked repo through the tool surface', { timeout: 180_000 }, () => {
  let ownedByB = '';

  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await writeManifest(workspaceManifestPath('mas'), createManifest('mas', null));
    await seed(A, 'a', 'Local note', 'Something only this repo knows.');
    ownedByB = await seed(B, 'b', 'Auth token TTL', 'Auth tokens expire after fifteen minutes.');
    await joinWorkspace({ projectRoot: A, workspaceName: 'mas', repoName: 'a' });
    await joinWorkspace({ projectRoot: B, workspaceName: 'mas', repoName: 'b' });
    resetWriteOwnershipCache();
  });

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('a store from A with repo:"b" lands in B, stamped as B', async () => {
    await initDb(A);
    const result = await callTool(A, await loadConfig(A), 'knowl_store', {
      repo: 'b', category: 'fact', title: 'Refresh window', content: 'The refresh window is five minutes.',
    });
    await closeDb();
    expect(result.isError).toBeFalsy();

    const id = /([0-9a-f]{16})/.exec(String(result.content[0].text))?.[1] ?? '';
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    const inB = await rowIn(B, id);
    expect(String(inB?.content)).toContain('five minutes');
    expect(String(inB?.origin_repo)).toBe('b');
    expect(await rowIn(A, id)).toBeNull();
  });

  it('the DESTRUCTIVE half works too, which is the point of acting as a repo', async () => {
    // Retiring b's knowledge from a is refused without `repo` and allowed with it -- not because
    // a guard was bypassed, but because standing in b makes b's item local, exactly as `cd` does.
    await initDb(A);
    const config = await loadConfig(A);
    const refused = await callTool(A, config, 'knowl_update', { id: ownedByB, content: 'Rewritten from the wrong repo.' });
    expect(String(refused.content[0].text)).toMatch(/belongs to repo "b"/);

    const allowed = await callTool(A, config, 'knowl_update', {
      repo: 'b', id: ownedByB, content: 'Auth tokens expire after five minutes.',
    });
    await closeDb();
    expect(allowed.isError).toBeFalsy();

    expect(String((await rowIn(B, ownedByB))?.content)).toContain('five minutes');
  });

  it('omitting repo is unchanged in every way', async () => {
    await initDb(A);
    const result = await callTool(A, await loadConfig(A), 'knowl_store', {
      category: 'fact', title: 'Stays here', content: 'Written without naming a repo.',
    });
    await closeDb();

    const id = /([0-9a-f]{16})/.exec(String(result.content[0].text))?.[1] ?? '';
    expect(String((await rowIn(A, id))?.origin_repo)).toBe('a');
    expect(await rowIn(B, id)).toBeNull();
  });

  it('a repo that is not linked is refused, and the refusal names what is', async () => {
    await initDb(A);
    const result = await callTool(A, await loadConfig(A), 'knowl_store', {
      repo: 'not-a-member', category: 'fact', title: 'Nope', content: 'Should not be written anywhere.',
    });
    await closeDb();

    expect(result.isError).toBe(true);
    expect(String(result.content[0].text)).toMatch(/No repo named "not-a-member"/);
    expect(String(result.content[0].text)).toMatch(/"a".*"b"|"b".*"a"/);
  });

  it('a refused target writes nothing anywhere', async () => {
    await initDb(A);
    const before = (await repo.listKnowledgeItems()).length;
    await callTool(A, await loadConfig(A), 'knowl_store', {
      repo: 'not-a-member', category: 'fact', title: 'Nope', content: 'Should not be written anywhere.',
    });
    const after = (await repo.listKnowledgeItems()).length;
    await closeDb();
    expect(after).toBe(before);
  });

  it('reads the target repo\'s history too, so the whole task can be done from here', async () => {
    await initDb(A);
    const result = await callTool(A, await loadConfig(A), 'knowl_timeline', { repo: 'b', itemId: ownedByB });
    await closeDb();
    // Without `repo` this is the `belongs to repo "b"` refusal; with it, it simply reads.
    expect(String(result.content[0].text)).not.toMatch(/belongs to repo/);
  });

  it('acting as yourself is a no-op rather than an error', async () => {
    await initDb(A);
    const result = await callTool(A, await loadConfig(A), 'knowl_store', {
      repo: 'a', category: 'fact', title: 'Explicitly here', content: 'Named my own repo.',
    });
    await closeDb();

    const id = /([0-9a-f]{16})/.exec(String(result.content[0].text))?.[1] ?? '';
    expect(String((await rowIn(A, id))?.origin_repo)).toBe('a');
  });
});
