import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KNOWL_MCP_SERVER_INSTRUCTIONS,
  KNOWL_MCP_TOOL_GROUPS,
  KNOWL_MCP_TOOL_NAMES,
  mcpServerInstructions,
} from '../../src/core/knowl-guidance.js';
import { createMcpServer } from '../../src/mcp/server.js';
import * as repo from '../../src/store/repository.js';
import { closeDb, initDb } from '../../src/store/database.js';
import { closeTranscriptDbs } from '../../src/transcripts/database.js';
import type { ProjectConfig } from '../../src/core/types.js';

const config = (enabled: boolean): ProjectConfig => ({
  version: 1,
  security: { rejectSecrets: true, secretPatterns: [] },
  search: { transcripts: { enabled }, vector: { enabled: false } },
});

describe('transcript tool gating', () => {
  it('keeps both tools out of the unconditional inventory', () => {
    const names = KNOWL_MCP_TOOL_GROUPS.flatMap(group => group.tools);
    expect(names).not.toContain('knowl_transcript_search');
    expect(names).not.toContain('knowl_transcript_read');
    expect(KNOWL_MCP_TOOL_NAMES).toHaveLength(27);
  });

  it('returns the untouched constant when disabled', () => {
    expect(mcpServerInstructions(config(false))).toBe(KNOWL_MCP_SERVER_INSTRUCTIONS);
  });

  it('returns the untouched constant when there is no config at all', () => {
    expect(mcpServerInstructions(null)).toBe(KNOWL_MCP_SERVER_INSTRUCTIONS);
  });

  it('names both tools when enabled', () => {
    const card = mcpServerInstructions(config(true));
    expect(card).toContain('knowl_transcript_search');
    expect(card).toContain('knowl_transcript_read');
  });

  it('adds exactly one line when enabled', () => {
    const off = mcpServerInstructions(config(false)).split('\n').length;
    const on = mcpServerInstructions(config(true)).split('\n').length;
    expect(on).toBe(off + 1);
  });

  it('stays inside the 2000-character ceiling with the feature on', () => {
    expect(mcpServerInstructions(config(true)).length).toBeLessThanOrEqual(2000);
  });
});

// The guidance assertions above are necessary but not sufficient: they check what the agent is
// *told*, not what the server actually exposes. These drive the real protocol.
describe('MCP surface', () => {
  const TEST_ROOT = path.resolve('./.knowl-transcript-mcp-test');
  let projectId: string;

  class InMemoryTransport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: any) => void;
    onSend?: (message: any) => void;
    async start(): Promise<void> {}
    async send(message: any): Promise<void> { this.onSend?.(message); }
    async close(): Promise<void> { this.onclose?.(); }
  }

  /** One JSON-RPC round trip against a server built with the given config. */
  async function rpc(cfg: ProjectConfig, method: string, params: unknown): Promise<any> {
    const server = createMcpServer(projectId, TEST_ROOT, cfg);
    const transport = new InMemoryTransport();
    await server.connect(transport as never);

    const waitFor = (id: string) => new Promise<any>(resolve => {
      transport.onSend = message => { if (message.id === id) resolve(message); };
    });

    const initialized = waitFor('init-id');
    transport.onmessage!({
      jsonrpc: '2.0', id: 'init-id', method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'transcript-test', version: '1.0' },
      },
    });
    await initialized;
    transport.onmessage!({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const answered = waitFor('req-id');
    transport.onmessage!({ jsonrpc: '2.0', id: 'req-id', method, params });
    const response = await answered;

    await server.close();
    return response;
  }

  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
    projectId = (await repo.createProject(TEST_ROOT, 'Transcript MCP Test')).id;
  });

  afterAll(async () => {
    await closeDb();
    await closeTranscriptDbs();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  async function toolNames(cfg: ProjectConfig): Promise<string[]> {
    const response = await rpc(cfg, 'tools/list', {});
    return response.result.tools.map((tool: { name: string }) => tool.name);
  }

  it('does not list either tool when disabled', async () => {
    const names = await toolNames(config(false));
    expect(names).not.toContain('knowl_transcript_search');
    expect(names).not.toContain('knowl_transcript_read');
  });

  it('does not list knowl_session_list when disabled', async () => {
    expect(await toolNames(config(false))).not.toContain('knowl_session_list');
  });

  it('lists knowl_session_list when enabled', async () => {
    expect(await toolNames(config(true))).toContain('knowl_session_list');
  });

  it('refuses a session_list call when disabled', async () => {
    const response = await rpc(config(false), 'tools/call', {
      name: 'knowl_session_list', arguments: {},
    });
    expect(JSON.stringify(response.result ?? response.error)).toMatch(/not enabled/i);
  });

  it('lists both tools when enabled', async () => {
    const names = await toolNames(config(true));
    expect(names).toContain('knowl_transcript_search');
    expect(names).toContain('knowl_transcript_read');
  });

  it('refuses a call to a disabled tool instead of crashing', async () => {
    // A client that cached an older tool list can still call it. The gate must hold at
    // dispatch, not only at listing.
    const response = await rpc(config(false), 'tools/call', {
      name: 'knowl_transcript_search',
      arguments: { query: 'anything' },
    });

    const text = JSON.stringify(response.result ?? response.error);
    expect(text).toMatch(/not enabled/i);
    expect(text).not.toMatch(/undefined|cannot read|ENOENT/i);
  });

  it('rejects a malformed locator with a usable message', async () => {
    const response = await rpc(config(true), 'tools/call', {
      name: 'knowl_transcript_read',
      arguments: { locator: 'not-a-locator' },
    });

    expect(JSON.stringify(response.result ?? response.error)).toMatch(/locator/i);
  });
});
