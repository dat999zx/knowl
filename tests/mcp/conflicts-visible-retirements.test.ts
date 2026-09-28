import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../../src/core/config.js';

const ROOT = path.join(os.tmpdir(), 'knowl-conflicts-visible-retirements');

// Same in-memory MCP round trip as tests/mcp/act-as-repo.test.ts: the handler's output shape and
// its truncation notice are what an agent reads, so the test goes through the server.
class InMemoryTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: any) => void;
  onSend?: (message: any) => void;
  async start(): Promise<void> {}
  async send(message: any): Promise<void> { this.onSend?.(message); }
  async close(): Promise<void> { this.onclose?.(); }
}

async function callTool(name: string, args: Record<string, unknown>) {
  const server = createMcpServer('local', ROOT, await loadConfig(ROOT), null, {});
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

afterAll(async () => {
  await closeDb();
  releaseAll();
  await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
});

it('knowl_conflicts returns retired and sameSubject, truncating each at 5 (#165 R1)', async () => {
  await closeDb();
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
  await saveConfig(ROOT, { ...DEFAULT_CONFIG });
  await initDb(ROOT);
  const projectId = (await repo.createProject(ROOT, 'conflicts-visible-retirements')).id;
  for (let i = 1; i <= 6; i++) {
    const title = `Subject ${i} lifetime`;
    await storeKnowledgeItemDeduped(projectId, {
      category: 'constraint', title, content: `Subject ${i} expires after 15 minutes.`, provenance: 'observed',
    });
    const swap = await storeKnowledgeItemDeduped(projectId, {
      category: 'constraint', title, content: `Subject ${i} expires after 30 days.`,
    });
    expect(swap.superseded).toBeDefined();
  }
  for (const name of ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot']) {
    const title = `${name} cache window`;
    await repo.createKnowledgeItem(projectId, { category: 'decision', title, content: `${name} caches for 5 minutes.`, provenance: 'observed' });
    await repo.createKnowledgeItem(projectId, { category: 'decision', title, content: `${name} caches for 1 hour.` });
  }

  // The DB stays open: `knowl serve` inits it before any tool call, and the handler relies on that.
  const result = await callTool('knowl_conflicts', {});
  const payload = JSON.parse(String(result.content[0].text));
  expect(Object.keys(payload)).toEqual(['declared', 'polarity', 'retired', 'sameSubject']);
  expect(payload.retired).toHaveLength(5);
  expect(payload.sameSubject).toHaveLength(5);
  expect(String(result.content[1].text)).toContain('1 retired');
  expect(String(result.content[1].text)).toContain('1 same-subject');
});
