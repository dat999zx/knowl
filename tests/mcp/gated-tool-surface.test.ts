import { describe, expect, it } from 'vitest';
import {
  CLOUD_TOOL_DEFINITIONS, CORE_TOOL_DEFINITIONS, HOOK_TOOL_DEFINITIONS, WORKSPACE_TOOL_DEFINITIONS,
} from '../../src/mcp/tool-definitions.js';
import { knowlToolDefinitions } from '../../src/mcp/tools.js';
import type { ProjectConfig } from '../../src/core/types.js';

const cloudConfig = {
  version: 1,
  cloud: { apiHost: 'https://api.knowl.test', workspaceId: 'ws-1', repo: 'github.com/acme/web' },
} as ProjectConfig;

const workspaceConfig = {
  version: 1,
  workspace: { workspace: 'acme', repo: 'web' },
} as ProjectConfig;

const schemaOf = (tool: { inputSchema: Record<string, unknown> }) =>
  tool.inputSchema.properties as Record<string, { enum?: string[]; description?: string }>;

describe('the gated tool surface', () => {
  it('offers neither cloud nor workspace to an unconfigured repo', () => {
    const names = knowlToolDefinitions(null).map(tool => tool.name);
    expect(names).not.toContain('knowl_cloud');
    expect(names).not.toContain('knowl_workspace');
    // Gated tools stay out of the always-on set, so the core count does not move.
    expect(names.length).toBe(CORE_TOOL_DEFINITIONS.length);
  });

  it('offers knowl_cloud only to a connected repo', () => {
    expect(knowlToolDefinitions(cloudConfig).map(t => t.name)).toContain('knowl_cloud');
    expect(knowlToolDefinitions(workspaceConfig).map(t => t.name)).not.toContain('knowl_cloud');
  });

  it('offers knowl_hook only to a repo that routes its hooks over MCP', () => {
    // The one tool no agent should call, so it is paid for only by repos that asked for it:
    // MCP has no hidden-tool concept, and the lifecycle target is a catalog entry like any other.
    const mcpHooks = { version: 1, hooks: { transport: 'mcp' } } as ProjectConfig;
    const commandHooks = { version: 1, hooks: { transport: 'command' } } as ProjectConfig;
    expect(knowlToolDefinitions(mcpHooks).map(t => t.name)).toContain('knowl_hook');
    expect(knowlToolDefinitions(commandHooks).map(t => t.name)).not.toContain('knowl_hook');
    expect(knowlToolDefinitions({ version: 1 } as ProjectConfig).map(t => t.name)).not.toContain('knowl_hook');
    expect(knowlToolDefinitions(null).map(t => t.name)).not.toContain('knowl_hook');
    expect(HOOK_TOOL_DEFINITIONS[0].description).toMatch(/an agent never should/i);
  });

  it('offers knowl_workspace only to a repo in a workspace', () => {
    // A tool whose only answer is "you are not in a workspace" is paid for by every session
    // and used by none.
    expect(knowlToolDefinitions(workspaceConfig).map(t => t.name)).toContain('knowl_workspace');
    expect(knowlToolDefinitions(cloudConfig).map(t => t.name)).not.toContain('knowl_workspace');
  });
});

describe('what the descriptions promise', () => {
  it('knowl_store lets an agent mark knowledge that must not travel', () => {
    // Auto-staging is on by default, so an atom that is only true of this machine has to say
    // so at write time — there is no later moment when the agent still knows.
    const store = CORE_TOOL_DEFINITIONS.find(tool => tool.name === 'knowl_store')!;
    expect(schemaOf(store).local).toBeDefined();
    expect(schemaOf(store).local.description).toMatch(/never publish/i);
  });

  it('knowl_cloud offers unstage, so an agent can undo what it queued', () => {
    const cloud = CLOUD_TOOL_DEFINITIONS[0];
    expect(schemaOf(cloud).action.enum).toEqual(['status', 'stage', 'unstage']);
  });

  it('knowl_cloud status describes the fields it actually returns', () => {
    // The handler passes `cloudStatusInRequest` through verbatim. A field the description does
    // not mention is a field the model either ignores or guesses at.
    const described = schemaOf(CLOUD_TOOL_DEFINITIONS[0]).action.description!;
    for (const promised of ['signed in', 'corrections', 'pull is next due']) {
      expect(described.toLowerCase()).toContain(promised.toLowerCase());
    }
  });

  it('knowl_workspace is read-only, and says which verbs stay the user\'s', () => {
    const workspace = WORKSPACE_TOOL_DEFINITIONS[0];
    expect(schemaOf(workspace).action.enum).toEqual(['status', 'demand']);
    // `promote` shares in one step with no second command, so it is the user's — the same line
    // the cloud tool draws between staging and sending.
    expect(workspace.description).toContain('knowl workspace promote');
    expect(workspace.description).toMatch(/read-only/i);
  });
});
