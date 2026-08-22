import os from 'node:os';
import path from 'node:path';
import { commandExistsOnPath } from './command-exists.js';
import { createClaudeDesktopAdapter } from './desktop-adapter.js';
import { createCursorAdapter } from './cursor.js';
import { createClaudeCodeAdapter, createClineAdapter, createCodexAdapter } from './project-adapters.js';
import { createHookHostAdapter, hookHostSpecs } from './hook-host-adapter.js';
import { AgentAdapter, AgentDetection, AgentEnvironment, AgentName } from './types.js';

export const SUPPORTED_AGENT_NAMES: AgentName[] = [
  'codex', 'claude', 'cursor', 'claude-desktop', 'cline',
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
    ['cline', createClineAdapter(environment)],
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

/**
 * Detection is per-adapter best-effort, because one host's broken file is not another host's
 * problem.
 *
 * `Promise.all` with no catch meant a single unreadable config aborted detection for every
 * host, and `knowl init` died before it could even show the picker. That is not hypothetical:
 * Gemini CLI leaves a **0-byte** `~/.gemini/config/mcp_config.json` behind, which is where
 * Antigravity keeps its MCP list, so `JSON.parse` threw `Unexpected end of JSON input` on
 * machines that had merely once installed a tool Knowl no longer supports. The
 * `detection.installed` filter never ran, so not having Antigravity did not save anyone.
 *
 * `jsonMcpConfigured` now answers `false` for an unreadable file rather than throwing, which is
 * the narrower fix and keeps `installed` truthful for a host that IS present with a corrupt
 * config. This catch stays as the outer guard: an adapter is third-party-ish code reading
 * files Knowl does not own, and one of them failing must never cost the other eight.
 */
export async function detectAgents(projectRoot: string, registry: Map<AgentName, AgentAdapter>): Promise<DetectedAgent[]> {
  const agents = await Promise.all([...registry.values()].map(async adapter => ({
    adapter,
    detection: await adapter.detect(projectRoot).catch((): AgentDetection => ({
      installed: false, configured: false, scope: 'project', configPath: '',
    })),
  })));
  return agents.filter(agent => agent.detection.installed);
}
