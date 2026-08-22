import fs from 'node:fs/promises';
import path from 'node:path';
import { mcpEntryMatches, mergeJsonMcpConfig, McpEntry } from './files.js';
import { mergeHookConfig, verifyHookConfig } from './hook-config.js';
import { AgentAdapter, AgentDetection, AgentEnvironment, AgentIntegrationResult, AgentName, IntegrationScope } from './types.js';
import { KNOWL_MCP_SERVER_KEY } from '../../core/knowl-guidance.js';
import type { HookHost } from '../../core/host-hook-types.js';

/**
 * Where a host keeps its MCP server list, or why we are not writing it.
 *
 * `manual` is a real option rather than an omission. OpenHands registers MCP servers as
 * `[[mcp.stdio_servers]]` entries in a TOML file whose shape is documented only in secondary
 * sources, and writing a config a host silently ignores is worse than writing none: `verify`
 * reports success, `doctor` stays quiet, and the tools never appear. Naming the stanza and
 * letting a person paste it is the honest degradation.
 */
type McpTarget =
  | { kind: 'json'; scope: IntegrationScope; configPath: (root: string) => string }
  | { kind: 'manual'; configPath: (root: string) => string; message: string };

export interface HookHostAdapterSpec {
  name: AgentName & HookHost;
  label: string;
  /** Executable name `commandExists` probes to decide whether this host is installed. */
  command: string;
  mcp: McpTarget;
  /** Where this host reads its hook handlers from. The shape is the profile's business. */
  hooksPath: (root: string) => string;
}

const commandEntry = (environment: AgentEnvironment, host: string): McpEntry => ({
  command: environment.platform === 'win32' ? 'knowl.cmd' : 'knowl',
  args: ['serve', '--host', host],
});

async function jsonMcpConfigured(pathname: string, expected: McpEntry): Promise<boolean> {
  try {
    const config = JSON.parse(await fs.readFile(pathname, 'utf8')) as Record<string, any>;
    // The shared matcher, which tolerates an entry written before `--host` existed.
    return mcpEntryMatches(config.mcpServers?.[KNOWL_MCP_SERVER_KEY], expected);
  } catch {
    // Absent, unreadable, empty or malformed all mean the same thing here: not configured by us.
    // Rethrowing a parse error took detection for every *other* host down with it -- Gemini CLI
    // leaves a 0-byte file at the path Antigravity reads, so `knowl init` died before its picker
    // on machines that had merely once installed a tool Knowl no longer supports.
    return false;
  }
}

/**
 * One adapter for every host whose integration is "an MCP entry plus a hooks file".
 *
 * The four hosts here differ only in three strings and one enum, all of which already live
 * somewhere declarative -- the paths below, the file shape in the profile.
 *
 * Separate from `createJsonProjectAdapter`, which is keyed on `AgentName` and serves agents with
 * no profile at all: `hostProfile` throws for those, from inside `lifecycleCapability`.
 */
export function createHookHostAdapter(spec: HookHostAdapterSpec, environment: AgentEnvironment): AgentAdapter {
  const entry = commandEntry(environment, spec.name);
  const mcpScope: IntegrationScope = spec.mcp.kind === 'json' ? spec.mcp.scope : 'project';
  return {
    name: spec.name,
    label: spec.label,
    async detect(root): Promise<AgentDetection> {
      const configPath = spec.mcp.configPath(root);
      const installed = await environment.commandExists(spec.command);
      return {
        installed,
        // A `manual` target reports configured **only when the host is actually installed**, and
        // both halves of that matter.
        //
        // Reporting `false` outright made `knowl init openhands` impossible: init treats a failed
        // `verify` as a fatal configuration error, so it exited 1 with "Configuration
        // verification failed" instead of the TOML stanza, and never reached `configureLifecycle`
        // to write the hooks file at all.
        //
        // Reporting `true` outright was worse in the other direction: `doctor` gates its WARN on
        // `configured` alone and never reads `installed`, so every repository on earth grew a
        // "openhands lifecycle hooks missing or stale" warning whose remedy `doctor --fix` then
        // ran unattended -- writing `.openhands/hooks.json` into projects that had never heard of
        // OpenHands. That is the same defect the Copilot `.mcp.json` collision caused, arriving
        // through a different door.
        configured: spec.mcp.kind === 'json' ? await jsonMcpConfigured(configPath, entry) : installed,
        scope: mcpScope,
        configPath,
      };
    },
    async configure(root): Promise<AgentIntegrationResult> {
      const configPath = spec.mcp.configPath(root);
      if (spec.mcp.kind === 'manual') {
        return { agent: spec.name, status: 'skipped', scope: mcpScope, configPath, message: spec.mcp.message };
      }
      const status = await mergeJsonMcpConfig(configPath, entry);
      return { agent: spec.name, status, scope: mcpScope, configPath };
    },
    async verify(root) {
      // **Not `detect().configured` for a manual target.** The two answer different questions
      // and conflating them broke `knowl init openhands` twice, in opposite directions.
      // `configured` drives doctor's WARN, so it must be false where the host is not installed
      // -- otherwise every repository grows a warning whose automatic remedy writes a hooks
      // file into a project that never chose the host. `verify` drives init's gate, and there
      // is nothing to verify for a config we deliberately do not write, so it must be true or
      // init exits 1 without ever reaching `configureLifecycle`.
      //
      // The distinction is load-bearing precisely for OpenHands, which is usually run through
      // Docker or `uvx` and often has no `openhands` on the developer's PATH at all -- the very
      // case its own profile documents, where hooks run inside the container.
      if (spec.mcp.kind === 'manual') return true;
      return (await this.detect(root)).configured;
    },
    async lifecycleCapability() { return 'supported'; },
    async configureLifecycle(root) {
      const pathname = spec.hooksPath(root);
      const status = await mergeHookConfig(pathname, environment.platform, spec.name);
      return { agent: spec.name, status, scope: 'project', configPath: pathname };
    },
    async verifyLifecycle(root) {
      return verifyHookConfig(spec.hooksPath(root), environment.platform, spec.name);
    },
  };
}

/**
 * The four hosts added for parity, each verified against its vendor's own reference.
 *
 * Antigravity and Windsurf keep their MCP list at user scope with no project-local override, so
 * their entries are global like Claude Desktop's -- writing a project file they never read would
 * look like success and do nothing.
 */
export function hookHostSpecs(environment: AgentEnvironment): HookHostAdapterSpec[] {
  return [
    {
      name: 'copilot',
      label: 'GitHub Copilot',
      command: 'copilot',
      // NOT `.mcp.json`, which Claude Code already owns. Copilot reads both, and sharing the
      // file made `copilot.detect()` report configured in every repo that had ever run
      // `knowl init claude` -- which put Copilot into doctor's WARN list and let `doctor --fix`
      // run `knowl init copilot` unattended, opting repositories into a host nobody chose.
      // `.github/mcp.json` is Copilot's own documented project path and collides with nothing.
      mcp: { kind: 'json', scope: 'project', configPath: root => path.join(root, '.github', 'mcp.json') },
      hooksPath: root => path.join(root, '.github', 'hooks', 'knowl.json'),
    },
    {
      name: 'openhands',
      label: 'OpenHands',
      command: 'openhands',
      mcp: {
        kind: 'manual',
        configPath: root => path.join(root, 'config.toml'),
        message: 'OpenHands registers MCP servers as [[mcp.stdio_servers]] in config.toml. '
          + 'Add: name = "knowl", command = "knowl", args = ["serve", "--host", "openhands"]. '
          + 'Lifecycle hooks were configured.',
      },
      hooksPath: root => path.join(root, '.openhands', 'hooks.json'),
    },
    {
      name: 'antigravity',
      label: 'Google Antigravity',
      command: 'antigravity',
      mcp: {
        kind: 'json',
        scope: 'global',
        configPath: () => path.join(environment.homeDir, '.gemini', 'config', 'mcp_config.json'),
      },
      hooksPath: root => path.join(root, '.agents', 'hooks.json'),
    },
    {
      name: 'windsurf',
      label: 'Windsurf',
      command: 'windsurf',
      mcp: {
        kind: 'json',
        scope: 'global',
        configPath: () => path.join(environment.homeDir, '.codeium', 'windsurf', 'mcp_config.json'),
      },
      hooksPath: root => path.join(root, '.windsurf', 'hooks.json'),
    },
  ];
}
