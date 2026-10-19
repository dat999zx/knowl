import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initDb, withDbPath } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import { ensureGlobalStore } from '../../src/store/global-store.js';
import * as repo from '../../src/store/repository.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';
import { globalStorePath } from '../../src/core/paths.js';
import type { ProjectConfig } from '../../src/core/types.js';

class InMemoryTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: any) => void;
  onSend?: (message: any) => void;
  async start(): Promise<void> {}
  async send(message: any): Promise<void> { this.onSend?.(message); }
  async close(): Promise<void> { this.onclose?.(); }
}

async function callTool(root: string | null, config: ProjectConfig, name: string, args: Record<string, unknown>) {
  const server = createMcpServer('local', root, config);
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


describe('knowl_update and global store tools with no project open', () => {
  const savedHome = process.env.KNOWL_HOME;
  let home: string;
  let root: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-update-home-'));
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-update-root-'));
    process.env.KNOWL_HOME = home;
    await closeDb().catch(() => {});
    await releaseAll().catch(() => {});
    await ensureGlobalStore();
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.KNOWL_HOME;
    else process.env.KNOWL_HOME = savedHome;
    await closeDb().catch(() => {});
    await releaseAll().catch(() => {});
    for (const dir of [home, root]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('updates a global item instead of failing with "Database has not been initialized"', async () => {
    const config = { ...DEFAULT_CONFIG };
    const stored = await callTool(null, config, 'knowl_store', {
      title: 'Update probe', content: 'before the update', category: 'state',
    });
    expect(stored.isError).not.toBe(true);
    const id = await withDbPath(globalStorePath(), async () => (await repo.listKnowledgeItems())[0].id);

    const result = await callTool(null, config, 'knowl_update', { id, content: 'after the update' });
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('Successfully updated');
    const content = await withDbPath(globalStorePath(), async () => (await repo.getKnowledgeItem(id))?.content);
    expect(content).toBe('after the update');
  });

  it('updates a global item from a project checkout via withItemNamespace', async () => {
    await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
    const config = { ...DEFAULT_CONFIG };
    await saveConfig(root, config);
    await initDb(root);
    await repo.createProject(root, 'update-global-probe');

    const stored = await callTool(root, config, 'knowl_store', {
      title: 'Global goal probe', content: 'pending', category: 'goal', namespace: 'global',
    });
    expect(stored.isError).not.toBe(true);
    const globalId = await withDbPath(globalStorePath(), async () => (await repo.listKnowledgeItems())[0].id);

    const updated = await callTool(root, config, 'knowl_update', {
      id: globalId, category: 'state', content: 'completed',
    });
    expect(updated.isError).not.toBe(true);
    const item = await withDbPath(globalStorePath(), async () => repo.getKnowledgeItem(globalId));
    expect(item?.category).toBe('state');
    expect(item?.content).toBe('completed');
  });

  it('runs ingest_atoms, decide, timeline, evidence_list, feedback, conflicts, and context with no project open', async () => {
    const config = { ...DEFAULT_CONFIG };

    const ingested = await callTool(null, config, 'knowl_ingest_atoms', {
      atoms: [{ category: 'fact', title: 'Batch global atom', content: 'Batch stored in global.' }],
    });
    expect(ingested.isError).not.toBe(true);

    const decided = await callTool(null, config, 'knowl_decide', {
      title: 'Global decision', content: 'Use pnpm', reasoning: 'Faster installs',
    });
    expect(decided.isError).not.toBe(true);

    const items = await withDbPath(globalStorePath(), () => repo.listKnowledgeItems());
    expect(items.map(i => i.title)).toEqual(expect.arrayContaining(['Batch global atom', 'Global decision']));
    const targetId = items[0].id;

    for (const [name, args] of [
      ['knowl_timeline', { itemId: targetId }],
      ['knowl_evidence_list', { itemId: targetId }],
      ['knowl_feedback', { itemId: targetId, used: true, useful: true }],
      ['knowl_conflicts', {}],
      ['knowl_context', { query: 'pnpm', tokenBudget: 500 }],
      ['knowl_gc_preview', {}],
    ] as const) {
      const res = await callTool(null, config, name, args);
      expect(res.isError, `${name} failed: ${res.content?.[0]?.text}`).not.toBe(true);
    }
  });
});
