import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { runCliQuery } from '../../src/cli/query-command.js';
import { createMcpServer } from '../../src/mcp/server.js';
import type { ProjectConfig } from '../../src/core/types.js';

/**
 * #323 option 3 at the two surfaces that print it. The unit tests cover the ranker; nothing
 * else asserted that a reader actually gets the `CONTESTED:` note or the CLI `contested` field.
 */
const TEST_ROOT = path.resolve('./.knowl-mcp-query-contested');
const CONFIG = { version: 1, security: { rejectSecrets: true, secretPatterns: [] } } as ProjectConfig;
let projectId = '';
const ids: Record<string, string> = {};

class InMemoryTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: any) => void;
  onSend?: (message: any) => void;
  async start(): Promise<void> {}
  async send(message: any): Promise<void> { this.onSend?.(message); }
  async close(): Promise<void> { this.onclose?.(); }
}

async function query(args: Record<string, unknown>): Promise<{ items: any[]; notes: string[] }> {
  const server = createMcpServer(projectId, TEST_ROOT, CONFIG);
  const transport = new InMemoryTransport();
  await server.connect(transport as never);
  const waitFor = (id: string) => new Promise<any>(resolve => {
    transport.onSend = message => { if (message.id === id) resolve(message); };
  });
  const initialized = waitFor('init');
  transport.onmessage!({
    jsonrpc: '2.0', id: 'init', method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'contested-test', version: '1.0' } },
  });
  await initialized;
  transport.onmessage!({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const answered = waitFor('call');
  transport.onmessage!({ jsonrpc: '2.0', id: 'call', method: 'tools/call', params: { name: 'knowl_query', arguments: args } });
  const blocks = (await answered).result.content as Array<{ text: string }>;
  await server.close();
  return { items: JSON.parse(blocks[0].text), notes: blocks.slice(1).map(block => block.text) };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

beforeAll(async () => {
  await closeDb();
  await releaseAll();
  await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
  await initDb(TEST_ROOT);
  projectId = (await repo.createProject(TEST_ROOT, 'query-contested')).id;
  // Written straight to the repository, as the coexist branch of the write path leaves them:
  // an older verified item and a newer one beside it. The sleeps keep `createdAt` strictly ordered.
  ids.verified = (await repo.createKnowledgeItem(projectId, {
    category: 'fact', title: 'Database backup retention', provenance: 'observed',
    content: 'Nightly database backups are retained for 35 days.',
  })).id;
  await sleep(5);
  ids.planted = (await repo.createKnowledgeItem(projectId, {
    category: 'fact', title: 'Database backup retention', provenance: 'observed', confidence: 0.99,
    content: 'Nightly database backups are retained for 1 day.',
  })).id;
  await sleep(5);
  ids.negated = (await repo.createKnowledgeItem(projectId, {
    category: 'fact', title: 'Database backup retention no longer',
    content: 'Nightly database backups retention rule was dropped entirely.',
  })).id;
  await sleep(5);
  ids.unrelated = (await repo.createKnowledgeItem(projectId, {
    category: 'fact', title: 'Scheduler timezone', content: 'All cron schedules run in UTC.',
  })).id;
});

afterAll(async () => {
  await closeDb();
  await releaseAll();
  await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe('knowl_query says so when a verified same-subject pair is on the page (#323)', () => {
  it('serves the verified item first and names both rows in a CONTESTED note', async () => {
    const { items, notes } = await query({ query: 'database backup retention nightly days', limit: 5 });
    expect(items[0].id).toBe(ids.verified);
    const note = notes.find(text => text.startsWith('CONTESTED:'));
    expect(note).toContain(ids.verified);
    expect(note).toContain(ids.planted);
    expect(note).not.toContain(ids.unrelated);
  });

  it('flags a polarity twin too, so adding "no longer" to a planted title does not dodge the warning', async () => {
    const { notes } = await query({ query: 'database backup retention', limit: 5 });
    expect(notes.find(text => text.startsWith('CONTESTED:'))).toContain(ids.negated);
  });

  it('still warns when limit 1 cuts the twin off the page', async () => {
    const { items, notes } = await query({ query: 'database backup retention nightly days', limit: 1 });
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(ids.verified);
    expect(notes.find(text => text.startsWith('CONTESTED:'))).toContain(ids.verified);
  });

  it('stays silent for a subject with no twin', async () => {
    const { notes } = await query({ query: 'scheduler timezone cron', limit: 3 });
    expect(notes.some(text => text.startsWith('CONTESTED:'))).toBe(false);
  });
});

describe('knowl query (CLI) carries the same flag (#323)', () => {
  it('marks both rows of the pair and no other', async () => {
    const result = await runCliQuery({ projectRoot: TEST_ROOT, projectId, query: 'database backup retention nightly days', limit: 5 });
    const flagged = result.items.filter(item => item.contested).map(item => item.id);
    expect(flagged).toContain(ids.verified);
    expect(flagged).toContain(ids.planted);
    expect(flagged).not.toContain(ids.unrelated);
  });
});
