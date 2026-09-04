import fs from 'node:fs/promises';
import path from 'node:path';
import { Document, YAMLSeq, isMap, isSeq } from 'yaml';
import { McpEntry, MergeStatus, mcpEntryMatches, mergeYamlDocument, packageRootDir, readYamlDocument } from './files.js';
import { AgentAdapter, AgentDetection, AgentEnvironment, AgentIntegrationResult } from './types.js';
import { KNOWL_MCP_SERVER_KEY } from '../../core/knowl-guidance.js';

/**
 * Where Hermes keeps its home, mirroring `get_hermes_home()` in `hermes_constants.py`:
 * `HERMES_HOME`, else the platform default -- `%LOCALAPPDATA%\\hermes` on Windows (verified against
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

/** The plugin shipped inside this package, copied into Hermes' own plugins directory. */
export function hermesPluginSourceDir(): string {
  return path.join(packageRootDir(), 'integrations', 'hermes', 'knowl');
}

const PLUGIN_NAME = 'knowl';
const PLUGIN_FILES = ['plugin.yaml', '__init__.py'];

function stringItems(doc: Document, keys: string[]): string[] {
  const node = doc.getIn(keys, true);
  return isSeq(node) ? (node as YAMLSeq).items.map(item => String((item as any)?.value ?? item)) : [];
}

/** `plugins.enabled` lists us and `plugins.disabled` does not -- the two lists Hermes' loader reads. */
function pluginEnabled(doc: Document): boolean {
  return stringItems(doc, ['plugins', 'enabled']).includes(PLUGIN_NAME)
    && !stringItems(doc, ['plugins', 'disabled']).includes(PLUGIN_NAME);
}

function serverMatches(doc: Document, entry: McpEntry): boolean {
  const server = doc.getIn(['mcp_servers', KNOWL_MCP_SERVER_KEY]);
  const json = isMap(server) ? server.toJSON() : server;
  return mcpEntryMatches(json, entry);
}

/**
 * Hook entries 5.19.0 wrote into `hooks.<event>`, recognised by their command.
 *
 * They have to go when the plugin arrives, and not because they are untidy: in a terminal
 * session Hermes registers both channels, so every event would reach the engine twice --
 * two `knowl` processes per tool call, two capture events, two stop verdicts. Leaving them
 * also leaves the seven consent prompts they ask for, for a channel nothing reads any more.
 */
function removeShellHooks(doc: Document): boolean {
  const hooks = doc.get('hooks', true);
  if (!isMap(hooks)) return false;
  let changed = false;
  for (const pair of [...hooks.items]) {
    const list = pair.value;
    if (!isSeq(list)) continue;
    const kept = (list as YAMLSeq).items.filter(item => {
      const command = isMap(item) ? item.get('command') : undefined;
      return !(typeof command === 'string' && command.includes(' agent-hook hermes '));
    });
    if (kept.length === (list as YAMLSeq).items.length) continue;
    changed = true;
    if (kept.length === 0) hooks.delete(pair.key);
    else (list as YAMLSeq).items = kept;
  }
  // An empty `hooks:` mapping left behind is a key the person never wrote.
  if (changed && hooks.items.length === 0) doc.delete('hooks');
  return changed;
}

function hasShellHooks(doc: Document): boolean {
  const hooks = doc.get('hooks', true);
  if (!isMap(hooks)) return false;
  return hooks.items.some(pair => isSeq(pair.value)
    && (pair.value as YAMLSeq).items.some(item => {
      const command = isMap(item) ? item.get('command') : undefined;
      return typeof command === 'string' && command.includes(' agent-hook hermes ');
    }));
}

/**
 * One Document edit for everything Hermes needs to know: the MCP server, the plugin switch, and
 * the removal of any shell hooks an earlier version wrote.
 *
 * Nothing here runs `hermes`. Its own mutators (`hermes plugins enable`, `hermes config set`)
 * re-serialise the whole file through a plain YAML dump, which drops every comment of the
 * 2,147-line shipped template, and some of them stop on an interactive prompt a non-TTY
 * `knowl init` can never answer -- both seen against v0.21.0 on 2026-09-03. Editing the keys the
 * loader reads, through the comment-preserving merge, is the whole effect.
 */
export function mutateHermesConfig(doc: Document, entry: McpEntry): boolean {
  let changed = removeShellHooks(doc);
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
    await Promise.all(PLUGIN_FILES.map(file => fs.access(path.join(home, 'plugins', PLUGIN_NAME, file))));
    return true;
  } catch {
    return false;
  }
}

const RESTART_NOTE = 'Restart Hermes (or start a new session) to load the plugin; /reload-mcp connects the knowl server in a running chat.';

/**
 * Hermes: one global `config.yaml` plus a plugin directory.
 *
 * The plugin files are copied, not linked: Hermes runs from a managed venv and `hermes update`
 * re-runs install hooks, and a symlink into a `node_modules` that npm may replace is a plugin
 * that vanishes on the next `npm update`. Only the files Knowl ships are overwritten.
 */
export function createHermesAdapter(environment: AgentEnvironment): AgentAdapter {
  const entry: McpEntry = { command: environment.platform === 'win32' ? 'knowl.cmd' : 'knowl', args: ['serve', '--host', 'hermes'] };
  const configPath = () => path.join(hermesHomeDir(environment), 'config.yaml');
  const readDoc = async () => {
    try {
      return await readYamlDocument(configPath());
    } catch {
      return undefined;
    }
  };
  return {
    name: 'hermes',
    label: 'Hermes Agent',
    async detect(): Promise<AgentDetection> {
      const doc = await readDoc();
      const configured = doc !== undefined
        && serverMatches(doc, entry)
        && pluginEnabled(doc)
        && !hasShellHooks(doc)
        && await pluginInstalled(hermesHomeDir(environment));
      return {
        installed: await environment.commandExists('hermes'),
        configured,
        scope: 'global',
        configPath: configPath(),
      };
    },
    async configure(): Promise<AgentIntegrationResult> {
      const home = hermesHomeDir(environment);
      let status: MergeStatus;
      try {
        status = await mergeYamlDocument(configPath(), doc => mutateHermesConfig(doc, entry));
      } catch (error: any) {
        return { agent: 'hermes', status: 'failed', scope: 'global', configPath: configPath(), message: `Could not merge ${configPath()}: ${error.message}` };
      }
      const target = path.join(home, 'plugins', PLUGIN_NAME);
      await fs.mkdir(target, { recursive: true });
      for (const file of PLUGIN_FILES) await fs.copyFile(path.join(hermesPluginSourceDir(), file), path.join(target, file));
      return { agent: 'hermes', status, scope: 'global', configPath: configPath(), message: RESTART_NOTE };
    },
    async verify() {
      return (await this.detect('')).configured;
    },
    async lifecycleCapability() { return 'supported'; },
    // The lifecycle is the plugin, installed by `configure` in the same pass as the MCP entry;
    // this reports on it rather than writing a second time.
    async configureLifecycle() {
      const installed = await pluginInstalled(hermesHomeDir(environment));
      return {
        agent: 'hermes',
        status: installed ? 'unchanged' : 'failed',
        scope: 'global',
        configPath: path.join(hermesHomeDir(environment), 'plugins', PLUGIN_NAME),
        message: installed ? 'Lifecycle runs through the installed plugin.' : 'Plugin missing from the Hermes plugins directory.',
      };
    },
    async verifyLifecycle() {
      const doc = await readDoc();
      return doc !== undefined && pluginEnabled(doc) && await pluginInstalled(hermesHomeDir(environment));
    },
  };
}
