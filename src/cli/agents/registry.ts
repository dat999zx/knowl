import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createClaudeDesktopAdapter } from './desktop-adapter.js';
import { createCursorAdapter } from './cursor.js';
import { createClaudeCodeAdapter, createCodexAdapter, createGeminiAdapter } from './project-adapters.js';
import { AgentAdapter, AgentDetection, AgentEnvironment, AgentName } from './types.js';

export const SUPPORTED_AGENT_NAMES: AgentName[] = ['codex', 'claude', 'cursor', 'gemini', 'claude-desktop'];

function defaultEnvironment(): AgentEnvironment {
  return {
    platform: process.platform,
    homeDir: os.homedir(),
    appDataDir: process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    commandExists: async command => spawnSync(command, ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0,
  };
}

export function createAgentRegistry(overrides: Partial<AgentEnvironment> = {}): Map<AgentName, AgentAdapter> {
  const environment = { ...defaultEnvironment(), ...overrides };
  return new Map([
    ['codex', createCodexAdapter(environment)],
    ['claude', createClaudeCodeAdapter(environment)],
    ['gemini', createGeminiAdapter(environment)],
    ['cursor', createCursorAdapter(environment)],
    ['claude-desktop', createClaudeDesktopAdapter(environment)],
  ]);
}

export function parseAgentNames(values: string[]): AgentName[] {
  const names = [...new Set(values.map(value => value.toLowerCase()))];
  for (const name of names) {
    if (!SUPPORTED_AGENT_NAMES.includes(name as AgentName)) {
      throw new Error(`Unsupported agent "${name}". Supported: ${SUPPORTED_AGENT_NAMES.join(', ')}.`);
    }
  }
  return names as AgentName[];
}

export interface DetectedAgent {
  adapter: AgentAdapter;
  detection: AgentDetection;
}

export async function detectAgents(projectRoot: string, registry: Map<AgentName, AgentAdapter>): Promise<DetectedAgent[]> {
  const agents = await Promise.all([...registry.values()].map(async adapter => ({ adapter, detection: await adapter.detect(projectRoot) })));
  return agents.filter(agent => agent.detection.installed);
}
