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

/**
 * The `pathsChanged` marker: a query row whose `affectedPaths` moved after the row was stored
 * says so, and a clean row says nothing.
 *
 * The fixtures backdate `updated_at` by SQL rather than sleeping across an mtime boundary --
 * deterministic on every filesystem, and the same trick the lineage suite uses for visibility.
 */

const HOME = path.resolve('./.knowl-pathschanged-home');
// One root per test, never reused: Windows keeps an opened database locked for the life of
// the process, so a shared root silently survives the between-test rm and leaks earlier
// tests' rows into later queries.
let seq = 0;
let A = '';
let B = '';

const BACKDATED = '2020-01-01T00:00:00.000Z';

class InMemoryTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: any) => void;
  onSend?: (message: any) => void;
  async start(): Promise<void> {}
  async send(message: any): Promise<void> { this.onSend?.(message); }
  async close(): Promise<void> { this.onclose?.(); }
}

async function callQuery(root: string, config: ProjectConfig, args: Record<string, unknown>) {
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
  transport.onmessage!({ jsonrpc: '2.0', id: 'call', method: 'tools/call', params: { name: 'knowl_query', arguments: args } });
  const result = await response;
  await server.close();
  return result.result;
}

const rowsOf = (result: any): any[] => {
  const payload = JSON.parse(result.content[0].text);
  return Array.isArray(payload) ? payload : Object.values(payload).flat();
};

async function seedRepo(root: string) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, DEFAULT_CONFIG);
  await initDb(root);
  return (await repo.createProject(root, path.basename(root))).id;
}

async function storeCiting(projectId: string, title: string, affectedPaths: string[], backdate = true) {
  const stored = await storeKnowledgeItemDeduped(projectId, {
    category: 'fact', title, content: `${title} -- body`, affectedPaths,
  });
  if (backdate) {
    await getClient().execute({
      sql: 'UPDATE knowledge_items SET updated_at = ? WHERE id = ?',
      args: [BACKDATED, stored.item.id],
    });
  }
  return stored.item.id;
}

beforeEach(async () => {
  process.env.KNOWL_HOME = HOME;
  await closeDb();
  await releaseAll();
  seq += 1;
  A = path.resolve(`./.knowl-pathschanged-a${seq}`);
  B = path.resolve(`./.knowl-pathschanged-b${seq}`);
  for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

afterEach(async () => {
  delete process.env.KNOWL_HOME;
  await closeDb();
  await releaseAll();
  for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('knowl_query pathsChanged marker', () => {
  it('flags a row whose cited file changed after the row was stored, with the count', async () => {
    const projectId = await seedRepo(A);
    await fs.mkdir(path.join(A, 'src'), { recursive: true });
    await fs.writeFile(path.join(A, 'src', 'auth.ts'), 'export const ttl = 15;');
    await storeCiting(projectId, 'Auth token TTL is fifteen minutes', ['src/auth.ts', 'src/missing.ts']);

    const result = await callQuery(A, await loadConfig(A), { query: 'auth token ttl' });
    const row = rowsOf(result).find(r => String(r.title).includes('Auth token TTL'));
    expect(row).toBeDefined();
    // Both count: the file is newer than the backdated row, and the missing one is the
    // strongest form of "moved".
    expect(row.pathsChanged).toContain('2 of 2');
    expect(row.pathsChanged).toContain('verify');
  });

  it('says nothing on a row whose files have not moved since it was stored', async () => {
    const projectId = await seedRepo(A);
    await fs.mkdir(path.join(A, 'src'), { recursive: true });
    await fs.writeFile(path.join(A, 'src', 'auth.ts'), 'export const ttl = 15;');
    // The mtime is pinned to a known past instant rather than trusted from the write: a
    // buffered write's timestamp can land AFTER the store's own clock reading on some
    // platforms (macOS and Windows on node 22, in CI), so "written before the row" does not
    // guarantee mtime <= updated_at. utimes does.
    const pinned = new Date('2019-01-01T00:00:00.000Z');
    await fs.utimes(path.join(A, 'src', 'auth.ts'), pinned, pinned);
    await storeCiting(projectId, 'Auth token TTL is fifteen minutes', ['src/auth.ts'], false);

    const result = await callQuery(A, await loadConfig(A), { query: 'auth token ttl' });
    const row = rowsOf(result).find(r => String(r.title).includes('Auth token TTL'));
    expect(row).toBeDefined();
    expect(row.pathsChanged).toBeUndefined();
  });

  it('says nothing about a path that will not resolve against this checkout', async () => {
    const projectId = await seedRepo(A);
    // `./` is stripped on write, so what actually reaches here unresolvable is an escaping or
    // absolute citation. Neither is evidence: the marker's sentence claims a MODIFICATION was
    // observed, and none was -- a permanent "verify" on a row nobody can ever clear is the
    // warning light that teaches readers to ignore the marker everywhere else.
    await storeCiting(projectId, 'Escaping citation', ['../outside.ts', '/etc/hosts']);

    const result = await callQuery(A, await loadConfig(A), { query: 'escaping citation' });
    const row = rowsOf(result).find(r => String(r.title).includes('Escaping'));
    expect(row).toBeDefined();
    expect(row.pathsChanged).toBeUndefined();
  });

  it('counts only the paths it could actually check', async () => {
    const projectId = await seedRepo(A);
    await fs.mkdir(path.join(A, 'src'), { recursive: true });
    await fs.writeFile(path.join(A, 'src', 'auth.ts'), 'export const ttl = 15;');
    await storeCiting(projectId, 'Mixed citation auth ttl', ['src/auth.ts', '../outside.ts']);

    const result = await callQuery(A, await loadConfig(A), { query: 'mixed citation auth ttl' });
    const row = rowsOf(result).find(r => String(r.title).includes('Mixed citation'));
    expect(row).toBeDefined();
    // One checkable path, and it moved. The unresolvable one is not in the denominator: the
    // sentence would otherwise understate how much of what it looked at had changed.
    expect(row.pathsChanged).toContain('1 of 1');
  });

  it('never marks a foreign row -- its paths resolve against another checkout', async () => {
    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));
    const aId = await seedRepo(A);
    await storeCiting(aId, 'Local unrelated note', []);
    await closeDb();
    const bId = await seedRepo(B);
    const foreignId = await storeCiting(bId, 'Foreign auth rotation fact', ['src/rotation.ts']);
    await getClient().execute({
      sql: "UPDATE knowledge_items SET visibility = 'workspace', origin_repo = 'b' WHERE id = ?",
      args: [foreignId],
    });
    await closeDb();
    await joinWorkspace({ projectRoot: A, workspaceName: 'ws', repoName: 'a' });
    await joinWorkspace({ projectRoot: B, workspaceName: 'ws', repoName: 'b' });

    await initDb(A);
    const result = await callQuery(A, await loadConfig(A), { query: 'auth rotation', limit: 5 });
    const row = rowsOf(result).find(r => String(r.title).includes('Foreign auth rotation'));
    expect(row).toBeDefined();
    expect(row.pathsChanged).toBeUndefined();
    expect(row.affectedPaths).toBeUndefined();
  });
});
