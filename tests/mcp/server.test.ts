import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { initDb, closeDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { ProjectConfig } from '../../src/core/types.js';

// Mock AI functions
vi.mock('../../src/ai/provider.js', () => {
  return {
    initAI: vi.fn(),
    filterInput: vi.fn(),
    extractKnowledge: vi.fn(),
    compareKnowledge: vi.fn(),
    askQuestion: vi.fn(),
    deriveTruth: vi.fn(),
  };
});

const TEST_ROOT = path.resolve('./.knowl-mcp-test');
const MOCK_CONFIG: ProjectConfig = {
  version: 1,
  project: { name: 'mcp-test' },
  security: {
    rejectSecrets: true,
    secretPatterns: [],
  },
};

// In-Memory Transport for testing MCP Server
class InMemoryTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: any) => void;
  onSend?: (message: any) => void;

  async start(): Promise<void> {}
  async send(message: any): Promise<void> {
    if (this.onSend) {
      this.onSend(message);
    }
  }
  async close(): Promise<void> {
    if (this.onclose) this.onclose();
  }
}

describe('MCP Server Layer', () => {
  let projectId: string;
  let mcpServer: any;

  beforeAll(async () => {
    try {
      await fs.rm(TEST_ROOT, { recursive: true, force: true });
    } catch {
      // Ignore
    }
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
  });

  afterAll(async () => {
    await closeDb();
    try {
      await fs.rm(TEST_ROOT, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    const db = (await import('../../src/store/database.js')).getDb();
    await db.run(sql`DELETE FROM knowledge_commits`);
    await db.run(sql`DELETE FROM knowledge_items`);
    await db.run(sql`DELETE FROM projects`);

    const project = await repo.createProject(TEST_ROOT, 'MCP Test');
    projectId = project.id;
  });

  // Helper to run a JSON-RPC request against the server through InMemoryTransport
  async function runRpcRequest(method: string, params: any = {}) {
    mcpServer = createMcpServer(projectId, TEST_ROOT, MOCK_CONFIG);
    const transport = new InMemoryTransport();
    await mcpServer.connect(transport);

    // 1. Perform Handshake
    const handshakePromise = new Promise<any>((resolve) => {
      transport.onSend = (msg) => {
        if (msg.id === 'init-id') {
          resolve(msg);
        }
      };
    });

    transport.onmessage!({
      jsonrpc: '2.0',
      id: 'init-id',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0' },
      },
    });

    await handshakePromise;

    // Send initialized notification
    transport.onmessage!({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    // 2. Send target request
    const responsePromise = new Promise<any>((resolve) => {
      transport.onSend = (msg) => {
        if (msg.id === 'req-id') {
          resolve(msg);
        }
      };
    });

    transport.onmessage!({
      jsonrpc: '2.0',
      id: 'req-id',
      method,
      params,
    });

    const res = await responsePromise;
    await mcpServer.close();
    return res;
  }

  it('should list tools', async () => {
    const res = await runRpcRequest('tools/list');
    expect(res.error).toBeUndefined();
    expect(res.result.tools).toBeDefined();
    expect(res.result.tools.some((t: any) => t.name === 'knowl_state')).toBe(true);
    expect(res.result.tools.some((t: any) => t.name === 'knowl_ingest')).toBe(true);
    expect(res.result.tools.some((t: any) => t.name === 'knowl_store')).toBe(true);
    expect(res.result.tools.some((t: any) => t.name === 'knowl_ingest_atoms')).toBe(true);

    const queryTool = res.result.tools.find((t: any) => t.name === 'knowl_query');
    const stateTool = res.result.tools.find((t: any) => t.name === 'knowl_state');
    expect(queryTool.description).toContain('Use this first for specific project questions');
    expect(queryTool.description).toContain('answer from Knowl without inspecting repository files');
    expect(queryTool.description).toContain('Inspect files only on miss, conflict, stale or low-confidence results, or explicit verification requests');
    expect(queryTool.inputSchema.properties.query.description).toContain('2-6 concise keywords');
    expect(queryTool.inputSchema.properties.category.description).toContain('Omit unless you are certain');
    expect(queryTool.inputSchema.properties.limit.description).toContain('defaults to 3');
    expect(stateTool.description).toContain('broad project-memory summaries');

    const storeTool = res.result.tools.find((t: any) => t.name === 'knowl_store');
    const ingestAtomsTool = res.result.tools.find((t: any) => t.name === 'knowl_ingest_atoms');
    const updateTool = res.result.tools.find((t: any) => t.name === 'knowl_update');
    expect(storeTool.description).toContain('concise structured knowledge atom');
    expect(storeTool.description).toContain('not raw chat transcripts');
    expect(storeTool.description).toContain('Use after discovering durable project knowledge or completing work');
    expect(ingestAtomsTool.description).toContain('Do not store raw chat transcripts');
    expect(ingestAtomsTool.description).toContain('batch store implementation summaries');
    expect(updateTool.description).toContain('correct stale or contradicted memory');
  });

  it('should list resources', async () => {
    const res = await runRpcRequest('resources/list');
    expect(res.error).toBeUndefined();
    expect(res.result.resources).toBeDefined();
    expect(res.result.resources[0].uri).toBe('knowl://brain');
  });

  it('should support creating decision directly via tool', async () => {
    const res = await runRpcRequest('tools/call', {
      name: 'knowl_decide',
      arguments: {
        title: 'Use SQLite',
        content: 'Use sqlite local db',
        reasoning: 'easy and secure',
        alternatives: ['PostgreSQL'],
      },
    });

    expect(res.error).toBeUndefined();
    expect(res.result.isError).toBeUndefined();
    expect(res.result.content[0].text).toContain('Successfully recorded decision');

    // Confirm it exists in DB
    const db = (await import('../../src/store/database.js')).getDb();
    const items = await db.select().from((await import('../../src/store/schema.js')).knowledgeItems);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Use SQLite');
  });

  it('should support storing structured knowledge directly without AI', async () => {
    const res = await runRpcRequest('tools/call', {
      name: 'knowl_store',
      arguments: {
        category: 'fact',
        title: 'Runtime',
        content: 'Node.js 20+',
        tags: ['runtime'],
      },
    });

    expect(res.error).toBeUndefined();
    expect(res.result.isError).toBeUndefined();
    expect(res.result.content[0].text).toContain('Successfully stored fact');

    const db = (await import('../../src/store/database.js')).getDb();
    const items = await db.select().from((await import('../../src/store/schema.js')).knowledgeItems);
    expect(items).toHaveLength(1);
    expect(items[0].category).toBe('fact');
    expect(items[0].title).toBe('Runtime');
  });

  it('should recover relevant query hits when the MCP client guesses the wrong category', async () => {
    await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'Project uses SQLite persistence',
      content: 'Bidify uses SQLite for server persistence with a jdbc:sqlite connection and data.db file.',
      tags: ['database', 'sqlite', 'persistence'],
    });

    const res = await runRpcRequest('tools/call', {
      name: 'knowl_query',
      arguments: {
        query: 'database persistence storage',
        category: 'architecture',
        status: 'active',
      },
    });

    expect(res.error).toBeUndefined();
    expect(res.result.isError).toBeUndefined();
    const items = JSON.parse(res.result.content[0].text);
    expect(items).toHaveLength(1);
    expect(items[0].category).toBe('fact');
    expect(items[0].title).toBe('Project uses SQLite persistence');
  });

  it('should return at most three knowledge hits by default for MCP queries', async () => {
    for (let i = 1; i <= 4; i++) {
      await repo.createKnowledgeItem(projectId, {
        category: 'fact',
        title: `Database fact ${i}`,
        content: `Database persistence storage detail ${i}.`,
        tags: ['database', 'persistence'],
      });
    }

    const res = await runRpcRequest('tools/call', {
      name: 'knowl_query',
      arguments: {
        query: 'database persistence storage',
        status: 'active',
      },
    });

    expect(res.error).toBeUndefined();
    expect(res.result.isError).toBeUndefined();
    const items = JSON.parse(res.result.content[0].text);
    expect(items).toHaveLength(3);
  });

  it('should skip duplicate structured knowledge when BM25 finds an existing match', async () => {
    await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'Project database uses SQLite',
      content: 'The server persists durable data with SQLite through sqlite-jdbc.',
      tags: ['database', 'sqlite', 'persistence'],
    });

    const res = await runRpcRequest('tools/call', {
      name: 'knowl_store',
      arguments: {
        category: 'fact',
        title: 'Database is SQLite',
        content: 'This project uses SQLite for persistent server-side storage.',
        tags: ['db', 'sqlite'],
      },
    });

    expect(res.error).toBeUndefined();
    expect(res.result.isError).toBeUndefined();
    expect(res.result.content[0].text).toContain('Matched existing fact');

    const db = (await import('../../src/store/database.js')).getDb();
    const items = await db.select().from((await import('../../src/store/schema.js')).knowledgeItems);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Project database uses SQLite');
  });

  it('should support ingesting pre-extracted atoms without AI', async () => {
    const res = await runRpcRequest('tools/call', {
      name: 'knowl_ingest_atoms',
      arguments: {
        atoms: [
          {
            category: 'constraint',
            title: 'Local First',
            content: 'Knowl must work without cloud services by default.',
            tags: ['local-first'],
          },
          {
            category: 'architecture',
            title: 'MCP Bridge',
            content: 'Codex connects to Knowl through MCP tools.',
            tags: ['mcp'],
          },
        ],
        commitMessage: 'Store extracted atoms from MCP client',
      },
    });

    expect(res.error).toBeUndefined();
    expect(res.result.isError).toBeUndefined();
    expect(res.result.content[0].text).toContain('Stored 2 knowledge atom(s)');

    const db = (await import('../../src/store/database.js')).getDb();
    const items = await db.select().from((await import('../../src/store/schema.js')).knowledgeItems);
    expect(items).toHaveLength(2);
  });

  it('should support reading brain state resource', async () => {
    // Add one goal first
    await repo.createKnowledgeItem(projectId, {
      category: 'goal',
      title: 'Offline Support',
      content: 'Must support fully local offline usage',
    });

    const res = await runRpcRequest('resources/read', {
      uri: 'knowl://brain',
    });

    expect(res.error).toBeUndefined();
    expect(res.result.contents[0].text).toContain('Offline Support');
    expect(res.result.contents[0].text).toContain('GOALS');
  });
});

import { sql } from 'drizzle-orm';
