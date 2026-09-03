import fs from 'node:fs/promises';
import path from 'node:path';
import { Document, YAMLSeq, isSeq } from 'yaml';
import { McpEntry, MergeStatus, mcpEntryMatches, mergeYamlDocument, packageRootDir, readYamlDocument } from './files.js';
import { AgentAdapter, AgentDetection, AgentEnvironment, AgentIntegrationResult } from './types.js';
import { KNOWL_MCP_SERVER_KEY } from '../../core/knowl-guidance.js';

/**
 * Where Hermes keeps its home, mirroring `get_hermes_home()` in `hermes_constants.py`:
 * `HERMES_HOME`, else the platform default -- `%LOCALAPPDATA%\hermes` on Windows (verified against
 * Hermes v0.21.0 installed here 2026-09-03, where `~/.hermes` does not exist at all) and
 * `~/.hermes` everywhere else.
 */
export function hermesHomeDir(environment: AgentEnvironment): string {
  if (process.env.HERMES_HOME) return process.env.HERMES_HOME;
  if (environment.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    return path.join(localAppData || path.join(environment.homeDir, 'AppData', 'Local'), 'hermes');
  }
  return path.join(environment.homeDir, '.hermes');
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

const PLUGIN_NAME = 'knowl';

function stringItems(doc: Document, keys: string[]): string[] {
  const node = doc.getIn(keys, true);
  return isSeq(node) ? (node as YAMLSeq).items.map(item => String((item as any)?.value ?? item)) : [];
}

/** `plugins.enabled` lists us and `plugins.disabled` does not -- the two lists Hermes' loader reads. */
function pluginEnabled(doc: Document): boolean {
  return stringItems(doc, ['plugins', 'enabled']).includes(PLUGIN_NAME)
    && !stringItems(doc, ['plugins', 'disabled']).includes(PLUGIN_NAME);
}

/**
 * Writes what `hermes plugins enable knowl` would write, without running it.
 *
 * Running it was tried first, against Hermes v0.21.0 on 2026-09-03, and it did two things this
 * adapter must not do to a person's config: it re-serialised the whole of `config.yaml` through
 * Hermes' own dumper, which dropped all 1,883 comment lines of the shipped template, and for a
 * non-bundled plugin it stopped on an interactive "grant built-in tool override?" prompt that a
 * non-TTY `knowl init` can never answer. The loader (`hermes_cli/plugins.py`) reads nothing but
 * `plugins.enabled` and `plugins.disabled`, and this plugin declares no capabilities, so the two
 * list edits are the entire effect -- and made here they ride the same comment-preserving merge
 * as the MCP entry.
 */
function mutateHermesConfig(doc: Document, entry: McpEntry): boolean {
  let changed = false;
  if (!serverMatches(doc, entry)) {
    doc.setIn(['mcp_servers', KNOWL_MCP_SERVER_KEY], doc.createNode({ command: entry.command, args: entry.args }));
    changed = true;
  }
  if (!pluginEnabled(doc)) {
    const enabled = stringItems(doc, ['plugins', 'enabled']);
    if (!enabled.includes(PLUGIN_NAME)) doc.setIn(['plugins', 'enabled'], doc.createNode([...enabled, PLUGIN_NAME]));
    const disabled = stringItems(doc, ['plugins', 'disabled']);
    if (disabled.includes(PLUGIN_NAME)) doc.setIn(['plugins', 'disabled'], doc.createNode(disabled.filter(name => name !== PLUGIN_NAME)));
    changed = true;
  }
  return changed;
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
 *
 * Nothing here runs `hermes` itself; see `mutateHermesConfig` for why.
 */
export function createHermesAdapter(environment: AgentEnvironment): AgentAdapter {
  const entry: McpEntry = { command: environment.platform === 'win32' ? 'knowl.cmd' : 'knowl', args: ['serve', '--host', 'hermes'] };
  const configPath = () => path.join(hermesHomeDir(environment), 'config.yaml');
  const reload = 'Plugin enabled in config.yaml; it loads on the next Hermes session. In a running chat, /reload-mcp connects the knowl server.';
  return {
    name: 'hermes',
    label: 'Hermes Agent',
    async detect(): Promise<AgentDetection> {
      let configured: boolean;
      try {
        const doc = await readYamlDocument(configPath());
        configured = doc !== undefined && serverMatches(doc, entry) && pluginEnabled(doc) && await pluginInstalled(hermesHomeDir(environment));
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
