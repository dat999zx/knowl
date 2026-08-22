import os from 'node:os';
import path from 'node:path';
import { commandExistsOnPath } from './command-exists.js';
import { createClaudeDesktopAdapter } from './desktop-adapter.js';
import { createCursorAdapter } from './cursor.js';
import { createClaudeCodeAdapter, createCodexAdapter } from './project-adapters.js';
import { createHookHostAdapter, hookHostSpecs } from './hook-host-adapter.js';
import { AgentAdapter, AgentDetection, AgentEnvironment, AgentName } from './types.js';

export const SUPPORTED_AGENT_NAMES: AgentName[] = [
  'codex', 'claude', 'cursor', 'claude-desktop',
  'copilot', 'openhands', 'antigravity', 'windsurf',
];

function defaultEnvironment(): AgentEnvironment {
  return {
    platform: process.platform,
    homeDir: os.homedir(),
    appDataDir: process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    commandExists: async command => commandExistsOnPath(command),
  };
}

export function createAgentRegistry(overrides: Partial<AgentEnvironment> = {}): Map<AgentName, AgentAdapter> {
  const environment = { ...defaultEnvironment(), ...overrides };
  return new Map<AgentName, AgentAdapter>([
    ['codex', createCodexAdapter(environment)],
    ['claude', createClaudeCodeAdapter(environment)],
    ['cursor', createCursorAdapter(environment)],
    ['claude-desktop', createClaudeDesktopAdapter(environment)],
    // Every host whose integration is "an MCP entry plus a hooks file" comes from one spec
    // list, so a new one is a row there rather than a factory here.
    ...hookHostSpecs(environment).map(spec =>
      [spec.name, createHookHostAdapter(spec, environment)] as const),
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
