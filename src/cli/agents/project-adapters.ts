import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'smol-toml';
import { mergeCodexTomlConfig, mergeJsonMcpConfig, McpEntry } from './files.js';
import { AgentAdapter, AgentDetection, AgentEnvironment, AgentIntegrationResult } from './types.js';
import { unsupportedLifecycleResult } from './lifecycle-config.js';
import { mergeNestedHookConfig, verifyNestedHookConfig } from './hook-config.js';

function commandEntry(environment: AgentEnvironment): McpEntry {
  return { command: environment.platform === 'win32' ? 'knowl.cmd' : 'knowl', args: ['serve'] };
}

async function readConfig(pathname: string) {
  try {
    return await fs.readFile(pathname, 'utf8');
  } catch (error: any) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function equalEntry(value: any, entry: McpEntry) {
  return value?.command === entry.command
    && Array.isArray(value.args)
    && value.args.length === entry.args.length
    && value.args.every((arg: string, index: number) => arg === entry.args[index]);
}

function statusFromMerge(status: 'configured' | 'updated' | 'unchanged') {
  return status;
}

export function createCodexAdapter(environment: AgentEnvironment): AgentAdapter {
  const configPath = (root: string) => path.join(root, '.codex', 'config.toml');
  const lifecyclePath = (root: string) => path.join(root, '.codex', 'hooks.json');
  return {
    name: 'codex',
    label: 'Codex',
    async detect(root): Promise<AgentDetection> {
      const pathname = configPath(root);
      const source = await readConfig(pathname);
      const parsed = source ? parse(source) as Record<string, any> : {};
      return { installed: await environment.commandExists('codex'), configured: equalEntry(parsed.mcp_servers?.knowl, commandEntry(environment)), scope: 'project', configPath: pathname };
    },
    async configure(root): Promise<AgentIntegrationResult> {
      const pathname = configPath(root);
      const status = await mergeCodexTomlConfig(pathname, commandEntry(environment));
      return { agent: 'codex', status: statusFromMerge(status), scope: 'project', configPath: pathname };
    },
    async verify(root) {
      return (await this.detect(root)).configured;
    },
    async lifecycleCapability() { return 'supported'; },
    async configureLifecycle(root) {
      const pathname = lifecyclePath(root);
      const status = await mergeNestedHookConfig(pathname, environment.platform, 'codex');
      return { agent: 'codex', status, scope: 'project', configPath: pathname };
    },
    async verifyLifecycle(root) { return verifyNestedHookConfig(lifecyclePath(root), environment.platform, 'codex'); },
  };
}

function createJsonProjectAdapter(
  name: 'claude' | 'cursor',
  label: string,
  command: string,
  configPath: (root: string) => string,
  environment: AgentEnvironment,
): AgentAdapter {
  const lifecyclePath = (root: string) => path.join(root, '.claude', 'settings.local.json');
  return {
    name,
    label,
    async detect(root): Promise<AgentDetection> {
      const pathname = configPath(root);
      const source = await readConfig(pathname);
      const parsed = source ? JSON.parse(source) as Record<string, any> : {};
      return { installed: await environment.commandExists(command), configured: equalEntry(parsed.mcpServers?.knowl, commandEntry(environment)), scope: 'project', configPath: pathname };
    },
    async configure(root): Promise<AgentIntegrationResult> {
      const pathname = configPath(root);
      const status = await mergeJsonMcpConfig(pathname, commandEntry(environment));
      return { agent: name, status: statusFromMerge(status), scope: 'project', configPath: pathname };
    },
    async verify(root) {
      return (await this.detect(root)).configured;
    },
    async lifecycleCapability() { return name === 'claude' ? 'supported' : 'unsupported'; },
    async configureLifecycle(root) {
      if (name !== 'claude') return unsupportedLifecycleResult(name, 'project', configPath(root));
      const pathname = lifecyclePath(root);
      const status = await mergeNestedHookConfig(pathname, environment.platform, 'claude');
      return { agent: name, status, scope: 'project', configPath: pathname };
    },
    async verifyLifecycle(root) {
      return name === 'claude' && verifyNestedHookConfig(lifecyclePath(root), environment.platform, 'claude');
    },
  };
}

export function createClaudeCodeAdapter(environment: AgentEnvironment) {
  return createJsonProjectAdapter('claude', 'Claude Code', 'claude', root => path.join(root, '.mcp.json'), environment);
}

export function createCursorProjectAdapter(environment: AgentEnvironment) {
  return createJsonProjectAdapter('cursor', 'Cursor', 'cursor', root => path.join(root, '.cursor', 'mcp.json'), environment);
}
