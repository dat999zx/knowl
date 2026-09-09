import { describe, expect, it } from 'vitest';
import { ToolSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  CLOUD_TOOL_DEFINITIONS, CORE_TOOL_DEFINITIONS, FLEET_TOOL_DEFINITIONS, HOOK_TOOL_DEFINITIONS,
  IMPACT_TOOL_DEFINITIONS, TRANSCRIPT_TOOL_DEFINITIONS, WORKSPACE_TOOL_DEFINITIONS,
  type ToolDefinition,
} from '../../src/mcp/tool-definitions.js';
import { createMcpServer } from '../../src/mcp/server.js';
import type { ProjectConfig } from '../../src/core/types.js';

/**
 * The hints hosts decide approval friction from, checked against what the tools actually do.
 *
 * Table-driven rather than spot-checked, because the failure this guards is not "someone typed
 * the wrong boolean once" -- it is a tool added later that quietly inherits nothing, or a read
 * tool that grows a write argument and keeps its `readOnlyHint`. Both are only caught by a list
 * that has to name every tool.
 *
 * The wire check at the bottom exists because the annotations are only worth anything if they
 * survive serialization: the SDK's `ToolSchema` strips fields it does not know, so a
 * misspelled hint would vanish between this file and `tools/list` with nothing failing.
 */

const ALL: ToolDefinition[] = [
  ...CORE_TOOL_DEFINITIONS, ...TRANSCRIPT_TOOL_DEFINITIONS, ...IMPACT_TOOL_DEFINITIONS,
  ...WORKSPACE_TOOL_DEFINITIONS, ...FLEET_TOOL_DEFINITIONS, ...HOOK_TOOL_DEFINITIONS,
  ...CLOUD_TOOL_DEFINITIONS,
];

/**
 * Every tool, classified once. `true` means the call cannot create, alter, retire or delete
 * knowledge and has no argument that would.
 *
 * `knowl_drift` and `knowl_impact` are false despite reading on their default path: `apply`
 * marks atoms for review and `resolve` closes a finding, and an annotation is read before the
 * arguments are.
 */
const READ_ONLY: Record<string, boolean> = {
  knowl_query: true,
  knowl_recent: true,
  knowl_state: true,
  knowl_context: true,
  knowl_timeline: true,
  knowl_conflicts: true,
  knowl_evidence_list: true,
  knowl_gc_preview: true,
  knowl_skill_list: true,
  knowl_skill_read: true,
  knowl_resume: true,
  knowl_transcript_search: true,
  knowl_transcript_read: true,
  knowl_session_list: true,
  knowl_fleet: true,
  knowl_workspace: true,

  knowl_ingest: false,
  knowl_ingest_atoms: false,
  knowl_store: false,
  knowl_decide: false,
  // `list` reads; `record`, `reject`, `withdraw` and `reopen` all write.
  knowl_dissent: false,
  knowl_update: false,
  knowl_synthesize: false,
  knowl_feedback: false,
  knowl_session_finish: false,
  knowl_task_start: false,
  knowl_task_checkpoint: false,
  knowl_task_finish: false,
  knowl_gc_apply: false,
  knowl_skill_create: false,
  knowl_skill_run: false,
  knowl_handoff: false,
  knowl_park: false,
  knowl_drift: false,
  knowl_impact: false,
  knowl_hook: false,
  knowl_cloud: false,
};

describe('MCP tool annotations', () => {
  it('classifies every shipped tool, so a new one cannot arrive unclassified', () => {
    const shipped = ALL.map(tool => tool.name).sort();
    expect(shipped).toEqual([...new Set(shipped)]);
    expect(shipped).toEqual(Object.keys(READ_ONLY).sort());
  });

  it('claims readOnlyHint on exactly the tools that cannot change memory', () => {
    for (const tool of ALL) {
      const expected = READ_ONLY[tool.name];
      if (expected) {
        expect(tool.annotations.readOnlyHint, `${tool.name} must be annotated read-only`).toBe(true);
      } else {
        // Absent is correct too -- the spec defaults it to false. What must never happen is a
        // writing tool claiming `true`.
        expect(tool.annotations.readOnlyHint, `${tool.name} writes and must not claim read-only`).not.toBe(true);
      }
    }
  });

  it('says out loud which tools remove or retire', () => {
    // The one GC action with no undo, and the tool whose entire job is retiring a predecessor.
    // `destructiveHint` defaults to true, so these repeat the default deliberately: the point is
    // that the file states it next to the schema, where a later edit has to see it.
    const byName = new Map(ALL.map(tool => [tool.name, tool]));
    expect(byName.get('knowl_gc_apply')!.annotations.destructiveHint).toBe(true);
    expect(byName.get('knowl_update')!.annotations.destructiveHint).toBe(true);
    // And nothing that only adds is allowed to inherit "may be destructive" by silence.
    expect(byName.get('knowl_task_checkpoint')!.annotations.destructiveHint).toBe(false);
    expect(byName.get('knowl_park')!.annotations.destructiveHint).toBe(false);
    expect(byName.get('knowl_feedback')!.annotations.destructiveHint).toBe(false);
  });

  it('leaves the machine only where it really does', () => {
    // The spec's own example: "the world of a web search tool is open, whereas that of a memory
    // tool is not". Three tools here are the exception and every other one must say so.
    const open = ALL.filter(tool => tool.annotations.openWorldHint !== false).map(tool => tool.name).sort();
    expect(open).toEqual(['knowl_cloud', 'knowl_ingest', 'knowl_skill_run']);
  });

  it('survives the SDK schema, which strips any field it does not recognise', () => {
    for (const tool of ALL) {
      const parsed = ToolSchema.parse(tool);
      expect(parsed.annotations, `${tool.name} lost annotation fields to ToolSchema`).toEqual(tool.annotations);
    }
  });
});

class InMemoryTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: any) => void;
  onSend?: (message: any) => void;
  async start(): Promise<void> {}
  async send(message: any): Promise<void> { this.onSend?.(message); }
  async close(): Promise<void> { this.onclose?.(); }
}

async function listToolsOverTheWire(config: ProjectConfig | null): Promise<any[]> {
  const server = createMcpServer(null, null, config);
  const transport = new InMemoryTransport();
  await server.connect(transport as never);
  const waitFor = (id: string) => new Promise<any>(resolve => {
    transport.onSend = message => { if (message.id === id) resolve(message); };
  });

  const initialized = waitFor('init');
  transport.onmessage!({
    jsonrpc: '2.0', id: 'init', method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'annotations-test', version: '1.0' } },
  });
  await initialized;
  transport.onmessage!({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const answered = waitFor('list');
  transport.onmessage!({ jsonrpc: '2.0', id: 'list', method: 'tools/list', params: {} });
  const response = await answered;
  await server.close();
  return response.result.tools;
}

describe('what tools/list actually puts on the wire', () => {
  it('carries the hints, not just the source literal', async () => {
    const tools = await listToolsOverTheWire({ version: 1 } as ProjectConfig);
    const byName = new Map(tools.map((tool: any) => [tool.name, tool]));

    expect(byName.get('knowl_query').annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(byName.get('knowl_gc_apply').annotations.destructiveHint).toBe(true);
    expect(byName.get('knowl_gc_apply').annotations.title).toBe('Delete retired memory');
    // Every listed tool, not only the two above: an annotation the transport drops is the same
    // failure as one never written.
    for (const tool of tools) {
      expect(tool.annotations, `${tool.name} reached the wire without annotations`).toBeTruthy();
    }
  });
});
