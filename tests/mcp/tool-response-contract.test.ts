import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { closeDb, getDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { createMcpServer } from '../../src/mcp/server.js';
import type { ProjectConfig } from '../../src/core/types.js';

/**
 * What the tools actually do with the arguments they accept, and how much they send back.
 *
 * Separate from schema validation because these are calls that were always well-formed. The
 * arguments were legal, accepted, and then dropped on the floor or answered without a ceiling.
 */

/**
 * Real behaviour throughout; the wrapper only records what the tool handed the query layer.
 * `category` is documented as a ranking hint rather than a filter, so the only honest
 * assertion about it is that it arrives -- which is exactly what was not happening.
 */
vi.mock('../../src/store/namespaces.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/store/namespaces.js')>();
  return { ...actual, queryLayeredKnowledge: vi.fn(actual.queryLayeredKnowledge) };
});
const { queryLayeredKnowledge } = await import('../../src/store/namespaces.js');
const layeredSpy = vi.mocked(queryLayeredKnowledge);

const TEST_ROOT = path.resolve('./.knowl-mcp-response-contract');
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

async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const server = createMcpServer(projectId, TEST_ROOT, CONFIG);
  const transport = new InMemoryTransport();
  await server.connect(transport as never);
  const waitFor = (id: string) => new Promise<any>(resolve => {
    transport.onSend = message => { if (message.id === id) resolve(message); };
  });

  const initialized = waitFor('init');
  transport.onmessage!({
    jsonrpc: '2.0', id: 'init', method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'contract-test', version: '1.0' } },
  });
  await initialized;
  transport.onmessage!({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const answered = waitFor('call');
  transport.onmessage!({ jsonrpc: '2.0', id: 'call', method: 'tools/call', params: { name, arguments: args } });
  const response = await answered;
  await server.close();
  return response.result;
}

const textOf = (result: any): string => String(result?.content?.[0]?.text ?? '');
const jsonOf = (result: any): any => JSON.parse(textOf(result));

describe('MCP tool responses honour the arguments they accepted', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    const db = getDb();
    await db.run(sql`DELETE FROM knowledge_commits`);
    await db.run(sql`DELETE FROM knowledge_items`);
    projectId = (await repo.createProject(TEST_ROOT, 'response contract')).id;
  });

  // K-22: queryLayeredKnowledge has always taken a `filters` argument and this call has
  // always omitted it, so the default path answered identically with and without them.
  describe('query filters reach the query (K-22)', () => {
    beforeEach(async () => {
      await repo.createKnowledgeItem(projectId, {
        category: 'fact', title: 'Storage engine is libsql', content: 'The storage engine is libsql.', tags: ['storage'],
      });
      await repo.createKnowledgeItem(projectId, {
        category: 'decision', title: 'Storage engine decision', content: 'We chose the storage engine deliberately.', tags: ['adr'],
      });
    });

    it('filters by tag rather than ignoring it', async () => {
      const unfiltered = jsonOf(await call('knowl_query', { query: 'storage engine' }));
      const filtered = jsonOf(await call('knowl_query', { query: 'storage engine', tags: ['adr'] }));

      expect(unfiltered.length).toBeGreaterThan(1);
      expect(filtered.length).toBeGreaterThan(0);
      expect(filtered.every((item: any) => item.category === 'decision')).toBe(true);
      // The defect was byte-identical responses with and without the filter.
      expect(JSON.stringify(filtered)).not.toBe(JSON.stringify(unfiltered));
    });

    // Deliberately not a filter assertion. `category` is documented as a hint and the ranker
    // applies it as a boost, so the contract is that it reaches the ranker at all. It never
    // did: the call site passed five positional arguments and stopped short of the sixth.
    it('hands every declared filter to the query layer', async () => {
      layeredSpy.mockClear();

      await call('knowl_query', { query: 'storage engine', category: 'decision', status: 'active', tags: ['adr'] });

      expect(layeredSpy).toHaveBeenCalled();
      expect(layeredSpy.mock.calls[0][5]).toEqual({ category: 'decision', status: 'active', tags: ['adr'] });
    });

    it('filters by status rather than ignoring it', async () => {
      const archived = await repo.createKnowledgeItem(projectId, {
        category: 'fact', title: 'Storage engine was sqlite', content: 'The storage engine used to be sqlite.',
      });
      await repo.updateKnowledgeItem(archived.id, { status: 'archived' });

      const result = jsonOf(await call('knowl_query', { query: 'storage engine', status: 'archived' }));

      expect(result.length).toBeGreaterThan(0);
      expect(result.every((item: any) => item.id === archived.id)).toBe(true);
    });
  });

  // K-33: `asOf` was the one argument that turned off the default limit.
  describe('a historical query is limited like any other (K-33)', () => {
    it('does not return the whole store because asOf was passed', async () => {
      for (let index = 0; index < 12; index += 1) {
        await repo.createKnowledgeItem(projectId, {
          category: 'fact', title: `Retrieval note ${index}`, content: `Retrieval behaviour note number ${index}.`,
        });
      }

      const live = jsonOf(await call('knowl_query', { query: 'retrieval note' }));
      const historical = jsonOf(await call('knowl_query', { query: 'retrieval note', asOf: new Date().toISOString() }));

      expect(historical.length).toBeLessThanOrEqual(live.length);
      expect(historical.length).toBeLessThanOrEqual(3);
    });

    it('still honours an explicit limit', async () => {
      for (let index = 0; index < 12; index += 1) {
        await repo.createKnowledgeItem(projectId, {
          category: 'fact', title: `Retrieval note ${index}`, content: `Retrieval behaviour note number ${index}.`,
        });
      }

      const historical = jsonOf(await call('knowl_query', { query: 'retrieval note', asOf: new Date().toISOString(), limit: 5 }));
      expect(historical.length).toBeLessThanOrEqual(5);
    });
  });

  // K-34: the update committed, then the supersede threw, and the caller was told the whole
  // call failed. The agent believes nothing happened; memory has already moved.
  describe('a bad supersedeId fails before anything is written (K-34)', () => {
    it('does not commit the update it is about to report as failed', async () => {
      const item = await repo.createKnowledgeItem(projectId, {
        category: 'fact', title: 'Original title', content: 'Original content.',
      });

      const result = await call('knowl_update', { id: item.id, title: 'Rewritten title', supersedeId: 'no-such-item' });

      expect(result.isError).toBe(true);
      const after = await repo.getKnowledgeItem(item.id);
      expect(after!.title, 'the update was committed under a report of total failure').toBe('Original title');
    });

    it('names the id it could not find', async () => {
      const item = await repo.createKnowledgeItem(projectId, { category: 'fact', title: 'T', content: 'C' });
      const result = await call('knowl_update', { id: item.id, title: 'New', supersedeId: 'no-such-item' });

      expect(textOf(result)).toContain('no-such-item');
      expect(textOf(result)).toMatch(/nothing was updated/i);
    });

    it('refuses to supersede the item being updated', async () => {
      const item = await repo.createKnowledgeItem(projectId, { category: 'fact', title: 'T', content: 'C' });
      const result = await call('knowl_update', { id: item.id, title: 'New', supersedeId: item.id });

      expect(result.isError).toBe(true);
      expect(await repo.getKnowledgeItem(item.id).then(found => found!.title)).toBe('T');
    });

    it('still retires a real predecessor and says so', async () => {
      const replacement = await repo.createKnowledgeItem(projectId, { category: 'fact', title: 'New fact', content: 'New.' });
      const outdated = await repo.createKnowledgeItem(projectId, { category: 'fact', title: 'Old fact', content: 'Old.' });

      const result = await call('knowl_update', { id: replacement.id, content: 'Newer.', supersedeId: outdated.id });

      expect(result.isError).toBeUndefined();
      expect(textOf(result)).toContain(outdated.id);
      expect((await repo.getKnowledgeItem(outdated.id))!.status).toBe('superseded');
    });
  });

  // K-49 / K-54: the response side of the same ceiling.
  describe('responses are bounded (K-49, K-54)', () => {
    it('keeps a context pack under the response ceiling and stays parseable', async () => {
      for (let index = 0; index < 60; index += 1) {
        await repo.createKnowledgeItem(projectId, {
          category: index % 2 === 0 ? 'constraint' : 'fact',
          title: `Bulky item ${index}`,
          content: 'x'.repeat(900),
        });
      }

      const result = await call('knowl_context', { query: 'bulky', tokenBudget: 4000 });
      const text = textOf(result);

      expect(result.isError).toBeUndefined();
      expect(text.length).toBeLessThanOrEqual(12_000);
      expect(() => JSON.parse(text)).not.toThrow();
    });

    it('does not pretty-print the skill list or echo an absolute path per skill', async () => {
      for (let index = 0; index < 6; index += 1) {
        await call('knowl_skill_create', {
          name: `bulky_skill_${index}`,
          purpose: 'A purpose sentence that is long enough to matter when it is repeated. '.repeat(6),
          triggers: Array.from({ length: 12 }, (_, trigger) => `trigger phrase number ${trigger} for discovery`),
        });
      }

      const result = await call('knowl_skill_list', {});
      const text = textOf(result);

      expect(text).not.toContain('\n  ');
      expect(text).not.toContain(TEST_ROOT);
      expect(text.length).toBeLessThan(4_000);
      expect(jsonOf(result)).toHaveLength(6);
    });
  });
});
