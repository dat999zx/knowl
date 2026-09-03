import path from 'node:path';
import { Document, YAMLMap, YAMLSeq, isMap, isSeq } from 'yaml';
import { McpEntry, MergeStatus, mcpEntryMatches, mergeYamlDocument, readYamlDocument } from './files.js';
import { knowlHookCommand } from './hook-config.js';
import { AgentAdapter, AgentDetection, AgentEnvironment, AgentIntegrationResult } from './types.js';
import { KNOWL_MCP_SERVER_KEY } from '../../core/knowl-guidance.js';
import { hostProfile } from '../../session/hosts/index.js';

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

/** Seconds Hermes allows one of our hooks; its default is 60, its ceiling 300. */
const HOOK_TIMEOUT_SECONDS = 30;

/** Every event the hooks block must carry: the lifecycle events plus the prompt event. */
function hermesHookEvents(): string[] {
  const profile = hostProfile('hermes');
  return [...profile.hookEvents, ...(profile.promptEvent ? [profile.promptEvent] : [])];
}

/**
 * The one entry Knowl writes under `hooks.<event>`.
 *
 * `matcher` is a Python regex Hermes `fullmatch`es against the tool name, honoured only on the
 * two tool events. On `pre_tool_call` it is the profile's `writeTools`, so Hermes never starts a
 * process for a `read_file` the gate would answer "no opinion" to -- the same ~170ms-per-call
 * saving the Claude matcher exists for. `post_tool_call` stays unmatched: reads feed the read-set.
 */
function knowlHookEntry(platform: NodeJS.Platform, event: string): Record<string, unknown> {
  const { writeTools } = hostProfile('hermes');
  return {
    command: knowlHookCommand(platform, 'hermes', event),
    ...(event === 'pre_tool_call' && writeTools ? { matcher: writeTools.join('|') } : {}),
    timeout: HOOK_TIMEOUT_SECONDS,
  };
}

const ownsEntry = (value: unknown): boolean =>
  isMap(value) && typeof value.get('command') === 'string' && (value.get('command') as string).includes(' agent-hook hermes ');

function sameEntry(node: unknown, wanted: Record<string, unknown>): boolean {
  return isMap(node) && JSON.stringify(node.toJSON()) === JSON.stringify(wanted);
}

function serverMatches(doc: Document, entry: McpEntry): boolean {
  const server = doc.getIn(['mcp_servers', KNOWL_MCP_SERVER_KEY]);
  const json = isMap(server) ? server.toJSON() : server;
  return mcpEntryMatches(json, entry);
}

/** Whether every event carries exactly our current entry. */
function hooksConfigured(doc: Document, platform: NodeJS.Platform): boolean {
  return hermesHookEvents().every(event => {
    const list = doc.getIn(['hooks', event], true);
    return isSeq(list) && list.items.some(item => sameEntry(item, knowlHookEntry(platform, event)));
  });
}

/**
 * One Document edit for both halves: the MCP server and the hook entries.
 *
 * Nothing here runs `hermes`. Its own mutators (`hermes plugins enable`, `hermes config set`)
 * re-serialise the whole file through a plain YAML dump, which drops every comment of the
 * 2,147-line shipped template, and some of them stop on an interactive prompt a non-TTY
 * `knowl init` can never answer -- both seen against v0.21.0 on 2026-09-03. Editing the two
 * keys the loader reads, through the comment-preserving merge, is the whole effect.
 *
 * Per event: an existing Knowl entry (recognised by ` agent-hook hermes ` in its command, so a
 * platform change or a new matcher replaces rather than duplicates) is rewritten in place; a
 * foreign entry is left alone; a missing one is appended.
 */
export function mutateHermesConfig(doc: Document, entry: McpEntry, platform: NodeJS.Platform): boolean {
  let changed = false;
  if (!serverMatches(doc, entry)) {
    doc.setIn(['mcp_servers', KNOWL_MCP_SERVER_KEY], doc.createNode({ command: entry.command, args: entry.args }));
    changed = true;
  }
  for (const event of hermesHookEvents()) {
    const wanted = knowlHookEntry(platform, event);
    const existing = doc.getIn(['hooks', event], true);
    const list: YAMLSeq = isSeq(existing) ? existing : (doc.createNode([]) as YAMLSeq);
    if (!isSeq(existing)) doc.setIn(['hooks', event], list);
    const index = list.items.findIndex(ownsEntry);
    if (index >= 0 && sameEntry(list.items[index], wanted)) continue;
    const node = doc.createNode(wanted) as YAMLMap;
    if (index >= 0) list.items[index] = node; else list.add(node);
    changed = true;
  }
  return changed;
}

const CONSENT_NOTE = 'Hermes asks once per hook at the terminal on first use, then remembers it in shell-hooks-allowlist.json; '
  + 'a gateway or Hermes Desktop run needs that approval first, or hooks_auto_accept: true in config.yaml. '
  + 'In a running chat, /reload-mcp connects the knowl server.';

/**
 * Hermes: one global `config.yaml` holding both the MCP server and the shell hooks.
 *
 * There is no project-local config, so both halves are global and `detect().configured` asks
 * the file, never the presence of a project directory.
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
      return {
        installed: await environment.commandExists('hermes'),
        configured: doc !== undefined && serverMatches(doc, entry) && hooksConfigured(doc, environment.platform),
        scope: 'global',
        configPath: configPath(),
      };
    },
    async configure(): Promise<AgentIntegrationResult> {
      let status: MergeStatus;
      try {
        status = await mergeYamlDocument(configPath(), doc => mutateHermesConfig(doc, entry, environment.platform));
      } catch (error: any) {
        return { agent: 'hermes', status: 'failed', scope: 'global', configPath: configPath(), message: `Could not merge ${configPath()}: ${error.message}` };
      }
      return { agent: 'hermes', status, scope: 'global', configPath: configPath(), message: CONSENT_NOTE };
    },
    async verify() {
      return (await this.detect('')).configured;
    },
    async lifecycleCapability() { return 'supported'; },
    // The hooks were written by `configure`, in the same file as the MCP entry; this reports on
    // them rather than writing a second time.
    async configureLifecycle() {
      const doc = await readDoc();
      const configured = doc !== undefined && hooksConfigured(doc, environment.platform);
      return { agent: 'hermes', status: configured ? 'unchanged' : 'failed', scope: 'global', configPath: configPath(), message: configured ? 'Shell hooks are in config.yaml.' : 'Shell hooks missing from config.yaml.' };
    },
    async verifyLifecycle() {
      const doc = await readDoc();
      return doc !== undefined && hooksConfigured(doc, environment.platform);
    },
  };
}
