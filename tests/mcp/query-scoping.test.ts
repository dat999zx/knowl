import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
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

// Numbered per test: the convention global-teardown.ts describes for suites needing genuine
// per-test isolation. The wipe fails EBUSY on Windows and is swallowed on purpose, so nothing is
// removed mid-run and state would otherwise accumulate. See federated-grouping for the measurement.
let fixture = 0;
let HOME = '';
let A = '';
let B = '';

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
  }, 120_000);
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
  await saveConfig(root, { ...DEFAULT_CONFIG });
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

async function query(args: Record<string, unknown>) {
  // The server reads the ambient database rather than opening its own, so the caller owns the
  // handle -- same as every other MCP test here.
  await initDb(A);
  try {
    return await callTool(A, await loadConfig(A), 'knowl_query', args);
  } finally {
    await closeDb();
  }
}

const noticeOf = (response: any) => response.content.map((block: any) => block.text).join('\n');

/**
 * The reported bug, at the surface an agent actually reads.
 *
 * Repo `a` has never touched deployment and repo `b` has. The `repo` field was already on every
 * row and lost to a standing instruction to use a relevant hit immediately -- so the fix is the
 * response SHAPE, which cannot be skimmed past.
 */
describe('knowl_query scoping', () => {
  beforeEach(async () => {
    fixture += 1;
    HOME = path.resolve(`./.knowl-qscope-${fixture}-home`);
    A = path.resolve(`./.knowl-qscope-${fixture}-a`);
    B = path.resolve(`./.knowl-qscope-${fixture}-b`);
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));
    await seed(A, 'a', [
      { title: 'Local auth note', content: 'Auth tokens expire locally.', visibility: 'repo' },
    ]);
    await seed(B, 'b', [
      { title: 'Deploy runs on tag push', content: 'Deployment is triggered by pushing a tag.', visibility: 'workspace' },
    ]);
    await joinWorkspace({ projectRoot: A, workspaceName: 'ws', repoName: 'a' });
    await joinWorkspace({ projectRoot: B, workspaceName: 'ws', repoName: 'b' });
  }, 120_000);

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
  }, 120_000);

  afterAll(async () => {
    for (let index = 1; index <= fixture; index += 1) {
      for (const suffix of ['home', 'a', 'b']) {
        await fs.rm(path.resolve(`./.knowl-qscope-${index}-${suffix}`), { recursive: true, force: true }).catch(() => {});
      }
    }
  }, 120_000);

  it('returns a grouped first block when a peer row wins a slot', async () => {
    const parsed = JSON.parse((await query({ query: 'deployment tag push', limit: 5 })).content[0].text);

    expect(Array.isArray(parsed)).toBe(false);
    expect(parsed.a).toEqual([]);
    expect(parsed.b[0].title).toBe('Deploy runs on tag push');
  }, 120_000);

  it('says LOCAL MISS, naming this repo, when the local group is empty', async () => {
    const notice = noticeOf(await query({ query: 'deployment tag push', limit: 5 }));

    expect(notice).toContain('LOCAL MISS');
    expect(notice).toContain('describes');
  }, 120_000);

  it('keeps a bare array and adds no LOCAL MISS when local answers', async () => {
    const response = await query({ query: 'auth tokens expire', limit: 5 });

    expect(Array.isArray(JSON.parse(response.content[0].text))).toBe(true);
    expect(noticeOf(response)).not.toContain('LOCAL MISS');
  }, 120_000);

  it('omits the repo field inside groups, where the key already says it', async () => {
    const parsed = JSON.parse((await query({ query: 'deployment tag push', limit: 5 })).content[0].text);

    expect(parsed.b[0].repo).toBeUndefined();
  }, 120_000);

  it('keeps the repo field on a flat row, which has no key to say it', async () => {
    const parsed = JSON.parse((await query({ query: 'auth tokens expire', limit: 5 })).content[0].text);

    expect(parsed[0].repo).toBe('a');
  }, 120_000);

  it('points at a peer that reached the page with nothing, without quoting it', async () => {
    // The peer matches one query term and local matches four, so at limit 1 local takes the page
    // and the peer is invisible -- the only case where "there is more over there" is news, and
    // the only case the pointer now fires on.
    await initDb(B);
    const projectId = (await repo.createProject(B, 'b')).id;
    const extra = await storeKnowledgeItemDeduped(projectId, {
      category: 'decision', title: 'Tokens are mentioned here', content: 'Tokens appear once, in an unrelated note.',
    });
    await getClient().execute({
      sql: 'UPDATE knowledge_items SET visibility = ?, origin_repo = ? WHERE id = ?',
      args: ['workspace', 'b', extra.item.id],
    });
    await closeDb();

    const response = await query({ query: 'auth tokens expire locally', limit: 1 });
    const pointer = response.content
      .map((block: any) => block.text as string)
      .find((text: string) => text.startsWith('WORKSPACE:'));

    expect(pointer).toBeDefined();
    expect(pointer).toContain('b (1)');
    // Names and counts only. Asserted against the pointer block alone, not the whole response:
    // the row that DID win a slot carries its content legitimately, so a whole-response check
    // would fail on the payload and prove nothing about the pointer.
    expect(pointer).not.toContain('appear once');
    expect(pointer).not.toContain('unrelated note');
  }, 120_000);

  it('is grouped under scope workspace even when only local answers', async () => {
    const parsed = JSON.parse((await query({ query: 'auth tokens expire', limit: 5, scope: 'workspace' })).content[0].text);

    expect(Array.isArray(parsed)).toBe(false);
    expect(parsed.a[0].title).toBe('Local auth note');
  }, 120_000);

  it('is a bare array under scope local, whatever the peer holds', async () => {
    const parsed = JSON.parse((await query({ query: 'deployment tag push', limit: 5, scope: 'local' })).content[0].text);

    expect(parsed).toEqual([]);
  }, 120_000);
});
