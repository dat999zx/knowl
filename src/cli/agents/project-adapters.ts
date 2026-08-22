import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'smol-toml';
import { mcpEntryMatches, mergeCodexTomlConfig, mergeJsonMcpConfig, McpEntry } from './files.js';
import { AgentAdapter, AgentDetection, AgentEnvironment, AgentIntegrationResult } from './types.js';
import { unsupportedLifecycleResult } from './lifecycle-config.js';
import { mergeHookConfig, verifyHookConfig } from './hook-config.js';
import {
  installKnowlHostInstructions,
  NativeInstructionHost,
  verifyKnowlHostInstructions,
} from './instruction-files.js';
import { KNOWL_MCP_SERVER_KEY } from '../../core/knowl-guidance.js';

function commandEntry(environment: AgentEnvironment, host?: string): McpEntry {
  return {
    command: environment.platform === 'win32' ? 'knowl.cmd' : 'knowl',
    // The host goes on the command line because the MCP `initialize` card is captured by the SDK
    // at construction, before the client says who it is -- and `knowl init` already knows.
    args: host ? ['serve', '--host', host] : ['serve'],
  };
}

async function readConfig(pathname: string) {
  try {
    return await fs.readFile(pathname, 'utf8');
  } catch (error: any) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

// Re-exported from `files.ts` so the two copies cannot disagree about what counts as
// configured -- they already had, once the `--host` argument appeared on one side only.
const equalEntry = mcpEntryMatches;

function statusFromMerge(status: 'configured' | 'updated' | 'unchanged') {
  return status;
}

export function createCodexAdapter(environment: AgentEnvironment): AgentAdapter {
  const name = 'codex';
  const configPath = (root: string) => path.join(root, '.codex', 'config.toml');
  const lifecyclePath = (root: string) => path.join(root, '.codex', 'hooks.json');
  return {
    name: 'codex',
    label: 'Codex',
    async detect(root): Promise<AgentDetection> {
      const pathname = configPath(root);
      const source = await readConfig(pathname);
      const parsed = source ? parse(source) as Record<string, any> : {};
      return { installed: await environment.commandExists('codex'), configured: equalEntry(parsed.mcp_servers?.[KNOWL_MCP_SERVER_KEY], commandEntry(environment, name)), scope: 'project', configPath: pathname };
    },
    async configure(root): Promise<AgentIntegrationResult> {
      const pathname = configPath(root);
      const status = await mergeCodexTomlConfig(pathname, commandEntry(environment, name));
      return { agent: 'codex', status: statusFromMerge(status), scope: 'project', configPath: pathname };
    },
    async verify(root) {
      return (await this.detect(root)).configured;
    },
    async lifecycleCapability() { return 'supported'; },
    async configureLifecycle(root) {
      const pathname = lifecyclePath(root);
      const status = await mergeHookConfig(pathname, environment.platform, 'codex');
      return { agent: 'codex', status, scope: 'project', configPath: pathname };
    },
    async verifyLifecycle(root) { return verifyHookConfig(lifecyclePath(root), environment.platform, 'codex'); },
  };
}

function createJsonProjectAdapter(
  name: 'claude' | 'cursor' | 'cline',
  label: string,
  command: string,
  configPath: (root: string) => string,
  environment: AgentEnvironment,
  instructionHost?: NativeInstructionHost,
): AgentAdapter {
  const lifecyclePath = (root: string) => path.join(root, '.claude', 'settings.local.json');
  return {
    name,
    label,
    async detect(root): Promise<AgentDetection> {
      const pathname = configPath(root);
      const source = await readConfig(pathname);
      const parsed = source ? JSON.parse(source) as Record<string, any> : {};
      return { installed: await environment.commandExists(command), configured: equalEntry(parsed.mcpServers?.[KNOWL_MCP_SERVER_KEY], commandEntry(environment, name)), scope: 'project', configPath: pathname };
    },
    async configure(root): Promise<AgentIntegrationResult> {
      const pathname = configPath(root);
      const status = await mergeJsonMcpConfig(pathname, commandEntry(environment, name));
      return { agent: name, status: statusFromMerge(status), scope: 'project', configPath: pathname };
    },
    async verify(root) {
      return (await this.detect(root)).configured;
    },
    async lifecycleCapability() { return name === 'claude' ? 'supported' : 'unsupported'; },
    async configureLifecycle(root) {
      if (name !== 'claude') return unsupportedLifecycleResult(name, 'project', configPath(root));
      const pathname = lifecyclePath(root);
      const status = await mergeHookConfig(pathname, environment.platform, 'claude');
      return { agent: name, status, scope: 'project', configPath: pathname };
    },
    async verifyLifecycle(root) {
      return name === 'claude' && verifyHookConfig(lifecyclePath(root), environment.platform, 'claude');
    },
    ...(instructionHost ? {
      async configureInstructions(root: string) {
        const status = await installKnowlHostInstructions(root, instructionHost);
        return { status, configPath: path.join(root, 'CLAUDE.md') };
      },
      async verifyInstructions(root: string) {
        return verifyKnowlHostInstructions(root, instructionHost);
      },
    } : {}),
  };
}

export function createClaudeCodeAdapter(environment: AgentEnvironment) {
  return createJsonProjectAdapter('claude', 'Claude Code', 'claude', root => path.join(root, '.mcp.json'), environment, 'claude');
}

/**
 * Cline, over MCP only.
 *
 * Cline has lifecycle hooks -- `beforeRun`, `afterRun`, `beforeTool`, `afterTool` -- but they
 * are TypeScript objects (`AgentPlugin` from `@cline/sdk`) loaded into its runtime, not a hooks
 * file and not a shell command. A `HostProfile` cannot reach them at all, so Cline is
 * deliberately an `AgentName` and not a `HookHost`: an adapter that configures memory, and no
 * profile claiming a lifecycle it has no way to receive. Reaching those hooks means publishing
 * an npm plugin, which is a product decision rather than a file in `src/session/hosts/`.
 */
export function createClineAdapter(environment: AgentEnvironment) {
  return createJsonProjectAdapter('cline', 'Cline', 'cline', root => path.join(root, '.cline', 'mcp.json'), environment);
}

export function createCursorProjectAdapter(environment: AgentEnvironment) {
  return createJsonProjectAdapter('cursor', 'Cursor', 'cursor', root => path.join(root, '.cursor', 'mcp.json'), environment);
}
