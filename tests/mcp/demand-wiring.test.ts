import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { reindexKnowledgeEmbeddings } from '../../src/store/vector-index.js';
import { createLocalEmbeddingProvider } from '../../src/ai/embeddings.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { createManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { joinWorkspace } from '../../src/workspace/membership.js';
import { closeDemandDb, summarizeDemand } from '../../src/workspace/demand-ledger.js';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../../src/core/config.js';
import type { ProjectConfig } from '../../src/core/types.js';

const HOME = path.resolve('./.knowl-demandwire-home');
const A = path.resolve('./.knowl-demandwire-a');
const B = path.resolve('./.knowl-demandwire-b');
const SOLO = path.resolve('./.knowl-demandwire-solo');
const MODEL_CACHE = path.resolve('./.knowl/models');

let counter = 0;
let ws = '';

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

/**
 * The rows of a query payload, whichever shape it came back in.
 *
 * A workspace response is keyed by repo once a linked repo contributes a row, and these tests
 * are about what the ledger recorded rather than about how the payload was laid out. Groups
 * arrive in relevance order, so the flattened first row is still the top-scoring one.
 */
function rowsOf(text: string): any[] {
  const payload = JSON.parse(text);
  return Array.isArray(payload) ? payload : Object.values(payload).flat() as any[];
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

/**
 * The ledger write is fire-and-forget, so the row lands after the tool has already answered.
 *
 * Polling rather than a fixed sleep: the point of `void`-ing the write is that the response does
 * not wait for it, and a test that asserted immediately would be asserting the opposite.
 */
async function eventuallyTotal(name: string, expected: number, timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let total = 0;
  while (Date.now() < deadline) {
    total = (await summarizeDemand(name)).total;
    if (total >= expected) return total;
    await new Promise(resolve => { setTimeout(resolve, 25); });
  }
  return total;
}

describe('demand ledger wiring', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    await closeDemandDb();
    ws = `wire${counter += 1}`;
    for (const dir of [A, B, SOLO]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await writeManifest(workspaceManifestPath(ws), createManifest(ws, null));
    await seed(A, 'a', [{ title: 'Local auth note', content: 'Auth tokens expire locally.', visibility: 'repo' }]);
    await seed(B, 'b', [{ title: 'Auth token TTL', content: 'Auth tokens expire after fifteen minutes.', visibility: 'workspace' }]);
    await joinWorkspace({ projectRoot: A, workspaceName: ws, repoName: 'a' });
    await joinWorkspace({ projectRoot: B, workspaceName: ws, repoName: 'b' });
  });

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    await closeDemandDb();
    for (const dir of [A, B, SOLO]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('records a federated query, with the repo that answered it', async () => {
    await initDb(A);
    const result = await callTool(A, await loadConfig(A), 'knowl_query', { query: 'auth token expire', limit: 5 });
    await closeDb();
    expect(rowsOf(result.content[0].text).length).toBeGreaterThan(0);

    expect(await eventuallyTotal(ws, 1)).toBe(1);
    const summary = await summarizeDemand(ws);
    expect(summary.byKind).toEqual([{ kind: 'federated_query', count: 1 }]);
    expect(summary.byQueryingRepo).toEqual([{ repo: 'a', count: 1 }]);
    expect(summary.byServingRepo.length).toBe(1);
    expect(summary.topQuestions[0].terms).toBe('auth token expire');
  });

  it('records a query that found nothing, which is the interesting one', async () => {
    // The event this feature exists to count. A miss is what a promotion would have fixed, so a
    // ledger that only recorded hits would be blind to exactly its own subject matter.
    await initDb(A);
    await callTool(A, await loadConfig(A), 'knowl_query', { query: 'ceramic glaze firing schedule', limit: 5 });
    await closeDb();

    expect(await eventuallyTotal(ws, 1)).toBe(1);
    expect((await summarizeDemand(ws)).topQuestions[0].terms).toBe('ceramic glaze firing schedule');
  });

  it('records the raw cosine, not the fused score', async () => {
    // The column is the calibration readout -- a "weak query" threshold gets chosen from its
    // distribution -- so it has to hold a number that means the same thing on every row.
    // `finalScore` does not: its semantic half is min-max scaled across the candidate page, so
    // the best row lands near 1.0 whether its cosine was 0.9 or 0.2. Cosine is what the
    // relevance floor is measured against, which is what makes a threshold picked here
    // comparable to the shipped per-model floors.
    for (const root of [A, B]) {
      await initDb(root);
      await reindexKnowledgeEmbeddings('local', await createLocalEmbeddingProvider(await loadConfig(root), root));
      await closeDb();
    }

    await initDb(A);
    const result = await callTool(A, await loadConfig(A), 'knowl_query', { query: 'auth token expire', limit: 5, explain: true });
    await closeDb();

    const items = rowsOf(result.content[0].text) as Array<{ explanation?: { finalScore?: number; uncalibrated?: string; contributions?: { semantic?: number } } }>;
    const bestCosine = Math.max(...items
      .filter(item => !item.explanation?.uncalibrated)
      .map(item => item.explanation?.contributions?.semantic ?? 0));
    expect(bestCosine).toBeGreaterThan(0);

    expect(await eventuallyTotal(ws, 1)).toBe(1);
    const { scores } = await summarizeDemand(ws);
    expect(scores.withScore).toBe(1);
    expect(scores.max).toBeCloseTo(bestCosine, 6);

    // And not the number it used to record. Stated as a distinct assertion because the two
    // coinciding would make the one above pass while proving nothing.
    const topFused = items[0]?.explanation?.finalScore;
    expect(typeof topFused).toBe('number');
    expect(Math.abs(topFused! - bestCosine)).toBeGreaterThan(1e-6);
  });

  it('records no score at all when no semantic half ran', async () => {
    // With vector off, ranking is each corpus's rows divided by its own best hit, so the top
    // row scores near 1.0 whatever it is -- an order, not a strength. Writing that into the
    // calibration column would fill it with ~1.0 rows carrying no information, and a threshold
    // chosen from that distribution would be picked from noise. The demand row still lands;
    // only the number is withheld, on exactly the predicate `knowl_query` withholds a published
    // score on.
    const base = await loadConfig(A);
    const noVector = { ...base, search: { ...base.search, vector: { ...base.search?.vector, enabled: false } } };

    await initDb(A);
    await callTool(A, noVector, 'knowl_query', { query: 'auth token expire', limit: 5 });
    await closeDb();

    expect(await eventuallyTotal(ws, 1)).toBe(1);
    const summary = await summarizeDemand(ws);
    expect(summary.total).toBe(1);
    expect(summary.scores.withScore).toBe(0);
  });

  it('writes nothing at all outside a workspace', async () => {
    // The no-workspace guarantee: an unlinked repo behaves exactly as before, and that includes
    // creating no files it did not create yesterday.
    await seed(SOLO, 'solo', [{ title: 'Solo note', content: 'Auth tokens expire in the solo repo.', visibility: 'repo' }]);
    await initDb(SOLO);
    const result = await callTool(SOLO, await loadConfig(SOLO), 'knowl_query', { query: 'auth', limit: 5 });
    await closeDb();

    expect(JSON.parse(result.content[0].text).length).toBeGreaterThan(0);
    expect((await summarizeDemand(ws)).total).toBe(0);
  });

  it('answers the query even when the ledger cannot be written', async () => {
    // The contract that makes this safe to put on the response path. The workspace directory is
    // replaced by a FILE, so every attempt to create `demand.db` under it fails at the
    // filesystem -- and the query must not notice.
    const dir = path.dirname(path.join(HOME, 'workspaces', ws, 'demand.db'));
    await closeDemandDb();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await fs.writeFile(dir, 'not a directory');

    await initDb(A);
    const result = await callTool(A, await loadConfig(A), 'knowl_query', { query: 'auth token expire', limit: 5 });
    await closeDb();

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text).length).toBeGreaterThan(0);
  });
});
