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
// guidance.json is generated from src/core/plugin-guidance.ts (npm run docs:generate); the plugin reads its rules from it.
const PLUGIN_FILES = ['plugin.yaml', '__init__.py', 'guidance.json'];

function stringItems(doc: Document, keys: string[]): string[] {
  const node = doc.getIn(keys, true);
  return isSeq(node) ? (node as YAMLSeq).items.map(item => String((item as any)?.value ?? item)) : [];
}

/**
 * `memory.provider` is ours, or someone else's.
 *
 * Hermes runs one external memory provider, and it is the only route that puts `knowl_query`
 * in front of the model without a `tool_search` step (plugin and MCP tools are deferred;
 * a provider's tools are not). So an unset provider becomes ours -- and a provider the person
 * already chose is never replaced: swapping their memory backend is not ours to decide.
 */
function providerOk(doc: Document): boolean {
  const value = doc.getIn(['memory', 'provider']);
  const text = String((value as any)?.value ?? value ?? '').trim();
  return text !== '';
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
  if (!providerOk(doc)) {
    doc.setIn(['memory', 'provider'], PLUGIN_NAME);
    changed = true;
  }
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

/**
 * The plugin is installed AND is the copy this package ships.
 *
 * The files are copied, so an npm update never reaches them: Hermes keeps loading the old plugin
 * and nothing says so. Comparing bytes makes "stale" read as "not configured", which is what
 * `doctor` and `init` already know how to repair.
 */
async function pluginInstalled(home: string): Promise<boolean> {
  try {
    const same = await Promise.all(PLUGIN_FILES.map(async file => {
      const [installed, shipped] = await Promise.all([
        fs.readFile(path.join(home, 'plugins', PLUGIN_NAME, file)),
        fs.readFile(path.join(hermesPluginSourceDir(), file)),
      ]);
      return installed.equals(shipped);
    }));
    return same.every(Boolean);
  } catch {
    return false;
  }
}

const RESTART_NOTE = 'Restart Hermes (or start a new session) to load the plugin; /reload-mcp connects the knowl server in a running chat. Knowl is set as the memory provider (Settings > Memory & Context) so knowl_query and knowl_store are always available; if you already use another provider it was left alone, and the tools stay behind tool_search.';

async function hermesHomesToConfigure(home: string): Promise<string[]> {
  const homes = [home];
  const profilesDir = path.join(home, 'profiles');
  try {
    const entries = await fs.readdir(profilesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.includes('.backup')) continue;
      const profileHome = path.join(profilesDir, entry.name);
      const isDir = entry.isDirectory()
        || (entry.isSymbolicLink() && await fs.stat(profileHome).then(s => s.isDirectory(), () => false));
      if (!isDir) continue;
      const hasConfig = await fs.access(path.join(profileHome, 'config.yaml')).then(() => true, () => false);
      if (hasConfig) homes.push(profileHome);
    }
  } catch {
    // No named profiles directory, or unreadable: configure only the base home.
  }
  return homes;
}

async function homeLifecycleConfigured(home: string): Promise<boolean> {
  try {
    const doc = await readYamlDocument(path.join(home, 'config.yaml'));
    return doc !== undefined && pluginEnabled(doc) && await pluginInstalled(home);
  } catch {
    return false;
  }
}

async function homeConfigured(home: string, entry: McpEntry): Promise<boolean> {
  try {
    const doc = await readYamlDocument(path.join(home, 'config.yaml'));
    return doc !== undefined
      && serverMatches(doc, entry)
      && pluginEnabled(doc)
      && providerOk(doc)
      && !hasShellHooks(doc)
      && await pluginInstalled(home);
  } catch {
    return false;
  }
}

/**
 * Hermes: global `config.yaml` plus a plugin directory, and any named profiles under `profiles/`.
 *
 * The plugin files are copied, not linked: Hermes runs from a managed venv and `hermes update`
 * re-runs install hooks, and a symlink into a `node_modules` that npm may replace is a plugin
 * that vanishes on the next `npm update`. Only the files Knowl ships are overwritten.
 */
export function createHermesAdapter(environment: AgentEnvironment): AgentAdapter {
  const entry: McpEntry = { command: environment.platform === 'win32' ? 'knowl.cmd' : 'knowl', args: ['serve', '--host', 'hermes'] };
  const configPath = () => path.join(hermesHomeDir(environment), 'config.yaml');
  return {
    name: 'hermes',
    label: 'Hermes Agent',
    async detect(): Promise<AgentDetection> {
      const baseHome = hermesHomeDir(environment);
      const homes = await hermesHomesToConfigure(baseHome);
      const results = await Promise.all(homes.map(h => homeConfigured(h, entry)));
      const configured = results.length > 0 && results.every(Boolean);
      // A plugin directory that exists but differs from the shipped one is an install an update left behind.
      const present = configured || await fs.access(path.join(baseHome, 'plugins', PLUGIN_NAME, '__init__.py')).then(() => true, () => false);
      return {
        installed: await environment.commandExists('hermes'),
        configured,
        present,
        scope: 'global',
        configPath: configPath(),
      };
    },
    async configure(): Promise<AgentIntegrationResult> {
      const baseHome = hermesHomeDir(environment);
      const homes = await hermesHomesToConfigure(baseHome);
      let status: MergeStatus = 'unchanged';
      for (const home of homes) {
        const targetConfig = path.join(home, 'config.yaml');
        try {
          const currentStatus = await mergeYamlDocument(targetConfig, doc => mutateHermesConfig(doc, entry));
          if (home === baseHome) status = currentStatus;
          else if (status === 'unchanged' && currentStatus !== 'unchanged') status = 'updated';
          const target = path.join(home, 'plugins', PLUGIN_NAME);
          await fs.mkdir(target, { recursive: true });
          for (const file of PLUGIN_FILES) await fs.copyFile(path.join(hermesPluginSourceDir(), file), path.join(target, file));
        } catch (error: any) {
          return { agent: 'hermes', status: 'failed', scope: 'global', configPath: targetConfig, message: `Could not configure ${targetConfig}: ${error.message}` };
        }
      }
      return { agent: 'hermes', status, scope: 'global', configPath: configPath(), message: RESTART_NOTE };
    },
    async verify() {
      return (await this.detect('')).configured;
    },
    async lifecycleCapability() { return 'supported'; },
    // The lifecycle is the plugin, installed by `configure` in the same pass as the MCP entry;
    // this reports on it rather than writing a second time.
    async configureLifecycle() {
      const homes = await hermesHomesToConfigure(hermesHomeDir(environment));
      const installed = (await Promise.all(homes.map(h => pluginInstalled(h)))).every(Boolean);
      return {
        agent: 'hermes',
        status: installed ? 'unchanged' : 'failed',
        scope: 'global',
        configPath: path.join(hermesHomeDir(environment), 'plugins', PLUGIN_NAME),
        message: installed ? 'Lifecycle runs through the installed plugin.' : 'Plugin missing from the Hermes plugins directory.',
      };
    },
    async verifyLifecycle() {
      const homes = await hermesHomesToConfigure(hermesHomeDir(environment));
      const checks = await Promise.all(homes.map(h => homeLifecycleConfigured(h)));
      return checks.every(Boolean);
    },
  };
}
