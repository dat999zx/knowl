import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { knowlToolDefinitions } from '../../src/mcp/tools.js';
import { MAX_ITEM_CONTENT_CHARS } from '../../src/core/token-budget.js';
import type { ProjectConfig } from '../../src/core/types.js';

/**
 * What a memory read hands back when it cannot hand back everything.
 *
 * Measured on the three real stores on this machine (710 active items): 84-94% of them are
 * longer than the 600-character ceiling, so the typical result is roughly a third of the atom,
 * cut with the empty marker -- no ellipsis, no flag. Over the same machine's transcript
 * archive, 356 archived cases had an agent query memory and then open a file within three
 * tool calls; the file it opened was named in the query result 17.1% of the time. It could not
 * have been more: `compactKnowledgeItem` is an allowlist and `affectedPaths` was not on it, so
 * roughly half the store carried a pointer to the answer that no caller ever saw.
 *
 * Both halves are asserted through the real MCP boundary rather than on the compact object,
 * because that boundary is where provenance has died before.
 */

const TEST_ROOT = path.resolve('./.knowl-mcp-query-pointer');
const CONFIG: ProjectConfig = { version: 1, security: { rejectSecrets: true, secretPatterns: [] } };

class InMemoryTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: any) => void;
  onSend?: (message: any) => void;
  async start(): Promise<void> {}
  async send(message: any): Promise<void> { this.onSend?.(message); }
  async close(): Promise<void> { this.onclose?.(); }
}

let projectId = '';

async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const server = createMcpServer(projectId, TEST_ROOT, CONFIG);
  const transport = new InMemoryTransport();
  await server.connect(transport as never);
  const waitFor = (id: string) => new Promise<any>(resolve => {
    transport.onSend = message => { if (message.id === id) resolve(message); };
  });
  const initialized = waitFor('init');
  transport.onmessage!({
    jsonrpc: '2.0', id: 'init', method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pointer-test', version: '1.0' } },
  });
  await initialized;
  transport.onmessage!({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const answered = waitFor('call');
  transport.onmessage!({ jsonrpc: '2.0', id: 'call', method: 'tools/call', params: { name, arguments: args } });
  const response = await answered;
  await server.close();
  return response.result;
}

const jsonOf = (result: any): any => JSON.parse(String(result?.content?.[0]?.text ?? ''));

describe('a truncated memory read says so, and says where the rest is', () => {
  beforeAll(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
    projectId = (await repo.createProject(TEST_ROOT, 'query-pointer')).id;

    await repo.createKnowledgeItem(projectId, {
      category: 'architecture',
      title: 'Checkout ledger reconciliation',
      // Comfortably past the ceiling, the way a real atom is.
      content: `Checkout ledger reconciliation runs after settlement. ${'Detail sentence about the reconciliation pass. '.repeat(40)}`,
      affectedPaths: ['src/billing/reconcile.ts', 'src/billing/ledger.ts'],
    });
    await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'Settlement cutoff',
      content: 'Settlement cutoff is 23:00 UTC.',
    });
  });

  afterAll(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('returns affectedPaths with the item, through the real serialization boundary', async () => {
    const items = jsonOf(await call('knowl_query', { query: 'checkout ledger reconciliation settlement', limit: 3 }));
    const hit = items.find((item: any) => item.title === 'Checkout ledger reconciliation');
    expect(hit, 'the seeded item should be retrievable').toBeTruthy();
    expect(hit.affectedPaths).toEqual(['src/billing/reconcile.ts', 'src/billing/ledger.ts']);
  });

  it('flags the truncated body so a caller can tell a partial answer from a whole one', async () => {
    const items = jsonOf(await call('knowl_query', { query: 'checkout ledger reconciliation settlement', limit: 3 }));
    const long = items.find((item: any) => item.title === 'Checkout ledger reconciliation');
    expect(long.truncated).toBe(true);
    expect(long.content.length).toBe(MAX_ITEM_CONTENT_CHARS);

    const short = items.find((item: any) => item.title === 'Settlement cutoff');
    if (short) {
      // A complete atom must stay silent, or the flag means nothing.
      expect(short).not.toHaveProperty('truncated');
      expect(short).not.toHaveProperty('affectedPaths');
    }
  });

  /**
   * The description has to describe what now comes back. Five of twenty-five shipping
   * retrieval-tool descriptions surveyed say anything about their own response shape, and a
   * caller told to "answer from Knowl without inspecting repository files" cannot honour that
   * instruction without knowing the body was cut.
   */
  it('documents the response shape and the miss rule in the tool description', () => {
    const query = knowlToolDefinitions(CONFIG).find(tool => tool.name === 'knowl_query');
    expect(query).toBeTruthy();
    expect(query!.description).toContain('affectedPaths');
    expect(query!.description).toContain('truncated');
    // Miss recovery: re-query before falling back to files, with the reason attached.
    expect(query!.description).toMatch(/re-run once with different words first/);
    // The retry is an addition to the file-fallback rule, never a replacement for it: conflict,
    // staleness and explicit verification still send a reader to the files on the first pass.
    expect(query!.description).toContain('Inspect files only on miss, conflict, stale or low-confidence results, or explicit verification requests');
    // The refuted numeric cap must not return here either.
    expect(query!.description).not.toMatch(/\d+\s*-\s*\d+\s+keywords/i);
    const queryParam = (query!.inputSchema as any).properties.query.description;
    expect(queryParam).not.toMatch(/\d+\s*-\s*\d+\s+concise keywords/i);
    expect(queryParam).toMatch(/relevance/i);
  });

  it('tells a writer what affectedPaths is for, now that it is delivered', () => {
    const store = knowlToolDefinitions(CONFIG).find(tool => tool.name === 'knowl_store');
    const description = (store!.inputSchema as any).properties.affectedPaths.description;
    expect(description).toMatch(/returned with the item|every query that returns this item/i);
  });
});
