import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { closeDb, getDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { createMcpServer } from '../../src/mcp/server.js';
import type { ProjectConfig } from '../../src/core/types.js';

/**
 * The tool surface is checked against the schema it publishes.
 *
 * Every assertion here is a call that used to SUCCEED and write something wrong: a confidence
 * of 999 stored and ranked, a negative maxChars answered with a slice of the truncation
 * marker, an empty handoff replacing a real baton, an entrypoints array creating an
 * unreachable entrypoint named "0". The schema always said otherwise; nothing enforced it.
 */

const TEST_ROOT = path.resolve('./.knowl-mcp-arg-validation');
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
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'arg-test', version: '1.0' } },
  });
  await initialized;
  transport.onmessage!({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const answered = waitFor('call');
  transport.onmessage!({ jsonrpc: '2.0', id: 'call', method: 'tools/call', params: { name, arguments: args } });
  const response = await answered;
  await server.close();
  return response.result;
}

/** The single text block a refusal comes back as. */
const textOf = (result: any): string => String(result?.content?.[0]?.text ?? '');

async function expectRefused(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await call(name, args);
  expect(result.isError, `${name} accepted ${JSON.stringify(args)}`).toBe(true);
  return textOf(result);
}

describe('MCP tool arguments are validated against the published schema', () => {
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
    projectId = (await repo.createProject(TEST_ROOT, 'arg validation')).id;
  });

  // K-21: a linear term in the ranking sum, so one mis-scaled write outranks the store forever.
  describe('confidence stays inside 0..1 (K-21)', () => {
    it('refuses a percent-scale confidence and stores nothing', async () => {
      const message = await expectRefused('knowl_store', {
        category: 'fact', title: 'Tiny', content: 'q', confidence: 999,
      });

      expect(message).toContain('confidence');
      expect(message).toContain('at most 1');
      expect(await repo.listKnowledgeItems()).toHaveLength(0);
    });

    it('refuses a negative confidence', async () => {
      const message = await expectRefused('knowl_store', {
        category: 'fact', title: 'Tiny', content: 'q', confidence: -1,
      });
      expect(message).toContain('at least 0');
    });

    it('refuses the same value inside a batch, before any atom is written', async () => {
      await expectRefused('knowl_ingest_atoms', {
        atoms: [
          { category: 'fact', title: 'Fine', content: 'ok' },
          { category: 'fact', title: 'Poisoned', content: 'bad', confidence: 90 },
        ],
      });

      expect(await repo.listKnowledgeItems()).toHaveLength(0);
    });

    it('still accepts a legitimate confidence', async () => {
      const result = await call('knowl_store', { category: 'fact', title: 'Sound', content: 'ok', confidence: 0.9 });
      expect(result.isError).toBeUndefined();
    });
  });

  // K-38: truncateText(value, -5, '[Context truncated]') returns marker.slice(0, -5).
  describe('degenerate maxChars is refused rather than answered (K-38)', () => {
    it('does not return a slice of the truncation marker', async () => {
      const message = await expectRefused('knowl_state', { maxChars: -5 });

      expect(message).not.toContain('[Context trunc');
      expect(message).toContain('maxChars');
    });

    it('refuses a non-numeric maxChars instead of returning empty', async () => {
      const message = await expectRefused('knowl_state', { maxChars: 'abc' });
      expect(message).toContain('maxChars');
      expect(message).toMatch(/finite number/);
    });

    it('refuses NaN, which survives every range comparison', async () => {
      await expectRefused('knowl_recent', { maxChars: Number.NaN });
    });
  });

  // K-49: the transcript tools bound every numeric argument; these bounded none.
  describe('read arguments have ceilings (K-49)', () => {
    it('caps knowl_query limit', async () => {
      const message = await expectRefused('knowl_query', { query: 'anything', limit: 1000 });
      expect(message).toContain('limit');
      expect(message).toContain('at most 25');
    });

    it('caps knowl_context tokenBudget', async () => {
      const message = await expectRefused('knowl_context', { query: 'anything', tokenBudget: 100_000 });
      expect(message).toContain('tokenBudget');
    });

    it('caps knowl_state maxChars', async () => {
      await expectRefused('knowl_state', { maxChars: 5_000_000 });
    });

    it('caps knowl_recent itemLimit', async () => {
      await expectRefused('knowl_recent', { itemLimit: 10_000 });
    });
  });

  // K-33: `banana` used to degrade to "now" and answer a historical question with the present.
  describe('asOf must be a real timestamp (K-33)', () => {
    it('refuses an unparseable value rather than silently meaning now', async () => {
      const message = await expectRefused('knowl_query', { query: 'anything', asOf: 'banana' });
      expect(message).toContain('asOf');
      expect(message).toContain('ISO-8601');
    });

    it('accepts a real ISO-8601 timestamp', async () => {
      const result = await call('knowl_query', { query: 'anything', asOf: new Date().toISOString() });
      expect(result.isError).toBeUndefined();
    });
  });

  // K-03: one baton per project, and parking replaces it.
  describe('a handoff must actually say something (K-03)', () => {
    it('refuses an empty handoff and leaves the real baton parked', async () => {
      const parked = await call('knowl_handoff', { goal: 'Finish the parser', nextAction: 'Wire the CLI flag' });
      expect(parked.isError).toBeUndefined();

      const message = await expectRefused('knowl_handoff', {});
      expect(message).toMatch(/goal/);

      const items = await repo.listKnowledgeItems();
      const baton = items.find(item => item.tags?.includes('pending_handoff'));
      expect(baton, 'the real baton was destroyed by an empty handoff').toBeTruthy();
      expect(baton!.content).toContain('Finish the parser');
    });

    it('refuses an empty-string goal, not only a missing one', async () => {
      const message = await expectRefused('knowl_handoff', { goal: '', nextAction: '' });
      expect(message).toMatch(/must not be empty/);
    });

    it('refuses to mint a resume key for an empty goal', async () => {
      await expectRefused('knowl_park', {});
      await expectRefused('knowl_park', { goal: '' });
    });
  });

  // K-50: the driver's message is the statement, the placeholders and every bound argument.
  describe('a missing field is named, and no SQL leaves the process (K-50)', () => {
    it('names the required field instead of dumping the insert', async () => {
      const message = await expectRefused('knowl_store', { category: 'fact', title: 'x' });

      expect(message).toContain('content');
      expect(message).toContain('required');
      expect(message.toLowerCase()).not.toContain('insert into');
      expect(message).not.toContain('params:');
      expect(message).not.toContain('knowledge_items');
    });

    it('names the required field for every write tool', async () => {
      expect(await expectRefused('knowl_decide', { title: 'x', content: 'y' })).toContain('reasoning');
      expect(await expectRefused('knowl_update', {})).toContain('id');
      expect(await expectRefused('knowl_task_checkpoint', { taskId: 't' })).toContain('summary');
    });

    it('withholds statement text and bound parameters from an execution failure', async () => {
      const { sanitizeToolErrorMessage } = await import('../../src/mcp/tool-schema.js');
      const leak = 'Failed to create knowledge item: Failed query: insert into "knowledge_items" ("id", "title") values (?, ?)\nparams: f146128f,27b9ed883031b5ac';

      const safe = sanitizeToolErrorMessage(leak);

      expect(safe).toContain('Failed to create knowledge item');
      expect(safe.toLowerCase()).not.toContain('insert into');
      expect(safe).not.toContain('params:');
      expect(safe).not.toContain('27b9ed883031b5ac');
    });
  });

  // K-54: the schema said "object" and nothing else, so every plausible guess failed alike.
  describe('skill entrypoints are callable from their schema (K-54)', () => {
    it('refuses an array, which used to create an entrypoint named "0"', async () => {
      const message = await expectRefused('knowl_skill_create', {
        name: 'array_shape', purpose: 'p',
        entrypoints: [{ type: 'shell', command: 'echo hi' }],
      });

      expect(message).toContain('entrypoints');
      await expect(fs.stat(path.join(TEST_ROOT, '.knowl', 'skills', 'array_shape'))).rejects.toThrow();
    });

    it('names the two entrypoint types when the discriminator is missing', async () => {
      const message = await expectRefused('knowl_skill_create', {
        name: 'no_type', purpose: 'p',
        entrypoints: { default: { path: 'run.js' } },
      });

      expect(message).toContain('script');
      expect(message).toContain('shell');
    });

    it('names the field a script entrypoint is missing', async () => {
      const message = await expectRefused('knowl_skill_create', {
        name: 'no_path', purpose: 'p',
        entrypoints: { default: { type: 'script', autoRun: true } },
      });

      expect(message).toContain('path');
    });

    it('accepts the shape the schema now describes', async () => {
      const result = await call('knowl_skill_create', {
        name: 'good_shape', purpose: 'p',
        files: [{ path: 'run.js', content: "console.log('ok');\n" }],
        entrypoints: { default: { type: 'script', path: 'run.js', autoRun: true } },
      });

      expect(result.isError).toBeUndefined();
    });
  });

  // The validator refuses a keyword it does not implement, on the grounds that a schema
  // constraint which silently does nothing is the defect it exists to close. That refusal
  // must never be reachable from a published schema, so every one of them is walked here.
  it('publishes no schema keyword the validator cannot enforce', async () => {
    const { knowlToolDefinitions } = await import('../../src/mcp/tools.js');
    const { SUPPORTED_SCHEMA_KEYWORDS } = await import('../../src/mcp/tool-schema.js');

    const unsupported: string[] = [];
    const walk = (node: any, where: string): void => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return;
      for (const [keyword, value] of Object.entries(node)) {
        if (!SUPPORTED_SCHEMA_KEYWORDS.has(keyword)) unsupported.push(`${where}.${keyword}`);
        if (keyword === 'properties' || keyword === 'oneOf') {
          Object.values(value as any).forEach((child, index) => walk(child, `${where}.${keyword}[${index}]`));
        }
        if (keyword === 'items' || keyword === 'additionalProperties') walk(value, `${where}.${keyword}`);
      }
    };

    const transcriptsOn = { version: 1, security: { rejectSecrets: true, secretPatterns: [] }, search: { transcripts: { enabled: true } } } as any;
    for (const tool of knowlToolDefinitions(transcriptsOn)) walk(tool.inputSchema, tool.name);

    expect(unsupported).toEqual([]);
  });

  // K-19: the batch writer forwards these; the schema never offered them, so the exclusive
  // conflict contract was enforceable from knowl_store and unreachable from a batch.
  it('offers the conflict fields on a batch atom, not only on a single store', async () => {
    const { knowlToolDefinitions } = await import('../../src/mcp/tools.js');
    const atoms = knowlToolDefinitions(null).find(tool => tool.name === 'knowl_ingest_atoms')!;
    const atom = (atoms.inputSchema as any).properties.atoms.items.properties;

    expect(Object.keys(atom)).toEqual(expect.arrayContaining(['conflictKey', 'conflictScope', 'conflictExclusive']));

    const result = await call('knowl_ingest_atoms', {
      atoms: [{
        category: 'fact', title: 'Exclusive by key', content: 'Only one of these may be active.',
        conflictKey: 'runtime', conflictScope: { area: 'server' }, conflictExclusive: true,
      }],
    });
    expect(result.isError).toBeUndefined();
  });

  it('leaves a well-formed call untouched', async () => {
    const result = await call('knowl_store', { category: 'fact', title: 'Ordinary', content: 'Nothing unusual.' });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('Successfully stored fact');
  });
});
