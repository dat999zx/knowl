import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { initDb, closeDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { startMemorySession, appendMemorySessionEvent } from '../../src/store/session-repository.js';
import { createEvidence, linkKnowledgeEvidence } from '../../src/store/evidence-repository.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { knowlToolDefinitions } from '../../src/mcp/tools.js';
import { CLOUD_TOOL_DEFINITIONS } from '../../src/mcp/tool-definitions.js';
import { ProjectConfig } from '../../src/core/types.js';
import { DEFAULT_CONTEXT_MAX_CHARS, MAX_ITEM_CONTENT_CHARS, MAX_PREVIEW_CHARS } from '../../src/core/token-budget.js';
import { approveSkill } from '../../src/skills/trust.js';
import {
  KNOWL_MCP_SERVER_INSTRUCTIONS,
  KNOWL_MCP_TOOL_NAMES,
} from '../../src/core/knowl-guidance.js';

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

  async function initializeServer(server = createMcpServer(projectId, TEST_ROOT, MOCK_CONFIG)) {
    const transport = new InMemoryTransport();
    await server.connect(transport as any);
    const responsePromise = new Promise<any>(resolve => {
      transport.onSend = message => {
        if (message.id === 'init-id') resolve(message);
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
    const response = await responsePromise;
    transport.onmessage!({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return { server, transport, response };
  }

  // Helper to run a JSON-RPC request against the server through InMemoryTransport
  async function runRpcRequest(method: string, params: any = {}) {
    mcpServer = createMcpServer(projectId, TEST_ROOT, MOCK_CONFIG);
    const initialized = await initializeServer(mcpServer);
    const transport = initialized.transport;

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
    await initialized.server.close();
    return res;
  }

  it('publishes host-neutral instructions even when project initialization failed', async () => {
    const initialized = await initializeServer(createMcpServer(null, null, null, 'not initialized'));
    expect(initialized.response.result.instructions).toBe(KNOWL_MCP_SERVER_INSTRUCTIONS);
    await initialized.server.close();
  });

  it('gives a SQLITE_BUSY init failure its own retry message instead of telling the user to run knowl init', async () => {
    // The database was healthy; a concurrent process just held it momentarily. Sending
    // the user to `knowl init` for a transient lock is actively wrong advice.
    const busyError = 'Failed to initialize database at "d:\\proj\\.knowl\\knowl.db": SQLITE_BUSY: database is locked';
    const initialized = await initializeServer(createMcpServer(null, null, null, busyError));
    const transport = initialized.transport;
    const responsePromise = new Promise<any>(resolve => {
      transport.onSend = message => { if (message.id === 'busy-tool') resolve(message); };
    });
    transport.onmessage!({
      jsonrpc: '2.0', id: 'busy-tool', method: 'tools/call',
      params: { name: 'knowl_query', arguments: { query: 'x' } },
    });
    const res = await responsePromise;
    expect(res.result.content[0].text).toContain('temporarily locked');
    expect(res.result.content[0].text).not.toContain("run 'knowl init'");
    await initialized.server.close();
  });

  it('keeps the run-knowl-init guidance for a genuine missing-project error', async () => {
    const initialized = await initializeServer(createMcpServer(null, null, null, 'Knowl project is not initialized. Run "knowl init" first.'));
    const transport = initialized.transport;
    const responsePromise = new Promise<any>(resolve => {
      transport.onSend = message => { if (message.id === 'noinit-tool') resolve(message); };
    });
    transport.onmessage!({
      jsonrpc: '2.0', id: 'noinit-tool', method: 'tools/call',
      params: { name: 'knowl_query', arguments: { query: 'x' } },
    });
    const res = await responsePromise;
    expect(res.result.content[0].text).toContain("run 'knowl init'");
    await initialized.server.close();
  });

  it('applies the same SQLITE_BUSY message to resource reads', async () => {
    const busyError = 'Failed to initialize database at "d:\\proj\\.knowl\\knowl.db": SQLITE_BUSY: database is locked';
    const initialized = await initializeServer(createMcpServer(null, null, null, busyError));
    const transport = initialized.transport;
    const responsePromise = new Promise<any>(resolve => {
      transport.onSend = message => { if (message.id === 'busy-resource') resolve(message); };
    });
    transport.onmessage!({
      jsonrpc: '2.0', id: 'busy-resource', method: 'resources/read',
      params: { uri: 'knowl://recent' },
    });
    const res = await responsePromise;
    expect(res.result.contents[0].text).toContain('temporarily locked');
    expect(res.result.contents[0].text).not.toContain("run 'knowl init'");
    await initialized.server.close();
  });

  it('keeps tools/list exactly aligned with the canonical inventory', async () => {
    const res = await runRpcRequest('tools/list');
    const names = res.result.tools.map((tool: any) => tool.name);
    // Plus the one gated tool whose gate ships open. `knowl_fleet` is listed unless a repo turns
    // it off and stays out of the guidance inventory all the same, because a gated tool is not a
    // promise every session can rely on -- so a plain config sees the canonical set and it.
    expect([...names].sort()).toEqual([...KNOWL_MCP_TOOL_NAMES, 'knowl_fleet'].sort());
    expect(new Set(names).size).toBe(28);
  });

  it('lists both resume tools', async () => {
    const names = (await runRpcRequest('tools/list', {})).result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('knowl_park');
    expect(names).toContain('knowl_resume');
  });

  it('parks and returns a paste-ready instruction, not a bare key', async () => {
    const response = await runRpcRequest('tools/call', {
      name: 'knowl_park',
      arguments: { goal: 'Ship the parser', nextAction: 'Wire the CLI flag' },
    });

    const text = JSON.stringify(response.result);
    expect(text).toMatch(/knowl resume [a-z]\d[a-z]\d[a-z]\d/);
  });

  it('resumes a parked workstream by key', async () => {
    const parked = await runRpcRequest('tools/call', {
      name: 'knowl_park', arguments: { goal: 'Ship the parser' },
    });
    const key = /knowl resume (([a-z]\d){3,4})/.exec(JSON.stringify(parked.result))![1];

    const resumed = await runRpcRequest('tools/call', {
      name: 'knowl_resume', arguments: { key },
    });

    expect(JSON.stringify(resumed.result)).toContain('Ship the parser');
  });

  it('lists what is parked here when resume is called with no key', async () => {
    await runRpcRequest('tools/call', { name: 'knowl_park', arguments: { goal: 'Something parked' } });

    const response = await runRpcRequest('tools/call', { name: 'knowl_resume', arguments: {} });

    expect(JSON.stringify(response.result)).toContain('Something parked');
  });

  it('says so plainly for an unknown key', async () => {
    const response = await runRpcRequest('tools/call', {
      name: 'knowl_resume', arguments: { key: 'k3t9m4' },
    });

    expect(JSON.stringify(response.result)).toMatch(/no parked workstream|unknown key/i);
  });

  it('lists knowl_handoff', async () => {
    const response = await runRpcRequest('tools/list', {});
    const names = response.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain('knowl_handoff');
  });

  it('parks a baton through the tool and reports it back', async () => {
    const response = await runRpcRequest('tools/call', {
      name: 'knowl_handoff',
      arguments: {
        goal: 'Ship the parser',
        nextAction: 'Wire the CLI flag',
        completed: ['schema', 'tests'],
        verificationStatus: 'unverified',
      },
    });

    const text = JSON.stringify(response.result);
    expect(text).toMatch(/parked/i);
    expect(text).toContain('Ship the parser');
  });

  it('advertises lifecycle and mutation gates in tool descriptions', async () => {
    const res = await runRpcRequest('tools/list');
    const byName = new Map(res.result.tools.map((tool: any) => [tool.name, tool.description]));
    expect(byName.get('knowl_recent')).toContain('only when lifecycle bootstrap is unavailable');
    expect(byName.get('knowl_task_start')).toContain('manual work loop');
    expect(byName.get('knowl_task_start')).toContain('Never use for a hook-owned session');
    expect(byName.get('knowl_session_finish')).toContain('Never call this for a hook-owned session');
    expect(byName.get('knowl_ingest')).toContain('never silently ingest the current conversation');
    expect(byName.get('knowl_skill_create')).toContain('explicitly requested');
    expect(byName.get('knowl_gc_apply')).toContain('explicit user approval');
  });

  it('offers knowl_cloud only to a repository that is connected to a workspace', () => {
    const disconnected = knowlToolDefinitions(MOCK_CONFIG).map(tool => tool.name);
    expect(disconnected).not.toContain('knowl_cloud');

    const connected = knowlToolDefinitions({
      ...MOCK_CONFIG,
      cloud: { apiHost: 'https://api.knowl.test', workspaceId: 'ws-1', repo: 'github.com/acme/app' },
    }).map(tool => tool.name);
    expect(connected).toContain('knowl_cloud');
  });

  it('refuses knowl_cloud when the repository is not connected, rather than answering "unknown tool"', async () => {
    // A client holding a cached tool list can still call it after a disconnect, so dispatch
    // re-checks the gate instead of trusting the listing.
    const res = await runRpcRequest('tools/call', { name: 'knowl_cloud', arguments: { action: 'status' } });
    expect(res.error).toBeUndefined();
    expect(res.result.content[0].text).toContain('not connected to a cloud workspace');
  });

  it('tells the agent that sending is the user\'s to run, not its own', async () => {
    const res = await runRpcRequest('tools/list');
    const byName = new Map(res.result.tools.map((tool: any) => [tool.name, tool.description]));
    // Not listed here (MOCK_CONFIG has no cloud), so assert against the definition itself:
    // publishing is irreversible and the agent must relay the command rather than route around it.
    const cloud = CLOUD_TOOL_DEFINITIONS[0];
    expect(byName.has('knowl_cloud')).toBe(false);
    expect(cloud.description).toContain('knowl cloud push');
    expect(cloud.description).toContain('irreversible');
  });

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
    // Was "2-6 concise keywords". A ground-truth ablation over this project's own suites
    // refuted the numeric cap -- see tests/core/knowl-guidance.test.ts and docs/evals/agent-surface.md.
    expect(queryTool.inputSchema.properties.query.description).toContain('not the whole sentence');
    expect(queryTool.inputSchema.properties.query.description).toContain('Length is not the variable');
    expect(queryTool.inputSchema.properties.category.description).toContain('Omit unless you are certain');
    expect(queryTool.inputSchema.properties.limit.description).toContain('defaults to 3');
    // Read from the constant, never restated. This sentence is doctrine an agent acts on, and
    // the ceiling has already moved once while a literal beside it did not.
    expect(queryTool.description).toContain(`cut at ${MAX_ITEM_CONTENT_CHARS} characters`);
    expect(queryTool.description).not.toContain('cut at 600 characters');
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

    // The batch path is where extraction and session promotion write, which is exactly the
    // population provenance exists to classify. Advertising it only on the single-atom tool
    // left the class unreachable from the tool the guidance calls preferred.
    const provenanceEnum = ['observed', 'user_stated', 'inferred'];
    expect(storeTool.inputSchema.properties.provenance.enum).toEqual(provenanceEnum);
    expect(ingestAtomsTool.inputSchema.properties.atoms.items.properties.provenance.enum)
      .toEqual(provenanceEnum);
  });

  it('persists provenance written through the batch atom path', async () => {
    const res = await runRpcRequest('tools/call', {
      name: 'knowl_ingest_atoms',
      arguments: {
        atoms: [{
          category: 'fact',
          title: 'Batch provenance atom',
          content: 'Concluded from a single log line, not observed directly.',
          provenance: 'inferred',
        }],
        commitMessage: 'Batch with provenance',
      },
    });
    expect(res.error).toBeUndefined();

    const storedId = /stored ([a-f0-9]+):/.exec(res.result.content[0].text)?.[1];
    expect(storedId).toBeDefined();
    const item = await repo.getKnowledgeItem(storedId!);
    expect(item?.provenance).toBe('inferred');
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

  it('should serve a historical asOf query instead of crashing', async () => {
    // Regression: the asOf branch called queryKnowledgeBase without importing it, so a
    // documented parameter of the most-used tool threw "queryKnowledgeBase is not
    // defined" at runtime. No other test reached that branch.
    await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'Historical asOf fact',
      content: 'Recorded so a point-in-time query has something to resolve.',
      tags: ['history'],
    });

    const res = await runRpcRequest('tools/call', {
      name: 'knowl_query',
      arguments: { query: 'historical asOf', asOf: new Date(Date.now() + 60_000).toISOString(), limit: 5 },
    });

    expect(res.error).toBeUndefined();
    expect(res.result.isError).toBeUndefined();
    expect(() => JSON.parse(res.result.content[0].text)).not.toThrow();
  });

  it('should recover an asOf query when the client guesses the wrong category', async () => {
    await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'Point in time deployment fact',
      content: 'Deployments ran through the legacy pipeline at this point in time.',
      tags: ['history'],
    });

    const asOf = new Date(Date.now() + 60_000).toISOString();
    const wrongCategory = await runRpcRequest('tools/call', {
      name: 'knowl_query',
      arguments: { query: 'point in time deployment', category: 'decision', asOf, limit: 5 },
    });

    expect(wrongCategory.error).toBeUndefined();
    expect(wrongCategory.result.isError).toBeUndefined();
    // queryKnowledgeBase hard-filters category, so without the retry this returned [] while
    // the same query without asOf recovers. That contradicted the documented contract.
    const items = JSON.parse(wrongCategory.result.content[0].text);
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((item: any) => item.title === 'Point in time deployment fact')).toBe(true);
  });

  it('should prefer exact-category asOf hits over the recovery retry', async () => {
    await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'Caching layer note',
      content: 'The caching layer note recorded as a fact.',
    });
    await repo.createKnowledgeItem(projectId, {
      category: 'decision',
      title: 'Caching layer choice',
      content: 'The caching layer note recorded as a decision.',
    });

    const res = await runRpcRequest('tools/call', {
      name: 'knowl_query',
      arguments: {
        query: 'caching layer note',
        category: 'decision',
        asOf: new Date(Date.now() + 60_000).toISOString(),
        limit: 5,
      },
    });

    // The retry fires only on an empty result, so a matching category still wins outright
    // and non-empty results are never reordered.
    const items = JSON.parse(res.result.content[0].text);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item: any) => item.category === 'decision')).toBe(true);
  });

  it('should disclose the narrowed namespace scope when explain bypasses layered query', async () => {
    await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'Scope disclosure probe',
      content: 'Stored so the explain path has a hit to rank.',
    });

    const explained = await runRpcRequest('tools/call', {
      name: 'knowl_query',
      arguments: { query: 'scope disclosure probe', explain: true, limit: 3 },
    });
    const layered = await runRpcRequest('tools/call', {
      name: 'knowl_query',
      arguments: { query: 'scope disclosure probe', limit: 3 },
    });

    // Only the layered path spans namespaces, so explain silently dropped the session
    // namespace. The first block stays a bare JSON array for existing callers; the notice
    // is a second block.
    expect(() => JSON.parse(explained.result.content[0].text)).not.toThrow();
    expect(explained.result.content).toHaveLength(2);
    expect(explained.result.content[1].text).toContain('SCOPE');
    expect(explained.result.content[1].text).toContain('session');

    // The default full-scope path must not emit the notice.
    expect(layered.result.content).toHaveLength(1);
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
    // A commit subject is now the source that yields a candidate; the session had no
    // events at all before, and relied on the stop.summary rule that Phase 1 removed.
    // It needs a BODY: a commit that only names itself is no longer captured, so a bare
    // one here promotes nothing and this case fails on the promotion it exists to check.
    await appendMemorySessionEvent(session.id, 'command', {
      command: `git commit -q -m "$(cat <<'EOF'\nfix(mcp): promote sessions through the tool path\nFinalization ran on the CLI path only, so a session finished through the\ntool left its candidates unpromoted.\nEOF\n)"`,
      exitCode: 0,
    });
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

  it('compacts default timeline content', async () => {
    const item = await repo.createKnowledgeItem(projectId, { category: 'fact', title: 'Long timeline target', content: 'x'.repeat(2_000) });

    const res = await runRpcRequest('tools/call', { name: 'knowl_timeline', arguments: { itemId: item.id } });
    const payload = JSON.parse(res.result.content[0].text);

    // A timeline payload is ASSERTION content, shaped by response-format.ts, so its ceiling is
    // the preview one and not the item one. Pointing this at MAX_ITEM_CONTENT_CHARS would make
    // it pass while testing nothing: the seeded item is exactly 2,000 characters.
    expect(payload[0].content.length).toBeLessThanOrEqual(MAX_PREVIEW_CHARS);
    expect(res.result.content[0].text.length).toBeLessThan(1_000);
  });

  it('compacts default evidence payloads', async () => {
    const item = await repo.createKnowledgeItem(projectId, { category: 'fact', title: 'Evidence target', content: 'Evidence stays inspectable.' });
    const evidence = await createEvidence({
      type: 'file',
      locator: 'src/evidence.ts',
      excerpt: 'x'.repeat(2_000),
      metadata: { verbose: 'y'.repeat(10_000) },
      observedAt: new Date().toISOString(),
    });
    await linkKnowledgeEvidence({ knowledgeItemId: item.id, evidenceId: evidence.id, relationship: 'supports' });

    const res = await runRpcRequest('tools/call', { name: 'knowl_evidence_list', arguments: { itemId: item.id } });
    const payload = JSON.parse(res.result.content[0].text);

    expect(res.result.content[0].text.length).toBeLessThan(2_000);
    expect(payload[0].excerpt.length).toBeLessThanOrEqual(MAX_PREVIEW_CHARS);
    expect(payload[0]).not.toHaveProperty('metadata');
  });

  it('accepts conflict identity on structured MCP writes', async () => {
    const args = { category: 'decision', title: 'MCP production engine', content: 'PostgreSQL.', conflictKey: 'database.production.engine', conflictScope: { environment: 'production' }, conflictExclusive: true };
    const first = await runRpcRequest('tools/call', { name: 'knowl_store', arguments: args });
    const second = await runRpcRequest('tools/call', { name: 'knowl_store', arguments: { ...args, title: 'MCP production engine alternative', content: 'SQLite.' } });
    expect(first.result.isError).toBeUndefined();
    expect(second.result.isError).toBe(true);
    expect(second.result.content[0].text).toContain('KNOWLEDGE_CONFLICT');
  });

  it('should retire the predecessor when a restatement names the same subject', async () => {
    const original = await repo.createKnowledgeItem(projectId, {
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
    // "Database is SQLite" is a token subset of "Project database uses SQLite", so this is
    // the same subject. The write is kept and the predecessor is retired, leaving exactly
    // one active answer. Dropping the write instead would have lost the content silently.
    expect(res.result.content[0].text).toContain('Successfully stored');
    expect(res.result.content[0].text).toContain(original.id);

    expect((await repo.getKnowledgeItem(original.id))!.status).toBe('superseded');
    const db = (await import('../../src/store/database.js')).getDb();
    const items = await db.select().from((await import('../../src/store/schema.js')).knowledgeItems);
    expect(items).toHaveLength(2);
    expect(items.filter(item => item.status === 'active')).toHaveLength(1);
  });

  it('should report a verbatim re-store as a non-write that lost nothing', async () => {
    const args = {
      category: 'fact',
      title: 'Verbatim restore probe',
      content: 'The scheduler polls every 30 seconds.',
    };
    const first = await runRpcRequest('tools/call', { name: 'knowl_store', arguments: args });
    const again = await runRpcRequest('tools/call', { name: 'knowl_store', arguments: args });

    expect(first.result.content[0].text).toContain('Successfully stored');
    expect(again.result.content[0].text).toContain('NOT STORED');
    expect(again.result.content[0].text).toContain('already held verbatim');
  });

  it('should report each ingested atom instead of counting a no-op as stored', async () => {
    const seed = await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'Atom reporting probe',
      content: 'Metrics ship to Prometheus.',
    });

    const res = await runRpcRequest('tools/call', {
      name: 'knowl_ingest_atoms',
      arguments: {
        atoms: [
          { category: 'fact', title: 'Atom reporting probe', content: 'Metrics ship to Prometheus.' },
          { category: 'fact', title: 'Tracing exporter probe', content: 'Traces ship to Honeycomb over OTLP.' },
        ],
      },
    });

    expect(res.error).toBeUndefined();
    expect(res.result.isError).toBeUndefined();
    const text = res.result.content[0].text;
    // Reporting "Stored 2" here hid a write that never happened.
    expect(text).toContain('Stored 1 of 2');
    expect(text).toContain('NOT STORED');
    expect(text).toContain(seed.id);
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
    expect(res.result.content[0].text).toContain('Stored 2 of 2 atom(s)');

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
        goal: 'Ship resumable handoffs',
        completed: ['Added search UI tests'],
        nextAction: 'Finish the implementation',
        blocker: 'None',
        artifactRefs: ['src/mcp/tools.ts'],
        verificationStatus: 'tests-passing',
      },
    });

    expect(checkpointRes.error).toBeUndefined();
    expect(checkpointRes.result.isError).toBeUndefined();
    const checkpointPayload = JSON.parse(checkpointRes.result.content[0].text);
    expect(checkpointPayload.taskId).toBe(startPayload.taskId);
    expect(checkpointPayload.itemId).toBeTruthy();
    expect(checkpointPayload.taskState).toEqual({
      goal: 'Ship resumable handoffs',
      completed: ['Added search UI tests'],
      nextAction: 'Finish the implementation',
      blocker: 'None',
      artifactRefs: ['src/mcp/tools.ts'],
      verificationStatus: 'tests-passing',
    });

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

    const items = await repo.listKnowledgeItems();
    expect(items.some(item => item.title === 'Work Loop: Implement search UI')).toBe(true);
    // Step atoms name their task. Every one used to be called exactly `Work Loop checkpoint`
    // whatever it described, which is how 38 of them collided in one store.
    expect(items.some(item => item.title === 'Work Loop checkpoint: Implement search UI')).toBe(true);
    expect(items.some(item => item.title === 'Work Loop finish: Implement search UI')).toBe(true);
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
            path: 'run.js',
            content: "console.log('mcp-skill-ok');\n",
          },
        ],
        entrypoints: {
          default: {
            type: 'script',
            path: 'run.js',
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

    // The MCP surface both creates executable files and runs them, which is exactly why
    // execution needs a human in the loop. Approval is deliberately NOT reachable over MCP —
    // an agent that could approve its own package would make the boundary decorative — so the
    // test grants it the way a user does, out of band.
    await approveSkill(TEST_ROOT, 'run_app', { approvedBy: 'test' });

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

    const items = await repo.listKnowledgeItems();
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

  it('bounds default state and brain resource output', async () => {
    await repo.createKnowledgeItem(projectId, {
      category: 'goal',
      title: 'Large goal',
      content: 'x'.repeat(DEFAULT_CONTEXT_MAX_CHARS * 2),
    });

    const state = await runRpcRequest('tools/call', { name: 'knowl_state', arguments: {} });
    const brain = await runRpcRequest('resources/read', { uri: 'knowl://brain' });

    expect(state.result.content[0].text.length).toBeLessThanOrEqual(DEFAULT_CONTEXT_MAX_CHARS);
    expect(brain.result.contents[0].text.length).toBeLessThanOrEqual(DEFAULT_CONTEXT_MAX_CHARS);
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
