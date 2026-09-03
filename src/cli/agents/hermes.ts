import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Document } from 'yaml';
import { McpEntry, MergeStatus, mcpEntryMatches, mergeYamlDocument, packageRootDir, readYamlDocument } from './files.js';
import { AgentAdapter, AgentDetection, AgentEnvironment, AgentIntegrationResult } from './types.js';
import { KNOWL_MCP_SERVER_KEY } from '../../core/knowl-guidance.js';

const execFileAsync = promisify(execFile);

/** `HERMES_HOME`, else `~/.hermes` -- Hermes' own constant. */
export function hermesHomeDir(environment: AgentEnvironment): string {
  return process.env.HERMES_HOME || path.join(environment.homeDir, '.hermes');
}

export function hermesPluginSourceDir(): string {
  return path.join(packageRootDir(), 'integrations', 'hermes', 'knowl');
}

const PLUGIN_FILES = ['plugin.yaml', '__init__.py'];

function serverMatches(doc: Document, entry: McpEntry): boolean {
  const server = doc.getIn(['mcp_servers', KNOWL_MCP_SERVER_KEY]);
  const json = server && typeof (server as any).toJSON === 'function' ? (server as any).toJSON() : server;
  return mcpEntryMatches(json, entry);
}

function mutateHermesConfig(doc: Document, entry: McpEntry): boolean {
  if (serverMatches(doc, entry)) return false;
  doc.setIn(['mcp_servers', KNOWL_MCP_SERVER_KEY], doc.createNode({ command: entry.command, args: entry.args }));
  return true;
}

async function pluginInstalled(home: string): Promise<boolean> {
  try {
    await Promise.all(PLUGIN_FILES.map(file => fs.access(path.join(home, 'plugins', 'knowl', file))));
    return true;
  } catch {
    return false;
  }
}

/**
 * Hermes: a global `config.yaml` (there is no project-local one) plus a plugin directory.
 *
 * The plugin files are copied, not linked: Hermes runs from a managed venv and `hermes update`
 * re-runs install hooks, and a symlink into a `node_modules` that npm may replace is a plugin
 * that vanishes on the next `npm update`. Only the files Knowl ships are overwritten.
 */
export function createHermesAdapter(
  environment: AgentEnvironment,
  options: { exec?: (file: string, args: string[]) => Promise<void> } = {},
): AgentAdapter {
  const exec = options.exec ?? (async (file, args) => { await execFileAsync(file, args); });
  const entry: McpEntry = { command: environment.platform === 'win32' ? 'knowl.cmd' : 'knowl', args: ['serve', '--host', 'hermes'] };
  const configPath = () => path.join(hermesHomeDir(environment), 'config.yaml');
  const reload = 'In a running Hermes chat, type /reload-mcp to connect the knowl server.';
  return {
    name: 'hermes',
    label: 'Hermes Agent',
    async detect(): Promise<AgentDetection> {
      let configured = false;
      try {
        const doc = await readYamlDocument(configPath());
        configured = doc !== undefined && serverMatches(doc, entry) && await pluginInstalled(hermesHomeDir(environment));
      } catch {
        configured = false;
      }
      return { installed: await environment.commandExists('hermes'), configured, scope: 'global', configPath: configPath() };
    },
    async configure(): Promise<AgentIntegrationResult> {
      const home = hermesHomeDir(environment);
      let status: MergeStatus;
      try {
        status = await mergeYamlDocument(configPath(), doc => mutateHermesConfig(doc, entry));
      } catch (error: any) {
        return { agent: 'hermes', status: 'failed', scope: 'global', configPath: configPath(), message: `Could not merge ${configPath()}: ${error.message}` };
      }
      const target = path.join(home, 'plugins', 'knowl');
      await fs.mkdir(target, { recursive: true });
      for (const file of PLUGIN_FILES) await fs.copyFile(path.join(hermesPluginSourceDir(), file), path.join(target, file));
      if (!(await environment.commandExists('hermes'))) {
        return { agent: 'hermes', status, scope: 'global', configPath: configPath(), message: `hermes is not on PATH. Once it is, run: hermes plugins enable knowl. ${reload}` };
      }
      try {
        await exec('hermes', ['plugins', 'enable', 'knowl']);
      } catch (error: any) {
        return { agent: 'hermes', status, scope: 'global', configPath: configPath(), message: `Could not enable the plugin (${error.message}). Run: hermes plugins enable knowl. ${reload}` };
      }
      return { agent: 'hermes', status, scope: 'global', configPath: configPath(), message: reload };
    },
    async verify() {
      return (await this.detect('')).configured;
    },
    async lifecycleCapability() { return 'supported'; },
    async configureLifecycle() {
      return { agent: 'hermes', status: 'unchanged', scope: 'global', configPath: path.join(hermesHomeDir(environment), 'plugins', 'knowl'), message: 'Lifecycle runs through the installed plugin.' };
    },
    async verifyLifecycle() { return pluginInstalled(hermesHomeDir(environment)); },
  };
}
