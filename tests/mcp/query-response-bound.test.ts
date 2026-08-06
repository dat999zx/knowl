import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { createMcpServer } from '../../src/mcp/server.js';
import type { ProjectConfig } from '../../src/core/types.js';

/**
 * The response ceiling costs bodies before it costs results.
 *
 * `knowl_query` had no ceiling at all -- 45,147 characters measured for a 25-result query over
 * 2,000-character atoms -- and the first fix dropped lowest-ranked results until it fit. That
 * bounded the response and cost recall: measured on a store of 25 such atoms, a `limit: 25`
 * query came back with 5 results and 20 gone, which an agent cannot tell from a store that
 * only holds 5.
 *
 * Shortening is the cheaper trade now that `knowl_query { id }` exists. A shortened result
 * keeps its id, title and score, so the agent still learns the item exists and can read it
 * whole on demand; a dropped one is indistinguishable from a miss. Dropping stays as the last
 * resort for when every body is already an excerpt.
 */

const TEST_ROOT = path.resolve('.knowl-query-bound');
const CONFIG: ProjectConfig = { version: 1, security: { rejectSecrets: true, secretPatterns: [] } };

/** Mirrors `MAX_RESPONSE_CHARS` in `src/mcp/tools.ts`, which is module-private. */
const MAX_RESPONSE_CHARS = 12_000;
const SEEDED_ITEMS = 15;

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

describe('knowl_query response bound', () => {
  beforeAll(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
    projectId = (await repo.createProject(TEST_ROOT, 'query-bound')).id;
    for (let index = 0; index < SEEDED_ITEMS; index++) {
      await repo.createKnowledgeItem(projectId, {
        category: 'fact',
        title: `Deployment rollback procedure variant ${index}`,
        content: `Rollback detail ${index}. ${'The rollback pass re-reads the ledger and replays the deployment journal. '.repeat(30)}`,
      });
    }
  });

  afterAll(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('keeps every result and excerpts the weakest bodies instead of dropping them', async () => {
    const result = await call('knowl_query', { query: 'deployment rollback procedure', limit: SEEDED_ITEMS });
    const [block, notice] = result.content;
    const items = JSON.parse(String(block.text));

    // Unbounded this is ~33,000 characters, so the ceiling genuinely binds here.
    expect(block.text.length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    expect(items).toHaveLength(SEEDED_ITEMS);

    // The tail gave up its body; every one of them still carries what an agent needs to decide
    // whether to fetch it.
    const last = items[items.length - 1];
    expect(last.truncated).toBe(true);
    expect(last.id).toBeTruthy();
    expect(last.title).toContain('Deployment rollback procedure');

    // The notice names the trade and the way out of it.
    expect(String(notice.text)).toContain('RESPONSE BOUNDED');
    expect(String(notice.text)).toContain('excerpt');
    expect(String(notice.text)).toContain('`id`');
  });

  it('says nothing when the results already fit', async () => {
    const result = await call('knowl_query', { query: 'deployment rollback procedure', limit: 2 });

    expect(result.content).toHaveLength(1);
    expect(JSON.parse(String(result.content[0].text))).toHaveLength(2);
  });
});
