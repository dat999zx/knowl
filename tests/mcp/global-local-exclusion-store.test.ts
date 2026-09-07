import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb, withDbPath } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';
import { globalStorePath } from '../../src/core/paths.js';
import type { ProjectConfig } from '../../src/core/types.js';

/**
 * `local` must exclude in the store that holds the atom, on the MCP path too.
 *
 * `knowl_store` writes a non-project namespace inside a `withDbPath` scope and then runs the
 * `local` exclusion OUTSIDE it, against the ambient handle. The atom lands in the namespace
 * store and the `cloud_excluded` row lands in the project store, so the two never meet: the
 * global store's publisher reads its own exclusion table, finds nothing, and stages an atom the
 * caller was told would never be published.
 *
 * This is the MCP twin of the CLI defect, and it is load-bearing here for a second reason --
 * scoping `ensureGlobalStore` to `withDbPath` (as it must be) removes the accidental rebinding
 * that used to leave the ambient handle pointing at the global store, which is what made the
 * exclusion land in the right file by luck.
 */
const HOME = path.join(os.tmpdir(), 'knowl-mcp-local-home');
const ROOT = path.join(os.tmpdir(), 'knowl-mcp-local-root');

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

const excludedIn = async (dbPath: string): Promise<string[]> =>
  withDbPath(dbPath, async () => {
    const rows = (await getClient().execute('SELECT item_id FROM cloud_excluded')).rows;
    return rows.map(row => String(row.item_id));
  });

describe('knowl_store namespace=global with local', () => {
  const saved = process.env.KNOWL_HOME;

  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb().catch(() => {});
    await releaseAll().catch(() => {});
    for (const dir of [HOME, ROOT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await saveConfig(ROOT, { ...DEFAULT_CONFIG });
    await initDb(ROOT);
    await repo.createProject(ROOT, 'mcp-local-probe');
    await closeDb();
    await releaseAll().catch(() => {});
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env.KNOWL_HOME;
    else process.env.KNOWL_HOME = saved;
    await closeDb().catch(() => {});
    await releaseAll().catch(() => {});
    for (const dir of [HOME, ROOT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('records the exclusion in the global store, beside the atom it excludes', async () => {
    const result = await callTool(ROOT, { ...DEFAULT_CONFIG }, 'knowl_store', {
      category: 'fact',
      title: 'machine local probe',
      content: 'A machine-wide note that must never reach the team.',
      namespace: 'global',
      local: true,
    });

    const text = String(result.content[0].text);
    expect(text).toContain('Marked local');
    const id = /stored fact ([0-9a-f]+)/i.exec(text)?.[1];
    expect(id).toBeTruthy();

    await releaseAll();
    expect(await excludedIn(globalStorePath())).toContain(id);
    await releaseAll();
    expect(await excludedIn(path.join(ROOT, '.knowl', 'knowl.db'))).not.toContain(id);
  });
});
