import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { MAX_ITEM_CONTENT_CHARS } from '../../src/core/token-budget.js';
import type { ProjectConfig } from '../../src/core/types.js';

/**
 * The second half of progressive disclosure: read a truncated result in full.
 *
 * A search result is capped at MAX_ITEM_CONTENT_CHARS and marked `truncated`, and until now no
 * tool could return the rest -- on a real store 262 of 639 atoms exceeded the ceiling. `id`
 * fetches one item whole, plus the fields a search result drops (reasoning, provenance, source,
 * timestamps). A parameter rather than a 31st tool, because the tool list is already the
 * heaviest thing on the surface.
 */

const TEST_ROOT = path.resolve('.knowl-fetch-by-id');
const CONFIG: ProjectConfig = { version: 1, security: { rejectSecrets: true, secretPatterns: [] } };

class InMemoryTransport {
  onclose?: () => void; onerror?: (e: Error) => void; onmessage?: (m: any) => void; onSend?: (m: any) => void;
  async start(): Promise<void> {}
  async send(m: any): Promise<void> { this.onSend?.(m); }
  async close(): Promise<void> { this.onclose?.(); }
}

let projectId = '';

async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const server = createMcpServer(projectId, TEST_ROOT, CONFIG);
  const transport = new InMemoryTransport();
  await server.connect(transport as never);
  const waitFor = (id: string) => new Promise<any>(res => { transport.onSend = m => { if (m.id === id) res(m); }; });
  const initialized = waitFor('init');
  transport.onmessage!({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  await initialized;
  transport.onmessage!({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const answered = waitFor('call');
  transport.onmessage!({ jsonrpc: '2.0', id: 'call', method: 'tools/call', params: { name, arguments: args } });
  const response = await answered;
  await server.close();
  return response.result;
}

const parse = (result: any) => JSON.parse(String(result?.content?.[0]?.text ?? ''));

describe('knowl_query fetch-by-id', () => {
  let bigId = '';

  beforeAll(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
    projectId = (await repo.createProject(TEST_ROOT, 'fetch')).id;
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'decision',
      title: 'Ledger reconciliation policy',
      content: `Reconciliation detail. ${'Sentence about the reconciliation pass. '.repeat(Math.ceil((MAX_ITEM_CONTENT_CHARS * 1.5) / 40))}`,
      reasoning: 'REASONING-SENTINEL: chosen because settlement is idempotent.',
      alternatives: ['polling the ledger', 'a nightly batch'],
    });
    bigId = item.id;
  });

  afterAll(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('returns the whole item and the fields a search result omits', async () => {
    const search = parse(await call('knowl_query', { query: 'ledger reconciliation policy' }));
    expect(search[0].truncated).toBe(true);

    const [full] = parse(await call('knowl_query', { id: bigId }));
    expect(full.content.length).toBeGreaterThan(search[0].content.length);
    expect(full.content).not.toMatch(/\[Content truncated\]/);
    // reasoning is REQUIRED by knowl_decide and no tool could ever read it back until now.
    expect(full.reasoning).toContain('REASONING-SENTINEL');
    expect(full.alternatives).toContain('a nightly batch');
    expect(full).toHaveProperty('createdAt');
  });

  it('refuses an unknown id with isError, not an empty array that reads as a miss', async () => {
    const result = await call('knowl_query', { id: 'no-such-item' });
    expect(result.isError).toBe(true);
    expect(String(result.content[0].text)).toMatch(/No knowledge item/i);
  });
});
