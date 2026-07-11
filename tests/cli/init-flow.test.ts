import { describe, expect, it } from 'vitest';
import { InitAgentChoice, InitPrompts, runAgentInitFlow } from '../../src/cli/init-flow.js';
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
});
