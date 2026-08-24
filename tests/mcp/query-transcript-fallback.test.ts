import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { closeTranscriptDbs } from '../../src/transcripts/database.js';
import { runIndexPass } from '../../src/transcripts/index-pass.js';
import { encodeProjectDir } from '../../src/transcripts/paths.js';
import { createMcpServer } from '../../src/mcp/server.js';
import type { ProjectConfig } from '../../src/core/types.js';

/**
 * The recall chain: a `knowl_query` that missed runs transcript search itself when
 * `search.transcripts.fallback` is on, and reports a verified negative when both stores miss.
 *
 * The fixture redirects the home directory the way `mcp-handlers.test.ts` does and for the same
 * reason: the handlers always read the default archive path, and the search-time top-up would
 * otherwise look at the developer's real archive -- or delete the fixture's own index on seeing
 * an empty one.
 */

let dir: string;
let homeBefore: { HOME?: string; USERPROFILE?: string };

const projectsDirFor = () => path.join(dir, 'home', '.claude', 'projects');

const configFor = (root: string, fallback: boolean): ProjectConfig => ({
  version: 1,
  security: { rejectSecrets: true, secretPatterns: [] },
  search: { transcripts: { enabled: true, fallback }, vector: { enabled: false } },
});

const line = (text: string) => JSON.stringify({ type: 'user', message: { content: text } }) + '\n';

async function makeRepo(name: string, options: { transcript?: string; fallback: boolean; items?: Array<{ title: string; content: string }> }) {
  const root = path.join(dir, name);
  const projectsDir = projectsDirFor();
  const encoded = encodeProjectDir(path.resolve(root));
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await fs.mkdir(path.join(projectsDir, encoded), { recursive: true });
  if (options.transcript) {
    await fs.writeFile(path.join(projectsDir, encoded, 'session-abc.jsonl'), options.transcript);
  }
  const config = configFor(root, options.fallback);
  // On disk too: `handleTranscriptSearch` re-reads the config so that disabling the feature
  // takes effect for a running server, and an absent file reads as disabled.
  await fs.writeFile(path.join(root, '.knowl', 'config.json'), JSON.stringify(config));
  await initDb(root);
  const projectId = (await repo.createProject(root, name)).id;
  for (const item of options.items ?? []) {
    await storeKnowledgeItemDeduped(projectId, { category: 'fact', title: item.title, content: item.content });
  }
  await runIndexPass({ projectRoot: root, dbPath: path.join(root, '.knowl', 'transcripts.db'), projectsDir });
  return { root, config };
}

class InMemoryTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: any) => void;
  onSend?: (message: any) => void;
  async start(): Promise<void> {}
  async send(message: any): Promise<void> { this.onSend?.(message); }
  async close(): Promise<void> { this.onclose?.(); }
}

async function callQuery(root: string, config: ProjectConfig, args: Record<string, unknown>) {
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
  transport.onmessage!({ jsonrpc: '2.0', id: 'call', method: 'tools/call', params: { name: 'knowl_query', arguments: args } });
  const result = await response;
  await server.close();
  return result.result;
}

const blocksOf = (result: any): string[] => result.content.map((block: any) => String(block.text));

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-fallback-'));
  homeBefore = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = path.join(dir, 'home');
  process.env.USERPROFILE = path.join(dir, 'home');
  await fs.mkdir(projectsDirFor(), { recursive: true });
});

afterEach(async () => {
  process.env.HOME = homeBefore.HOME;
  process.env.USERPROFILE = homeBefore.USERPROFILE;
  if (homeBefore.HOME === undefined) delete process.env.HOME;
  if (homeBefore.USERPROFILE === undefined) delete process.env.USERPROFILE;
  await closeTranscriptDbs();
  await closeDb().catch(() => {});
  await releaseAll().catch(() => {});
  // Swallowed: Windows keeps the databases locked for the life of the process.
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('knowl_query transcript fallback', () => {
  it('an empty store runs the archive search and returns its hit', async () => {
    const { root, config } = await makeRepo('hit', {
      fallback: true,
      transcript: line('the deploy secret rotation happens through the vault sidecar'),
    });
    const blocks = blocksOf(await callQuery(root, config, { query: 'vault sidecar rotation' }));
    const chain = blocks.find(text => text.startsWith('RECALL CHAIN:'));
    expect(chain).toBeDefined();
    expect(chain).toContain('vault sidecar');
    expect(chain).not.toContain('VERIFIED NEGATIVE');
  });

  it('a miss in both stores is reported as a verified negative, not silence', async () => {
    const { root, config } = await makeRepo('negative', {
      fallback: true,
      transcript: line('an unrelated conversation about css grids'),
    });
    const blocks = blocksOf(await callQuery(root, config, { query: 'kafka partition rebalancing' }));
    const chain = blocks.find(text => text.startsWith('RECALL CHAIN'));
    expect(chain).toBeDefined();
    expect(chain).toContain('VERIFIED NEGATIVE');
    // The negative carries the coverage lines, so "searched" is a checkable claim.
    expect(chain).toContain('Coverage');
  });

  it('does nothing when the flag is off, even with transcripts enabled', async () => {
    const { root, config } = await makeRepo('off', {
      fallback: false,
      transcript: line('the deploy secret rotation happens through the vault sidecar'),
    });
    const blocks = blocksOf(await callQuery(root, config, { query: 'vault sidecar rotation' }));
    expect(blocks.some(text => text.startsWith('RECALL CHAIN'))).toBe(false);
  });

  it('does not run when the store answered', async () => {
    const { root, config } = await makeRepo('answered', {
      fallback: true,
      transcript: line('the deploy secret rotation happens through the vault sidecar'),
      items: [{ title: 'vault sidecar rotation', content: 'Secrets rotate through the vault sidecar on deploy.' }],
    });
    const blocks = blocksOf(await callQuery(root, config, { query: 'vault sidecar rotation' }));
    expect(blocks[0]).toContain('vault sidecar');
    expect(blocks.some(text => text.startsWith('RECALL CHAIN'))).toBe(false);
  });

  it('a broken archive costs the addendum, never the answer', async () => {
    const { root, config } = await makeRepo('broken', { fallback: true });
    // No transcript DB was ever built for a session file, and the archive dir is now gone.
    await fs.rm(path.join(root, '.knowl', 'transcripts.db'), { force: true }).catch(() => {});
    const result = await callQuery(root, config, { query: 'anything at all' });
    expect(result.isError).toBeFalsy();
    expect(blocksOf(result).length).toBeGreaterThan(0);
  });
});
