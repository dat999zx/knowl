import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

/**
 * `__projectRoot` on a tool call: answer for the session's repository, not the server's.
 *
 * Every host but one launches a server per project, so the server's own directory is the answer.
 * Hermes Desktop launches ONE for every session, from a directory that is no project at all, and
 * its config has no per-project scope to fix that with. So the caller supplies the root per call
 * -- injected by the shipped plugin, never by the model, since no tool schema declares it.
 *
 * The three cases below are the whole contract: it works for the host it was built for, it is
 * refused everywhere else, and a root holding no project is refused rather than quietly falling
 * back to the server's own -- which is how a call meant for one repository answers from another.
 */

const HOME = path.join(os.tmpdir(), 'knowl-pro-home');
const PROJECT = path.join(os.tmpdir(), 'knowl-pro-project');

class InMemoryTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: any) => void;
  onSend?: (message: any) => void;
  async start(): Promise<void> {}
  async send(message: any): Promise<void> { this.onSend?.(message); }
  async close(): Promise<void> { this.onclose?.(); }
}

/** A server rooted at `serverRoot` (or nowhere), as `serve --host <host>` would start it. */
async function callTool(serverRoot: string | null, host: string | undefined, name: string, args: Record<string, unknown>) {
  const server = createMcpServer(null, serverRoot, DEFAULT_CONFIG, null, { host });
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

const textOf = (result: any) => (result?.content ?? []).map((part: any) => part.text).join('\n');

describe('per-call project root', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb().catch(() => {});
    await releaseAll().catch(() => {});
    for (const dir of [HOME, PROJECT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(HOME, { recursive: true });
    // The project the session is in, holding one findable atom.
    await fs.mkdir(path.join(PROJECT, '.knowl'), { recursive: true });
    await saveConfig(PROJECT, { ...DEFAULT_CONFIG });
    await initDb(PROJECT);
    const project = await repo.createProject(PROJECT, 'pro-project');
    await storeKnowledgeItemDeduped(project.id, {
      category: 'decision',
      title: 'Ferrets are deployed on Tuesday',
      content: 'The ferret rollout window is Tuesday, agreed with the platform team.',
    });
    await closeDb();
    await releaseAll();
  });

  afterEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll().catch(() => {});
    // Windows holds the sqlite file and its -wal/-shm siblings a moment after the pool lets go,
    // so a failed unlink here is teardown noise, not a result. The next `beforeEach` removes the
    // directory again anyway.
    for (const dir of [HOME, PROJECT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('answers from the named project when the server itself is rooted nowhere', async () => {
    const result = await callTool(null, 'hermes', 'knowl_query', { query: 'ferrets deployed Tuesday', __projectRoot: PROJECT });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Ferrets are deployed on Tuesday');
  });

  it('refuses the override for any other host, rather than ignoring it', async () => {
    // Ignoring it would run the call against the server's own project -- the wrong repository,
    // reported as a success.
    const result = await callTool(HOME, 'claude', 'knowl_query', { query: 'ferrets', __projectRoot: PROJECT });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('--host hermes');
  });

  it('refuses a root that holds no Knowl project', async () => {
    const result = await callTool(null, 'hermes', 'knowl_query', { query: 'ferrets', __projectRoot: HOME });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('No Knowl project at');
  });

  it('is invisible to the model: no tool schema declares it', async () => {
    const server = createMcpServer(null, PROJECT, DEFAULT_CONFIG, null, { host: 'hermes' });
    const transport = new InMemoryTransport();
    await server.connect(transport as any);
    const initialized = new Promise<any>(resolve => { transport.onSend = m => { if (m.id === 'init') resolve(m); }; });
    transport.onmessage!({
      jsonrpc: '2.0', id: 'init', method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    });
    await initialized;
    transport.onmessage!({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const listed = new Promise<any>(resolve => { transport.onSend = m => { if (m.id === 'list') resolve(m); }; });
    transport.onmessage!({ jsonrpc: '2.0', id: 'list', method: 'tools/list', params: {} });
    const tools = (await listed).result.tools as Array<{ name: string; inputSchema: any }>;
    await server.close();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(Object.keys(tool.inputSchema?.properties ?? {}), tool.name).not.toContain('__projectRoot');
    }
  });
});
