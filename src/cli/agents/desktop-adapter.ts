import fs from 'node:fs/promises';
import path from 'node:path';
import { mcpEntryMatches, mergeJsonMcpConfig, McpEntry } from './files.js';
import { AgentAdapter, AgentDetection, AgentEnvironment, AgentIntegrationResult } from './types.js';
import { unsupportedLifecycleResult } from './lifecycle-config.js';
import { KNOWL_MCP_SERVER_KEY } from '../../core/knowl-guidance.js';

function desktopConfigPath(environment: AgentEnvironment) {
  if (environment.platform === 'win32') return path.join(environment.appDataDir, 'Claude', 'claude_desktop_config.json');
  if (environment.platform === 'darwin') return path.join(environment.homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return path.join(environment.homeDir, '.config', 'Claude', 'claude_desktop_config.json');
}

function entry(environment: AgentEnvironment): McpEntry {
  return {
    command: environment.platform === 'win32' ? 'knowl.cmd' : 'knowl',
    // Claude Desktop is the host the manual-loop card exists for: it has no hook channel, so
    // without this it would keep reading the conditional line and be left to infer that it owns
    // the work loop -- which is the one thing this host always knows for certain.
    args: ['serve', '--host', 'claude-desktop'],
  };
}

async function configured(pathname: string, expected: McpEntry) {
  try {
    const config = JSON.parse(await fs.readFile(pathname, 'utf8')) as Record<string, any>;
    return mcpEntryMatches(config.mcpServers?.[KNOWL_MCP_SERVER_KEY], expected);
  } catch (error: any) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export function createClaudeDesktopAdapter(environment: AgentEnvironment): AgentAdapter {
  const configPath = desktopConfigPath(environment);
  return {
    name: 'claude-desktop',
    label: 'Claude Desktop',
    async detect(_root): Promise<AgentDetection> {
      return { installed: await environment.commandExists('claude-desktop'), configured: await configured(configPath, entry(environment)), scope: 'global', configPath };
    },
    async configure(_root): Promise<AgentIntegrationResult> {
      const status = await mergeJsonMcpConfig(configPath, entry(environment));
      return { agent: 'claude-desktop', status, scope: 'global', configPath };
    },
    async verify(_root) {
      return configured(configPath, entry(environment));
    },
    async lifecycleCapability() { return 'unsupported'; },
    async configureLifecycle(_root) { return unsupportedLifecycleResult('claude-desktop', 'global', configPath); },
    async verifyLifecycle() { return false; },
  };
}
