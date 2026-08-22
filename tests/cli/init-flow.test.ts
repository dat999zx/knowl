import { describe, expect, it } from 'vitest';
import { formatAgentInitSummary, InitAgentChoice, InitPrompts, runAgentInitFlow } from '../../src/cli/init-flow.js';
import { AgentAdapter, AgentDetection, AgentIntegrationResult, AgentName } from '../../src/cli/agents/types.js';

const ROOT = 'project';

function fakeAdapter(name: AgentName, detection: AgentDetection, configureStatus: AgentIntegrationResult['status'] = 'configured'): AgentAdapter {
  return {
    name,
    label: name,
    detect: async () => detection,
    configure: async () => ({ agent: name, status: configureStatus, scope: detection.scope, configPath: detection.configPath }),
    verify: async () => configureStatus !== 'failed',
  };
}

function prompts(overrides: Partial<InitPrompts> = {}): InitPrompts {
  return {
    selectAgents: async () => [],
    confirmGlobal: async () => false,
    ...overrides,
  };
}

describe('agent init flow', () => {
  it('offers installed agents and preselects configured ones', async () => {
    const registry = new Map<AgentName, AgentAdapter>([
      ['codex', fakeAdapter('codex', { installed: true, configured: true, scope: 'project', configPath: 'codex' })],
      ['claude', fakeAdapter('claude', { installed: true, configured: false, scope: 'project', configPath: 'claude' })],
      ['cursor', fakeAdapter('cursor', { installed: false, configured: false, scope: 'project', configPath: 'cursor' })],
    ]);
    let choices: InitAgentChoice[] = [];

    await runAgentInitFlow(ROOT, {
      agentNames: [], yes: false, interactive: true, registry,
      prompts: prompts({ selectAgents: async value => { choices = value; return []; } }),
    });

    expect(choices.find(choice => choice.value === 'codex')?.checked).toBe(true);
    expect(choices.find(choice => choice.value === 'cursor')).toBeUndefined();
  });

  it('configures explicit agents without opening the selector', async () => {
    const calls: AgentName[] = [];
    const registry = new Map<AgentName, AgentAdapter>(['codex', 'claude'].map(name => [name as AgentName, {
      ...fakeAdapter(name as AgentName, { installed: true, configured: false, scope: 'project', configPath: name }),
      configure: async () => {
        calls.push(name as AgentName);
        return { agent: name as AgentName, status: 'configured' as const, scope: 'project' as const, configPath: name };
      },
    }]));

    const result = await runAgentInitFlow(ROOT, {
      agentNames: ['codex', 'claude'], yes: false, interactive: false, registry,
      prompts: prompts({ selectAgents: async () => { throw new Error('unexpected prompt'); } }),
    });

    expect(calls).toEqual(['codex', 'claude']);
    expect(result.exitCode).toBe(0);
  });

  it('requires confirmation before global configuration', async () => {
    const registry = new Map<AgentName, AgentAdapter>([
      ['claude-desktop', fakeAdapter('claude-desktop', { installed: true, configured: false, scope: 'global', configPath: 'desktop' })],
    ]);

    const result = await runAgentInitFlow(ROOT, {
      agentNames: ['claude-desktop'], yes: false, interactive: true, registry,
      prompts: prompts({ confirmGlobal: async () => false }),
    });

    expect(result.results[0]?.status).toBe('skipped');
  });

  it('returns partial failure without rolling back successes', async () => {
    const good = fakeAdapter('codex', { installed: true, configured: false, scope: 'project', configPath: 'codex' });
    const bad: AgentAdapter = { ...fakeAdapter('claude', { installed: true, configured: false, scope: 'project', configPath: 'claude' }), configure: async () => { throw new Error('denied'); } };
    const registry = new Map<AgentName, AgentAdapter>([['codex', good], ['claude', bad]]);

    const result = await runAgentInitFlow(ROOT, {
      agentNames: ['codex', 'claude'], yes: false, interactive: false, registry, prompts: prompts(),
    });

    expect(result.results.map(item => item.status)).toEqual(['configured', 'failed']);
    expect(result.exitCode).toBe(1);
  });

  it('does not prompt in non-interactive mode without explicit agents', async () => {
    const result = await runAgentInitFlow(ROOT, {
      agentNames: [], yes: false, interactive: false, registry: new Map(),
      prompts: prompts({ selectAgents: async () => { throw new Error('unexpected prompt'); } }),
    });
    expect(result).toEqual({ results: [], exitCode: 0 });
  });

  it('keeps MCP configured when lifecycle hooks are unsupported', async () => {
    const adapter: AgentAdapter = {
      ...fakeAdapter('codex', { installed: true, configured: false, scope: 'project', configPath: 'codex' }),
      lifecycleCapability: async () => 'unsupported',
      configureLifecycle: async () => ({ agent: 'codex', status: 'skipped', scope: 'project', configPath: 'codex', message: 'Use `knowl task run`.' }),
      verifyLifecycle: async () => false,
    };
    const result = await runAgentInitFlow(ROOT, {
      agentNames: ['codex'], yes: false, interactive: false, registry: new Map([['codex', adapter]]), prompts: prompts(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.results[0]).toMatchObject({ status: 'configured', lifecycle: { capability: 'unsupported', status: 'skipped' } });
  });

  it('configures MCP, native instructions, then lifecycle for a selected host', async () => {
    const calls: string[] = [];
    const adapter: AgentAdapter = {
      ...fakeAdapter('claude', { installed: true, configured: false, scope: 'project', configPath: 'mcp' }),
      configure: async () => { calls.push('mcp'); return { agent: 'claude', status: 'configured', scope: 'project', configPath: 'mcp' }; },
      verify: async () => true,
      configureInstructions: async () => { calls.push('instructions'); return { status: 'configured', configPath: 'CLAUDE.md' }; },
      verifyInstructions: async () => true,
      lifecycleCapability: async () => 'supported',
      configureLifecycle: async () => { calls.push('lifecycle'); return { agent: 'claude', status: 'configured', scope: 'project', configPath: 'hooks' }; },
      verifyLifecycle: async () => true,
    };
    const result = await runAgentInitFlow(ROOT, {
      agentNames: ['claude'], yes: true, interactive: false,
      registry: new Map([['claude', adapter]]), prompts: prompts(),
    });
    expect(calls).toEqual(['mcp', 'instructions', 'lifecycle']);
    expect(result.results[0].instructions).toMatchObject({ status: 'configured', configPath: 'CLAUDE.md' });
  });

  it('keeps MCP configured but fails readiness when native instructions do not verify', async () => {
    const adapter: AgentAdapter = {
      ...fakeAdapter('claude', { installed: true, configured: false, scope: 'project', configPath: 'mcp' }),
      verify: async () => true,
      configureInstructions: async () => ({ status: 'configured', configPath: 'CLAUDE.md' }),
      verifyInstructions: async () => false,
    };
    const result = await runAgentInitFlow(ROOT, {
      agentNames: ['claude'], yes: true, interactive: false,
      registry: new Map([['claude', adapter]]), prompts: prompts(),
    });
    expect(result.results[0]).toMatchObject({
      status: 'configured',
      instructions: { status: 'failed', configPath: 'CLAUDE.md' },
    });
    expect(result.exitCode).toBe(1);
  });

  it('reports verified supported lifecycle configuration separately from MCP', async () => {
    const adapter: AgentAdapter = {
      ...fakeAdapter('codex', { installed: true, configured: false, scope: 'project', configPath: 'codex' }),
      lifecycleCapability: async () => 'supported',
      configureLifecycle: async () => ({ agent: 'codex', status: 'configured', scope: 'project', configPath: 'hooks' }),
      verifyLifecycle: async () => true,
    };
    const result = await runAgentInitFlow(ROOT, {
      agentNames: ['codex'], yes: false, interactive: false, registry: new Map([['codex', adapter]]), prompts: prompts(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.results[0]).toMatchObject({ status: 'configured', lifecycle: { capability: 'supported', status: 'configured' } });
  });

  it('makes a manual lifecycle fallback explicit', () => {
    expect(formatAgentInitSummary([{
      agent: 'claude-desktop',
      status: 'configured',
      scope: 'global',
      configPath: 'claude_desktop_config.json',
      instructions: { status: 'configured', configPath: 'CLAUDE.md' },
      lifecycle: { capability: 'unsupported', status: 'skipped', message: 'Lifecycle hooks are unavailable; use `knowl task run`.' },
    }])).toContain('use `knowl task run`');
  });

  it('keeps MCP configured but fails readiness when supported hooks do not verify', async () => {
    const adapter: AgentAdapter = {
      ...fakeAdapter('cursor', { installed: true, configured: false, scope: 'project', configPath: 'cursor' }),
      lifecycleCapability: async () => 'supported',
      configureLifecycle: async () => ({ agent: 'cursor', status: 'configured', scope: 'project', configPath: 'hooks' }),
      verifyLifecycle: async () => false,
    };
    const result = await runAgentInitFlow(ROOT, {
      agentNames: ['cursor'], yes: false, interactive: false, registry: new Map([['cursor', adapter]]), prompts: prompts(),
    });

    expect(result.exitCode).toBe(1);
    expect(result.results[0]).toMatchObject({ status: 'configured', lifecycle: { capability: 'supported', status: 'failed' } });
  });
});
