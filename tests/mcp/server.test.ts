import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { initDb, closeDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { startMemorySession } from '../../src/store/session-repository.js';
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
    expect(res.result.tools.some((t: any) => t.name === 'knowl_recent')).toBe(true);
    expect(res.result.tools.some((t: any) => t.name === 'knowl_ingest')).toBe(true);
    expect(res.result.tools.some((t: any) => t.name === 'knowl_store')).toBe(true);
    expect(res.result.tools.some((t: any) => t.name === 'knowl_ingest_atoms')).toBe(true);
    expect(res.result.tools.some((t: any) => t.name === 'knowl_feedback')).toBe(true);
    expect(res.result.tools.some((t: any) => t.name === 'knowl_session_finish')).toBe(true);
    expect(res.result.tools.some((t: any) => t.name === 'knowl_task_start')).toBe(true);
    expect(res.result.tools.some((t: any) => t.name === 'knowl_task_checkpoint')).toBe(true);
    expect(res.result.tools.some((t: any) => t.name === 'knowl_task_finish')).toBe(true);
    expect(res.result.tools.some((t: any) => t.name === 'knowl_gc_preview')).toBe(true);
    expect(res.result.tools.some((t: any) => t.name === 'knowl_gc_apply')).toBe(true);
    expect(res.result.tools.some((t: any) => t.name === 'knowl_skill_list')).toBe(true);
    expect(res.result.tools.some((t: any) => t.name === 'knowl_skill_read')).toBe(true);
    expect(res.result.tools.some((t: any) => t.name === 'knowl_skill_create')).toBe(true);
    expect(res.result.tools.some((t: any) => t.name === 'knowl_skill_run')).toBe(true);
    expect(res.result.tools.some((t: any) => t.name === 'knowl_ask')).toBe(false);

    const queryTool = res.result.tools.find((t: any) => t.name === 'knowl_query');
    const stateTool = res.result.tools.find((t: any) => t.name === 'knowl_state');
    expect(queryTool.description).toContain('Use this first for specific project questions');
    expect(queryTool.description).toContain('before each new subtask');
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
    expect(storeTool.description).toContain('completing each subtask');
    expect(ingestAtomsTool.description).toContain('Do not store raw chat transcripts');
    expect(ingestAtomsTool.description).toContain('during execution or after each completed subtask');
    expect(updateTool.description).toContain('Use immediately when execution reveals stale or contradicted memory');

    const gcPreviewTool = res.result.tools.find((t: any) => t.name === 'knowl_gc_preview');
    expect(gcPreviewTool.description).toContain('Preview knowledge garbage collection');
  });

  it('should list resources', async () => {
    const res = await runRpcRequest('resources/list');
    expect(res.error).toBeUndefined();
    expect(res.result.resources).toBeDefined();
    expect(res.result.resources[0].uri).toBe('knowl://brain');
    expect(res.result.resources.some((r: any) => r.uri === 'knowl://recent')).toBe(true);
  });

  it('should return recent session context through knowl_recent', async () => {
    await repo.createKnowledgeItem(projectId, {
      category: 'state',
      title: 'Resume target',
      content: 'Continue from recent context work.',
      tags: ['session'],
    });

    const res = await runRpcRequest('tools/call', {
      name: 'knowl_recent',
      arguments: {},
    });

    expect(res.error).toBeUndefined();
    expect(res.result.isError).toBeUndefined();
    expect(res.result.content[0].text).toContain('KNOWL - RECENT SESSION CONTEXT');
    expect(res.result.content[0].text).toContain('Resume target');
  });

  it('should read recent session context resource', async () => {
    await repo.createKnowledgeItem(projectId, {
      category: 'state',
      title: 'Recent resource target',
      content: 'Resource exposes the same recent context.',
      tags: ['session'],
    });

    const res = await runRpcRequest('resources/read', {
      uri: 'knowl://recent',
    });

    expect(res.error).toBeUndefined();
    expect(res.result.contents[0].text).toContain('KNOWL - RECENT SESSION CONTEXT');
    expect(res.result.contents[0].text).toContain('Recent resource target');
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
    const db = (await import('../../src/store/database.js')).getDb();
    const access = await db.select().from((await import('../../src/store/schema.js')).knowledgeAccess);
    expect(access).toHaveLength(3);
    expect(access.every(item => item.surface === 'mcp')).toBe(true);
  });

  it('should record retrieval feedback through knowl_feedback', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Feedback target', content: 'Feedback is append-only.',
    });

    const res = await runRpcRequest('tools/call', {
      name: 'knowl_feedback',
      arguments: { itemId: item.id, used: true, useful: true },
    });

    expect(res.error).toBeUndefined();
    expect(res.result.isError).toBeUndefined();
    expect(res.result.content[0].text).toContain('Recorded feedback');
    const db = (await import('../../src/store/database.js')).getDb();
    const access = await db.select().from((await import('../../src/store/schema.js')).knowledgeAccess);
    expect(access).toEqual([expect.objectContaining({ knowledgeItemId: item.id, useful: true, used: true })]);
  });

  it('should finish and promote sessions through MCP', async () => {
    const session = await startMemorySession({ title: 'MCP promotion' });
    const res = await runRpcRequest('tools/call', { name: 'knowl_session_finish', arguments: { sessionId: session.id, status: 'finished', summary: 'MCP summary' } });
    expect(res.error).toBeUndefined();
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.session).toMatchObject({ id: session.id, status: 'finished' });
    expect(payload.promotion.status).toBe('promoted');
  });

  it('returns immutable history through knowl_timeline', async () => {
    const item = await repo.createKnowledgeItem(projectId, { category: 'fact', title: 'Timeline target', content: 'Initial content.' });
    await repo.updateKnowledgeItem(item.id, { content: 'Updated content.' });
    const res = await runRpcRequest('tools/call', { name: 'knowl_timeline', arguments: { itemId: item.id } });
    expect(res.error).toBeUndefined();
    expect(JSON.parse(res.result.content[0].text)).toEqual([expect.objectContaining({ content: 'Updated content.' }), expect.objectContaining({ content: 'Initial content.' })]);
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

  it('should refresh freshness metadata through knowl_update', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'architecture',
      title: 'MCP update target',
      content: 'Old MCP-facing knowledge.',
      sourceCommit: 'old1111',
      affectedPaths: ['src/mcp/tools.ts'],
    });
    await repo.updateKnowledgeItem(item.id, {
      freshness: 'needs_review',
    } as any);

    const res = await runRpcRequest('tools/call', {
      name: 'knowl_update',
      arguments: {
        id: item.id,
        content: 'Reviewed MCP-facing knowledge.',
        sourceCommit: 'new2222',
      },
    });

    expect(res.error).toBeUndefined();
    expect(res.result.isError).toBeUndefined();

    const updated = await repo.getKnowledgeItem(item.id);
    expect(updated!.freshness).toBe('fresh');
    expect(updated!.sourceCommit).toBe('new2222');
    expect(updated!.affectedPaths).toEqual(['src/mcp/tools.ts']);
    expect(updated!.contentHash).not.toBe(item.contentHash);
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

  it('rejects secret-like MCP atom writes without persisting a commit', async () => {
    const res = await runRpcRequest('tools/call', {
      name: 'knowl_ingest_atoms',
      arguments: {
        atoms: [{
          category: 'fact',
          title: 'Secret',
          content: 'sk-test-123456789012345678901234567890',
        }],
      },
    });

    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/KNOWLEDGE_SECRET_TOKEN/);
    const db = (await import('../../src/store/database.js')).getDb();
    expect(await db.select().from((await import('../../src/store/schema.js')).knowledgeItems)).toHaveLength(0);
    expect(await db.select().from((await import('../../src/store/schema.js')).knowledgeCommits)).toHaveLength(0);
  });

  it('should support a work loop through MCP tools', async () => {
    await repo.createKnowledgeItem(projectId, {
      category: 'decision',
      title: 'Use BM25 retrieval',
      content: 'Use BM25 retrieval for concise project-memory lookups.',
      tags: ['search', 'retrieval'],
    });

    const startRes = await runRpcRequest('tools/call', {
      name: 'knowl_task_start',
      arguments: {
        title: 'Implement search UI',
        query: 'search retrieval',
      },
    });

    expect(startRes.error).toBeUndefined();
    expect(startRes.result.isError).toBeUndefined();
    const startPayload = JSON.parse(startRes.result.content[0].text);
    expect(startPayload.taskId).toBeTruthy();
    expect(startPayload.relevantMemory).toHaveLength(1);
    expect(startPayload.relevantMemory[0].title).toBe('Use BM25 retrieval');

    const checkpointRes = await runRpcRequest('tools/call', {
      name: 'knowl_task_checkpoint',
      arguments: {
        taskId: startPayload.taskId,
        summary: 'Added search UI tests',
      },
    });

    expect(checkpointRes.error).toBeUndefined();
    expect(checkpointRes.result.isError).toBeUndefined();
    const checkpointPayload = JSON.parse(checkpointRes.result.content[0].text);
    expect(checkpointPayload.taskId).toBe(startPayload.taskId);
    expect(checkpointPayload.itemId).toBeTruthy();

    const finishRes = await runRpcRequest('tools/call', {
      name: 'knowl_task_finish',
      arguments: {
        taskId: startPayload.taskId,
        summary: 'Verified search UI implementation',
      },
    });

    expect(finishRes.error).toBeUndefined();
    expect(finishRes.result.isError).toBeUndefined();
    const finishPayload = JSON.parse(finishRes.result.content[0].text);
    expect(finishPayload.taskId).toBe(startPayload.taskId);
    expect(finishPayload.itemId).toBeTruthy();

    const items = await repo.listKnowledgeItems(projectId);
    expect(items.some(item => item.title === 'Work Loop: Implement search UI')).toBe(true);
    expect(items.some(item => item.title === 'Work Loop checkpoint')).toBe(true);
    expect(items.some(item => item.title === 'Work Loop finish')).toBe(true);
  });

  it('should create, read, list, and run learned skills through stable MCP tools', async () => {
    const createRes = await runRpcRequest('tools/call', {
      name: 'knowl_skill_create',
      arguments: {
        name: 'run_app',
        purpose: 'Start the app locally',
        markdown: '# Run App\n\nUse this to start the app.\n',
        files: [
          {
            path: 'run.cmd',
            content: '@echo off\r\necho mcp-skill-ok\r\n',
          },
        ],
        entrypoints: {
          default: {
            type: 'script',
            path: 'run.cmd',
            autoRun: true,
          },
        },
      },
    });

    expect(createRes.error).toBeUndefined();
    expect(createRes.result.isError).toBeUndefined();
    expect(createRes.result.content[0].text).toContain('Successfully created skill');

    const listRes = await runRpcRequest('tools/call', {
      name: 'knowl_skill_list',
      arguments: {},
    });
    expect(listRes.error).toBeUndefined();
    const listed = JSON.parse(listRes.result.content[0].text);
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe('run_app');

    const readRes = await runRpcRequest('tools/call', {
      name: 'knowl_skill_read',
      arguments: {
        name: 'run_app',
      },
    });
    expect(readRes.error).toBeUndefined();
    const read = JSON.parse(readRes.result.content[0].text);
    expect(read.manifest.name).toBe('run_app');
    expect(read.markdown).toContain('# Run App');

    const runRes = await runRpcRequest('tools/call', {
      name: 'knowl_skill_run',
      arguments: {
        name: 'run_app',
      },
    });
    expect(runRes.error).toBeUndefined();
    const run = JSON.parse(runRes.result.content[0].text);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('mcp-skill-ok');

    const items = await repo.listKnowledgeItems(projectId);
    const indexed = items.find(item => item.category === 'skill' && item.title === 'run_app');
    expect(indexed).toBeTruthy();
    expect(indexed!.content).toContain('.knowl/skills/run_app/SKILL.md');
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

  it('should preview and apply knowledge garbage collection via MCP tools', async () => {
    const duplicateA = await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'Duplicate runtime fact',
      content: 'The runtime uses Node.js.',
      confidence: 0.3,
    });
    const duplicateB = await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'Duplicate runtime fact',
      content: 'The runtime uses Node.js.',
      confidence: 0.9,
    });

    const previewRes = await runRpcRequest('tools/call', {
      name: 'knowl_gc_preview',
      arguments: {},
    });

    expect(previewRes.error).toBeUndefined();
    expect(previewRes.result.isError).toBeUndefined();
    const preview = JSON.parse(previewRes.result.content[0].text);
    expect(preview.summary.purge).toBe(1);
    expect(preview.candidates[0].itemId).toBe(duplicateA.id);
    expect(preview.candidates[0].duplicateOfId).toBe(duplicateB.id);

    const applyRes = await runRpcRequest('tools/call', {
      name: 'knowl_gc_apply',
      arguments: {},
    });

    expect(applyRes.error).toBeUndefined();
    expect(applyRes.result.isError).toBeUndefined();
    const result = JSON.parse(applyRes.result.content[0].text);
    expect(result.summary.purge).toBe(1);

    expect(await repo.getKnowledgeItem(duplicateA.id)).toBeNull();
    expect(await repo.getKnowledgeItem(duplicateB.id)).not.toBeNull();
  });
});

import { sql } from 'drizzle-orm';
