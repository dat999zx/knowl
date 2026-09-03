import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import { mergeHookConfig, verifyHookConfig, mcpHookInput } from '../../src/cli/agents/hook-config.js';
import { hostProfile } from '../../src/session/hosts/index.js';
import { HOOK_TOOL_NAME, hooksTransport } from '../../src/core/hooks-transport.js';
import type { ProjectConfig } from '../../src/core/types.js';

/**
 * `hooks.transport: mcp` writes the mid-session events as `mcp_tool` hooks and leaves the
 * session boundaries as processes (#224).
 *
 * The shape assertions are literals from the two vendors' hook references, for the reason
 * `host-config-shapes.test.ts` gives: a hooks file in the wrong shape is parsed without error
 * and acted on not at all.
 */
const workspaces: string[] = [];
const workspace = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'knowl-hooktransport-'));
  workspaces.push(dir);
  return dir;
};
const readJson = async (p: string) => JSON.parse(await readFile(p, 'utf8'));
const handlersOf = (config: any, event: string): any[] =>
  (config.hooks[event] ?? []).flatMap((entry: any) => entry.hooks ?? []);

afterAll(async () => {
  for (const dir of workspaces) await rm(dir, { recursive: true, force: true });
});

describe('the setting', () => {
  it('reads command for anything but a literal mcp', () => {
    expect(hooksTransport(null)).toBe('command');
    expect(hooksTransport({ version: 1 } as ProjectConfig)).toBe('command');
    expect(hooksTransport({ version: 1, hooks: { transport: 'mcp' } } as ProjectConfig)).toBe('mcp');
    expect(hooksTransport({ version: 1, hooks: { transport: 'MCP' as any } } as ProjectConfig)).toBe('command');
  });

  it('keeps session start a process on every host that has the type', () => {
    for (const host of ['claude', 'codex'] as const) {
      const events = hostProfile(host).mcpToolHookEvents!;
      expect(events, host).not.toContain('SessionStart');
      expect(events, host).not.toContain('SessionEnd');
      for (const event of events) expect(hostProfile(host).hookEvents, `${host}:${event}`).toContain(event);
    }
  });
});

describe('Claude Code settings under hooks.transport: mcp', () => {
  it('writes mcp_tool entries for the mid-session events and command entries for the boundaries', async () => {
    const file = path.join(await workspace(), 'settings.local.json');
    expect(await mergeHookConfig(file, 'linux', 'claude', { transport: 'mcp' })).toBe('configured');

    const config = await readJson(file);
    // The fields Claude Code's reference lists for the type, and nothing it does not.
    const [post] = handlersOf(config, 'PostToolUse');
    expect(post).toEqual({
      type: 'mcp_tool',
      server: 'knowl',
      tool: HOOK_TOOL_NAME,
      input: mcpHookInput('claude', 'PostToolUse'),
      timeout: 30,
      statusMessage: '',
    });
    expect(post.input.host).toBe('claude');
    expect(post.input.event).toBe('PostToolUse');
    expect(post.input.session_id).toBe('${session_id}');
    expect(post.input.tool_input__file_path).toBe('${tool_input.file_path}');

    // The pre-tool matcher still names the write tools, so the server is not asked about reads.
    expect(config.hooks.PreToolUse[0].matcher).toBe('^(Edit|Write|MultiEdit|NotebookEdit)$');
    expect(handlersOf(config, 'PreToolUse')[0].type).toBe('mcp_tool');

    // Both boundaries stay processes: the host's own reference says SessionStart fires before
    // servers finish connecting.
    expect(handlersOf(config, 'SessionStart')[0]).toMatchObject({ type: 'command', command: 'knowl agent-hook claude SessionStart --json' });
    expect(handlersOf(config, 'SessionEnd')[0]).toMatchObject({ type: 'command', command: 'knowl agent-hook claude SessionEnd --json' });

    // The prompt reminder is not a lifecycle event and is untouched.
    expect(handlersOf(config, 'UserPromptSubmit')[0].command).toBe('knowl agent-reminder claude --json');

    expect(await verifyHookConfig(file, 'linux', 'claude', { transport: 'mcp' })).toBe(true);
    // The same file verifies false under the other transport, which is what puts "lifecycle
    // hooks missing or stale" in front of the person and `doctor --fix` behind the rewrite.
    expect(await verifyHookConfig(file, 'linux', 'claude', { transport: 'command' })).toBe(false);
  });

  it('is idempotent, and switching transport replaces the other shape rather than stacking beside it', async () => {
    const file = path.join(await workspace(), 'settings.local.json');
    await mergeHookConfig(file, 'linux', 'claude');
    expect(handlersOf(await readJson(file), 'PostToolUse').map((h: any) => h.type)).toEqual(['command']);

    expect(await mergeHookConfig(file, 'linux', 'claude', { transport: 'mcp' })).toBe('updated');
    expect(await mergeHookConfig(file, 'linux', 'claude', { transport: 'mcp' })).toBe('unchanged');
    expect(handlersOf(await readJson(file), 'PostToolUse').map((h: any) => h.type)).toEqual(['mcp_tool']);

    expect(await mergeHookConfig(file, 'linux', 'claude', { transport: 'command' })).toBe('updated');
    const back = await readJson(file);
    expect(handlersOf(back, 'PostToolUse').map((h: any) => h.type)).toEqual(['command']);
    expect(JSON.stringify(back)).not.toContain('mcp_tool');
    expect(await verifyHookConfig(file, 'linux', 'claude')).toBe(true);
  });

  it("leaves someone else's mcp_tool hook against the knowl server alone", async () => {
    const file = path.join(await workspace(), 'settings.local.json');
    const theirs = { type: 'mcp_tool', server: 'knowl', tool: 'knowl_query', input: { query: '${tool_input.file_path}' } };
    await writeFile(file, JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Read', hooks: [theirs] }] } }), 'utf8');

    await mergeHookConfig(file, 'linux', 'claude', { transport: 'mcp' });
    await mergeHookConfig(file, 'linux', 'claude', { transport: 'command' });

    const handlers = handlersOf(await readJson(file), 'PostToolUse');
    expect(handlers).toContainEqual(theirs);
    expect(handlers).toHaveLength(2);
  });
});

describe('Codex hooks under hooks.transport: mcp', () => {
  it('moves only the events Codex lists as accepting the type', async () => {
    const file = path.join(await workspace(), 'hooks.json');
    await mergeHookConfig(file, 'linux', 'codex', { transport: 'mcp' });

    const config = await readJson(file);
    for (const event of ['PreToolUse', 'PostToolUse', 'PreCompact', 'Stop', 'SubagentStart', 'SubagentStop']) {
      expect(handlersOf(config, event)[0], event).toMatchObject({ type: 'mcp_tool', tool: HOOK_TOOL_NAME, input: { host: 'codex', event } });
    }
    expect(handlersOf(config, 'SessionStart')[0].type).toBe('command');
    expect(handlersOf(config, 'SessionEnd')[0].type).toBe('command');
    expect(await verifyHookConfig(file, 'linux', 'codex', { transport: 'mcp' })).toBe(true);
  });
});

describe('hosts without the type', () => {
  it('keep their process hooks whatever the setting says', async () => {
    for (const [host, name] of [['cursor', 'hooks.json'], ['copilot', 'knowl.json'], ['openhands', 'hooks.json']] as const) {
      const file = path.join(await workspace(), name);
      await mergeHookConfig(file, 'linux', host, { transport: 'mcp' });
      expect(JSON.stringify(await readJson(file)), host).not.toContain('mcp_tool');
      expect(await verifyHookConfig(file, 'linux', host, { transport: 'mcp' }), host).toBe(true);
      expect(await verifyHookConfig(file, 'linux', host), host).toBe(true);
    }
  });
});
