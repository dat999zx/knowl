import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { createMcpServer } from '../../src/mcp/server.js';
import type { ProjectConfig } from '../../src/core/types.js';

/**
 * Whether a call failed has to be readable from the response.
 *
 * Three separate ways this surface said "fine" when it meant "no":
 *
 * - `arguments` is optional in the protocol, and a conformant client omits it for a tool whose
 *   properties are all optional. The argument validator was taught to treat that as `{}`; the
 *   handlers still destructured `args` directly, so the four zero-required tools threw a raw
 *   `Cannot destructure property ... of undefined` onto the wire.
 * - A tool name the server does not serve is a malformed request. Thrown as a plain Error it
 *   landed in the generic catch and came back as `isError` inside a *successful* response.
 * - A resource URI that does not exist is the caller's mistake (-32602), not the server's
 *   (-32603) -- and re-wrapping it as a plain Error meant the SDK reported the latter.
 *
 * The opposite case is asserted too: SEP-1303 wants *argument* validation to arrive as a tool
 * execution error so the model can read it and correct itself, so that one must stay `isError`.
 */

const TEST_ROOT = path.resolve('./.knowl-mcp-error-signalling');
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

/** Returns the whole JSON-RPC response, so `error` is inspectable and not just `result`. */
async function rpc(method: string, params: Record<string, unknown>): Promise<any> {
  const server = createMcpServer(projectId, TEST_ROOT, CONFIG);
  const transport = new InMemoryTransport();
  await server.connect(transport as never);
  const waitFor = (id: string) => new Promise<any>(resolve => {
    transport.onSend = message => { if (message.id === id) resolve(message); };
  });
  const initialized = waitFor('init');
  transport.onmessage!({
    jsonrpc: '2.0', id: 'init', method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'error-test', version: '1.0' } },
  });
  await initialized;
  transport.onmessage!({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const answered = waitFor('call');
  transport.onmessage!({ jsonrpc: '2.0', id: 'call', method, params });
  const response = await answered;
  await server.close();
  return response;
}

const INVALID_PARAMS = -32602;

describe('a failed MCP call is distinguishable from a successful one', () => {
  beforeAll(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
    projectId = (await repo.createProject(TEST_ROOT, 'error-signalling')).id;
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

  // Note the params object: no `arguments` key at all, which is what the protocol permits and
  // what a conformant client actually sends for these four.
  for (const tool of ['knowl_query', 'knowl_state', 'knowl_recent', 'knowl_resume']) {
    it(`${tool} survives a call that omits arguments entirely`, async () => {
      const response = await rpc('tools/call', { name: tool });
      const text = String(response.result?.content?.[0]?.text ?? response.error?.message ?? '');
      expect(text).not.toMatch(/Cannot destructure/i);
    });
  }

  it('reports an unknown tool as a protocol error, not a successful isError result', async () => {
    const response = await rpc('tools/call', { name: 'knowl_not_a_tool', arguments: {} });
    expect(response.error?.code).toBe(INVALID_PARAMS);
  });

  it('reports a missing resource as invalid params rather than an internal failure', async () => {
    const response = await rpc('resources/read', { uri: 'knowl://definitely-not-a-resource' });
    expect(response.error?.code).toBe(INVALID_PARAMS);
  });

  it('still returns argument-validation failures as isError so the model can self-correct', async () => {
    const response = await rpc('tools/call', { name: 'knowl_query', arguments: { limit: 9999 } });
    expect(response.error).toBeUndefined();
    expect(response.result?.isError).toBe(true);
  });
});
