import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('ai', async importOriginal => {
  const original = await importOriginal<typeof import('ai')>();
  return { ...original, generateObject: vi.fn(), generateText: vi.fn() };
});

import { generateObject } from 'ai';
import { closeDb, initDb, withDbPath } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import { resolveStorage } from '../../src/store/storage-roles.js';
import { ensureGlobalStore } from '../../src/store/global-store.js';
import * as repo from '../../src/store/repository.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';
import { globalStorePath, knowlHome } from '../../src/core/paths.js';
import type { ProjectConfig } from '../../src/core/types.js';
import { generalProfile } from '../../src/ai/profiles/general.js';
import { academicProfile } from '../../src/ai/profiles/academic.js';

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

const ai = (profile?: string) => ({
  provider: 'openai' as const,
  model: 'gpt-test',
  apiKey: 'mock-key',
  ...(profile ? { profile } : {}),
});

const queueAtom = (title: string) => {
  vi.mocked(generateObject)
    .mockResolvedValueOnce({ object: { pass: true, reason: 'personal fact' } } as any)
    .mockResolvedValueOnce({
      object: { atoms: [{ category: 'fact', title, content: `${title} is recorded.`, confidence: 1 }] },
    } as any);
};

const filterSystem = () => (vi.mocked(generateObject).mock.calls[0][0] as any).system;

const titlesIn = (dbPath: string) =>
  withDbPath(dbPath, async () => (await repo.listKnowledgeItems()).map(i => i.title));

describe('knowl_ingest into the global store', () => {
  const savedHome = process.env.KNOWL_HOME;
  let home: string;
  let root: string;
  let projectConfig: ProjectConfig;

  const saveHome = (profile?: string) =>
    saveConfig(knowlHome(), { ...DEFAULT_CONFIG, ai: ai(profile) });

  const openProject = async () => {
    await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
    projectConfig = { ...DEFAULT_CONFIG, ai: ai('general') };
    await saveConfig(root, projectConfig);
    await initDb(root);
    await repo.createProject(root, 'ingest-global-probe');
  };

  beforeEach(async () => {
    vi.resetAllMocks();
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-ingest-home-'));
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-ingest-root-'));
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

  it('writes to the global store with the home profile when no project is open', async () => {
    await saveHome('academic');
    queueAtom('Advisor one');
    const result = await callTool(null, { ...DEFAULT_CONFIG, ai: ai('academic') }, 'knowl_ingest', {
      text: 'Thesis advisor is Dr. Lan Nguyen.',
    });

    expect(result.isError).not.toBe(true);
    expect(filterSystem()).toBe(academicProfile.filter);
    expect(await titlesIn(globalStorePath())).toContain('Advisor one');
  });

  it('defaults the global store to the general profile', async () => {
    await saveHome();
    queueAtom('Advisor two');
    const result = await callTool(null, { ...DEFAULT_CONFIG, ai: ai() }, 'knowl_ingest', {
      text: 'Thesis advisor is Dr. Lan Nguyen.',
    });

    expect(result.isError).not.toBe(true);
    expect(filterSystem()).toBe(generalProfile.filter);
  });

  it('uses the project profile and store by default', async () => {
    await saveHome('academic');
    await openProject();
    queueAtom('Advisor three');
    const result = await callTool(root, projectConfig, 'knowl_ingest', { text: 'Thesis advisor is Dr. Lan Nguyen.' });

    expect(result.isError).not.toBe(true);
    expect(filterSystem()).toBe(generalProfile.filter);
    expect(await titlesIn(resolveStorage(root).knowledge)).toContain('Advisor three');
    expect(await titlesIn(globalStorePath())).not.toContain('Advisor three');
  });

  it('namespace global uses the home profile and the global store, then the next call returns to the project', async () => {
    await saveHome('academic');
    await openProject();
    queueAtom('Advisor four');
    const global = await callTool(root, projectConfig, 'knowl_ingest', {
      text: 'Thesis advisor is Dr. Lan Nguyen.',
      namespace: 'global',
    });

    expect(global.isError).not.toBe(true);
    expect(filterSystem()).toBe(academicProfile.filter);
    expect(await titlesIn(globalStorePath())).toContain('Advisor four');
    expect(await titlesIn(resolveStorage(root).knowledge)).not.toContain('Advisor four');

    // Regression pin: scoping the global write must not leave the ambient handle on the global store.
    vi.mocked(generateObject).mockReset();
    queueAtom('Advisor five');
    const local = await callTool(root, projectConfig, 'knowl_ingest', { text: 'Thesis advisor is Dr. Lan Nguyen.' });

    expect(local.isError).not.toBe(true);
    expect(await titlesIn(resolveStorage(root).knowledge)).toContain('Advisor five');
    expect(await titlesIn(globalStorePath())).not.toContain('Advisor five');
  });

  it('refuses an unknown home profile before any model call', async () => {
    await saveHome('../evil');
    await openProject();
    const result = await callTool(root, projectConfig, 'knowl_ingest', {
      text: 'Thesis advisor is Dr. Lan Nguyen.',
      namespace: 'global',
    });

    expect(result.isError).toBe(true);
    expect(String(result.content[0].text)).toContain('Unknown domain profile');
    expect(generateObject).not.toHaveBeenCalled();
  });
});
