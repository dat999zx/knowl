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
import { closeDemandDb, openDemandDb, summarizeDemand } from '../../src/workspace/demand-ledger.js';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../../src/core/config.js';
import type { ProjectConfig } from '../../src/core/types.js';

// A numbered fixture root per test, the convention global-teardown.ts describes for "suites that
// need genuine per-test isolation": the wipe fails EBUSY on Windows and is swallowed on purpose,
// so nothing is removed mid-run and state would otherwise accumulate between tests.
//
// The workspace name is numbered too, which the other suites here do not need. The demand ledger
// is keyed by workspace name and `closeDemandDb` is a module-level singleton, so a shared name
// would have two tests reading one ledger. `demand-wiring.test.ts` numbers it for the same reason.
let fixture = 0;
let ws = '';
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

/** The ledger write is fire-and-forget, so the row lands after the tool has already answered. */
async function eventuallyEvents(workspace: string, expected: number) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const summary = await summarizeDemand(workspace);
    const total = summary.byKind.reduce((sum, entry) => sum + entry.count, 0);
    if (total >= expected) return summary;
    await new Promise(resolve => { setTimeout(resolve, 25); });
  }
  return await summarizeDemand(workspace);
}

/**
 * The `detail` blob of the most recent event.
 *
 * Read from the table rather than through `summarizeDemand`, which aggregates and does not
 * surface per-event detail -- and this is a claim about one event's contents.
 */
async function latestDetail(workspace: string): Promise<Record<string, unknown>> {
  const client = await openDemandDb(workspace);
  const rows = await client.execute('SELECT detail FROM demand_events ORDER BY id DESC LIMIT 1');
  return JSON.parse(String(rows.rows[0]?.detail ?? '{}'));
}

async function query(args: Record<string, unknown>) {
  await initDb(A);
  try {
    return await callTool(A, await loadConfig(A), 'knowl_query', args);
  } finally {
    await closeDb();
  }
}

/**
 * A locally-scoped query still has to reach the ledger.
 *
 * The ledger is the measurement `docs/superpowers/specs/2026-08-07-demand-paged-scoping-design.md`
 * is waiting on to fill, and its Phase D gate is currently shut on volume alone. A scope that
 * quietly stopped recording would under-report cross-repo demand by exactly the queries most
 * likely to have wanted it -- someone narrowing to this repo is someone who noticed the
 * workspace answering questions it should not have.
 */
describe('demand ledger scoping', () => {
  beforeEach(async () => {
    fixture += 1;
    ws = `dscope${fixture}`;
    HOME = path.resolve(`./.knowl-dscope-${fixture}-home`);
    A = path.resolve(`./.knowl-dscope-${fixture}-a`);
    B = path.resolve(`./.knowl-dscope-${fixture}-b`);
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    await closeDemandDb();
    await writeManifest(workspaceManifestPath(ws), createManifest(ws, null));
    await seed(A, 'a', [
      { title: 'Local auth note', content: 'Auth tokens expire locally.', visibility: 'repo' },
    ]);
    await seed(B, 'b', [
      { title: 'Deploy runs on tag push', content: 'Deployment is triggered by pushing a tag.', visibility: 'workspace' },
    ]);
    await joinWorkspace({ projectRoot: A, workspaceName: ws, repoName: 'a' });
    await joinWorkspace({ projectRoot: B, workspaceName: ws, repoName: 'b' });
  }, 120_000);

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    await closeDemandDb();
  }, 120_000);

  afterAll(async () => {
    for (let index = 1; index <= fixture; index += 1) {
      for (const suffix of ['home', 'a', 'b']) {
        await fs.rm(path.resolve(`./.knowl-dscope-${index}-${suffix}`), { recursive: true, force: true }).catch(() => {});
      }
    }
  }, 120_000);

  it('records a federated_query even when scope is local', async () => {
    await query({ query: 'deployment', limit: 5, scope: 'local' });
    const summary = await eventuallyEvents(ws, 1);

    expect(summary.byKind).toEqual([{ kind: 'federated_query', count: 1 }]);
    expect(summary.byQueryingRepo).toEqual([{ repo: 'a', count: 1 }]);
  }, 120_000);

  it('marks the query locally scoped, so a narrowed read is not mistaken for an open one', async () => {
    await query({ query: 'deployment', limit: 5, scope: 'local' });
    await eventuallyEvents(ws, 1);

    expect((await latestDetail(ws)).scope).toBe('local');
  }, 120_000);

  it('records that this repo did not answer, when a linked repo did', async () => {
    // The quantity grouping actually changes, and nothing measured it before: how often this
    // repo is asked something only a neighbour holds.
    await query({ query: 'deployment tag push', limit: 5 });
    await eventuallyEvents(ws, 1);

    expect((await latestDetail(ws)).localAnswered).toBe(false);
  }, 120_000);

  it('records that this repo answered, when its own row is on the page', async () => {
    await query({ query: 'auth tokens expire', limit: 5 });
    await eventuallyEvents(ws, 1);

    expect((await latestDetail(ws)).localAnswered).toBe(true);
  }, 120_000);
});
