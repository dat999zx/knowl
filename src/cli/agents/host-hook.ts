import path from 'node:path';
import { validateKnowledgeWrite } from '../../core/knowledge-validation.js';
import { SessionEventType } from '../../core/types.js';
import type {
  HookHost, NormalizedHookEventName, NormalizedHostHook,
} from '../../core/host-hook-types.js';
import { isSessionEventType } from './lifecycle.js';
import { hostProfile, isHookHost } from '../../session/hosts/index.js';

/**
 * The hook types are declared in `core/host-hook-types.ts` and re-exported here.
 *
 * They moved because the session layer consumes them and would otherwise have to import
 * upward into `cli/`, making the hook path a dependency cycle. The re-export keeps every
 * existing `from '.../host-hook.js'` import working — normalizing a hook and describing
 * the result are still one idea from a caller's point of view.
 */
export type {
  HookHost, NormalizedHookEventName, NormalizedHostHook,
} from '../../core/host-hook-types.js';

const MAX_STRING = 2_000;
const MAX_RETAINED_INPUT = 4_000;
// The set of valid hosts is the profile registry; see `isHookHost`.

export class IncompleteHostHookPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncompleteHostHookPayloadError';
  }
}

const stringValue = (value: unknown, max = MAX_STRING): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined;

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function requireProjectRoot(host: HookHost, raw: Record<string, unknown>): string {
  const declared = stringValue(hostProfile(host).projectRoot?.(raw));
  if (declared) return path.resolve(declared);
  const cwd = stringValue(raw.cwd);
  if (cwd) return path.resolve(cwd);
  const roots = Array.isArray(raw.workspace_roots) ? raw.workspace_roots : [];
  const root = stringValue(roots[0]);
  if (root) return path.resolve(root);
  throw new IncompleteHostHookPayloadError('Host hook payload requires cwd or workspace_roots.');
}

// Identity extraction and event mapping live in each host's profile
// (src/cli/agents/hosts/), so adding a host is adding a file rather than editing
// conditionals here.

function relativePath(projectRoot: string, value: unknown): string | undefined {
  const candidate = stringValue(value);
  if (!candidate) return undefined;
  const relative = path.relative(projectRoot, path.resolve(candidate));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return relative.replaceAll('\\', '/').slice(0, MAX_STRING);
}

function changedPaths(projectRoot: string, raw: Record<string, unknown>): string[] {
  const values = Array.isArray(raw.changed_paths)
    ? raw.changed_paths
    : Array.isArray(raw.changedPaths)
      ? raw.changedPaths
      // `notebook_path` is the name Claude Code gives NotebookEdit's target, and it is the only
      // write tool that does not use `file_path`. Without it a notebook edit normalises to an
      // event with no changed path at all, so the file is never re-indexed and nothing that
      // depends on knowing it changed can fire -- silently, and only for notebooks.
      : [raw.file_path, raw.filePath, raw.path, raw.notebook_path];
  return values
    .map(value => relativePath(projectRoot, value))
    .filter((value): value is string => Boolean(value))
    .slice(0, 50);
}

function checkpointState(raw: Record<string, unknown>): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  for (const key of ['goal', 'completed', 'nextAction', 'blocker', 'artifactRefs', 'verificationStatus']) {
    const value = raw[key];
    if (value === undefined) continue;
    state[key] = Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string').slice(0, 20).map(entry => entry.slice(0, MAX_STRING))
      : typeof value === 'string'
        ? value.slice(0, MAX_STRING)
        : value;
  }
  return state;
}

function toolInput(raw: Record<string, unknown>): Record<string, unknown> {
  return recordValue(raw.tool_input) ?? recordValue(raw.toolInput) ?? {};
}

function commandEvent(projectRoot: string, raw: Record<string, unknown>): Pick<NormalizedHostHook, 'type' | 'payload'> {
  const input = toolInput(raw);
  const command = stringValue(raw.command) ?? stringValue(input.command);
  if (!command) return { type: 'checkpoint', payload: { summary: 'Tool completed' } };
  const exitCode = typeof raw.exit_code === 'number'
    ? raw.exit_code
    : typeof raw.exitCode === 'number'
      ? raw.exitCode
      : typeof recordValue(raw.tool_response)?.exit_code === 'number'
        ? recordValue(raw.tool_response)?.exit_code
        : typeof recordValue(raw.toolResponse)?.exitCode === 'number'
          ? recordValue(raw.toolResponse)?.exitCode
          : 0;
  return { type: 'command', payload: { command, exitCode } };
}

const MAX_CHANGE_KEYS = 20;
const MAX_CHANGE_KEY_LENGTH = 200;

const changeKey = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_CHANGE_KEY_LENGTH) : undefined;

/**
 * Pull the ids and titles this call wrote from its own tool_input. A new commit whose
 * changes match one of these is the caller's own work and must not be reported back.
 */
function knowlChangeKeys(input: Record<string, unknown>): { ids: string[]; titles: string[] } {
  const ids = [changeKey(input.id), changeKey(input.supersedeId), changeKey(input.supersedes)]
    .filter((value): value is string => Boolean(value));
  const titles = [changeKey(input.title)].filter((value): value is string => Boolean(value));
  const atoms = Array.isArray(input.atoms) ? input.atoms : [];
  for (const atom of atoms) {
    const title = changeKey(recordValue(atom)?.title);
    if (title) titles.push(title);
  }
  return { ids: ids.slice(0, MAX_CHANGE_KEYS), titles: titles.slice(0, MAX_CHANGE_KEYS) };
}

/**
 * `mcp__knowl__knowl_store` -> `knowl_store`.
 *
 * Hosts namespace MCP tools by server, and the MCP server records its ranges under the
 * bare tool name it was called with, so the two only line up after this.
 */
function bareKnowlToolName(toolName: string): string | undefined {
  // Split on the last separator rather than searching for "knowl_": the server segment is
  // itself called knowl, so `mcp__knowl__knowl_store` makes a leftmost match swallow the
  // separator and yield `knowl__knowl_store`.
  const bare = (toolName.includes('__') ? toolName.slice(toolName.lastIndexOf('__') + 2) : toolName).toLowerCase();
  return /^knowl_[a-z_]+$/.test(bare) ? bare : undefined;
}

/**
 * What distinguishes this tool call from the previous one, for the debounce only.
 *
 * Bounded rather than hashed so a failing debounce stays readable in a claim file, and
 * truncated because tool inputs carry whole file contents. Serialisation failures fall
 * back to the tool name, which is no worse than the behaviour before this existed.
 */
function toolCaptureKey(toolName: string, input: Record<string, unknown>): string {
  try {
    return `${toolName}:${JSON.stringify(input)}`.slice(0, MAX_STRING);
  } catch {
    return toolName;
  }
}

function toolEvent(host: HookHost, eventName: string, projectRoot: string, raw: Record<string, unknown>): Pick<NormalizedHostHook, 'type' | 'payload' | 'status' | 'toolName' | 'knowlTool' | 'knowlToolName' | 'knowlChangeKeys' | 'captureKey'> {
  const input = toolInput(raw);
  const toolName = stringValue(raw.tool_name) ?? stringValue(raw.toolName) ?? '';
  const knowlTool = /knowl/i.test(toolName);
  const changeKeys = knowlTool
    ? { knowlChangeKeys: knowlChangeKeys(input), knowlToolName: bareKnowlToolName(toolName) }
    : {};
  // Spread, so a payload with no tool_name leaves the field absent rather than empty:
  // `toolName: ''` asserts "a tool called nothing", which a consumer cannot distinguish
  // from a real name it fails to recognise, whereas undefined says the host stayed silent.
  const named = toolName ? { toolName } : {};
  const isShell = hostProfile(host).isShellEvent(eventName, toolName);
  // Shell events already fingerprint on the command itself, so they were never affected.
  if (isShell) return { ...commandEvent(projectRoot, raw), status: typeof raw.exit_code === 'number' && raw.exit_code !== 0 ? 'failed' : undefined, ...named, knowlTool, ...changeKeys };

  const captureKey = toolCaptureKey(toolName, input);
  const paths = changedPaths(projectRoot, { ...raw, ...input });
  if (paths.length > 0) return { type: 'checkpoint', payload: { changedPaths: paths }, ...named, knowlTool, captureKey, ...changeKeys };
  return { type: 'checkpoint', payload: { summary: `${toolName || 'Tool'} completed`.slice(0, MAX_STRING) }, ...named, knowlTool, captureKey, ...changeKeys };
}

function failurePayload(raw: Record<string, unknown>, failed: boolean): Record<string, unknown> {
  if (!failed) return { status: 'finished' };
  const nestedError = recordValue(raw.error);
  const errorCode = stringValue(raw.error)
    ?? stringValue(raw.code)
    ?? stringValue(raw.error_code)
    ?? stringValue(nestedError?.code)
    ?? stringValue(nestedError?.type)
    ?? stringValue(nestedError?.error);
  const message = stringValue(raw.message)
    ?? stringValue(raw.summary)
    ?? stringValue(raw.error_message)
    ?? stringValue(nestedError?.message)
    ?? (errorCode ? undefined : stringValue(raw.error));
  return {
    status: 'failed',
    ...(errorCode ? { error: errorCode, code: errorCode } : {}),
    ...(message ? { message } : {}),
    ...checkpointState(raw),
  };
}

function normalizeGeneric(
  event: NormalizedHookEventName,
  raw: Record<string, unknown>,
  projectRoot: string,
  ids: { externalSessionId: string; externalTurnId?: string },
): NormalizedHostHook {
  // The profile has already validated the event name, so only payload shape is checked here.
  const type = event === 'session-event' ? raw.type : event === 'checkpoint' ? 'checkpoint' : undefined;
  if (event === 'session-event' && type === undefined) throw new IncompleteHostHookPayloadError('Generic session event requires a type.');
  if (type !== undefined && !isSessionEventType(type)) throw new Error(`Unsupported session event type: ${String(type)}`);
  const payload: Record<string, unknown> = {};
  for (const key of ['command', 'exitCode', 'passed', 'summary', 'message', 'code', 'text', 'changedPaths', 'commit', 'status', 'error', 'error_code', 'error_message', 'goal', 'completed', 'nextAction', 'blocker', 'artifactRefs', 'verificationStatus']) {
    if (raw[key] !== undefined) payload[key] = Array.isArray(raw[key]) ? raw[key] : typeof raw[key] === 'string' ? String(raw[key]).slice(0, MAX_STRING) : raw[key];
  }
  // Absolute paths are made repo-relative, the way every other host's already are.
  //
  // This branch copies `changedPaths` verbatim while every other host routes through
  // `changedPaths(projectRoot, ...)`, so a generic caller that reported absolute paths -- which
  // is what a program integrating over this contract naturally has -- stored a spelling nothing
  // else in the codebase uses, and every lookup against it missed. Already-relative entries are
  // left alone: resolving one against the *process* cwd rather than the project root is how a
  // valid path turns into `..` and gets dropped.
  if (Array.isArray(payload.changedPaths)) {
    payload.changedPaths = (payload.changedPaths as unknown[])
      .map(value => (typeof value === 'string' && path.isAbsolute(value)
        ? relativePath(projectRoot, value)
        : typeof value === 'string' ? value : undefined))
      .filter((value): value is string => Boolean(value))
      .slice(0, 50);
  }
  const toolName = stringValue(raw.toolName) ?? stringValue(raw.tool_name);
  return {
    host: 'generic', event, ...ids, projectRoot,
    title: event === 'turn-start' ? stringValue(raw.title) ?? 'Agent turn' : stringValue(raw.title),
    status: event === 'turn-stop' || event === 'session-stop' ? (raw.status === 'failed' ? 'failed' : 'finished') : undefined,
    type: type as SessionEventType | undefined,
    // Carried, where it used to be dropped. `toolName` is the only thing that separates "this
    // session read that file" from "this session wrote it", so a generic caller that named its
    // tool got neither a read-set entry nor impact detection -- silently, because capture
    // itself worked fine and the subsystem simply never fired.
    ...(toolName ? { toolName } : {}),
    payload,
  };
}

function validateNormalizedHostHook(input: NormalizedHostHook): NormalizedHostHook {
  const changedPaths = Array.isArray(input.payload.changedPaths)
    ? input.payload.changedPaths.filter((value): value is string => typeof value === 'string')
    : undefined;
  validateKnowledgeWrite({
    title: input.title,
    rawOutput: JSON.stringify({
      externalSessionId: input.externalSessionId,
      externalTurnId: input.externalTurnId,
      payload: input.payload,
    }),
    affectedPaths: changedPaths,
  }, { maxRawOutputLength: MAX_RETAINED_INPUT });
  return input;
}

function normalizeHostHookUnchecked(host: string, eventName: string, raw: Record<string, unknown>): NormalizedHostHook {
  if (!isHookHost(host)) throw new Error(`Unsupported hook host: ${host}`);
  const normalizedHost = host;
  const profile = hostProfile(normalizedHost);
  const projectRoot = requireProjectRoot(normalizedHost, raw);
  const identity = profile.identity(raw);
  if (!identity.externalSessionId) throw new IncompleteHostHookPayloadError('Host hook payload requires a session id.');
  const ids = { externalSessionId: identity.externalSessionId, externalTurnId: identity.externalTurnId };
  const agent = {
    ...(identity.agentId ? { agentId: identity.agentId } : {}),
    ...(identity.agentType ? { agentType: identity.agentType } : {}),
  };
  const event = profile.normalizedEvent(eventName);
  if (!event) throw new Error(`Unsupported ${normalizedHost} hook event: ${eventName}`);
  if (normalizedHost === 'generic') return normalizeGeneric(event, raw, projectRoot, ids);
  // Checked before every other event because this one fires ahead of *every* tool call --
  // the only branch here whose cost is paid on that path -- and because the host is blocked
  // on the answer, so work done before recognising it is latency in front of the agent.
  if (event === 'tool-precheck') {
    const toolName = stringValue(raw.tool_name) ?? stringValue(raw.toolName);
    return {
      host: normalizedHost,
      event,
      ...ids,
      ...agent,
      projectRoot,
      // The same `changedPaths` helper the post-tool path uses, not a second copy: a gate
      // matches these against paths recorded by earlier events, and two spellings of one
      // file (absolute vs relative, backslashes vs forward) miss each other silently --
      // a gate that never fires looks exactly like a gate with nothing to report.
      // The name keeps the post-tool field's spelling for the same reason; here it means
      // "about to change", and only the event name says which tense applies.
      payload: { changedPaths: changedPaths(projectRoot, { ...raw, ...toolInput(raw) }) },
      // Spread, so a host that named no tool leaves the field absent rather than empty --
      // see `toolName` on NormalizedHostHook.
      ...(toolName ? { toolName } : {}),
    };
  }
  if (event === 'session-start' || event === 'turn-start') {
    return { host: normalizedHost, event, ...ids, projectRoot, title: event === 'turn-start' ? 'Agent turn' : 'Agent session', payload: {} };
  }
  if (event === 'agent-start' || event === 'agent-stop') {
    if (!agent.agentId) throw new IncompleteHostHookPayloadError('Subagent hook payload requires agent_id.');
    return {
      host: normalizedHost,
      event,
      ...ids,
      ...agent,
      projectRoot,
      title: `Agent session (${agent.agentType ?? 'subagent'})`,
      payload: {},
    };
  }
  if (event === 'checkpoint') {
    const summary = stringValue(raw.summary);
    return {
      host: normalizedHost,
      event,
      ...ids,
      projectRoot,
      type: 'checkpoint',
      payload: {
        ...(summary ? { summary } : {}),
        changedPaths: changedPaths(projectRoot, raw),
        ...checkpointState(raw),
      },
    };
  }
  if (event === 'turn-stop' || event === 'session-stop') {
    const failed = eventName === 'StopFailure' || stringValue(raw.status) === 'failed' || Boolean(stringValue(raw.error) || recordValue(raw.error));
    return {
      host: normalizedHost,
      event,
      ...ids,
      projectRoot,
      status: failed ? 'failed' : 'finished',
      payload: failurePayload(raw, failed),
    };
  }
  if (eventName === 'PostToolUseFailure' || eventName === 'postToolUseFailure') {
    return { host: normalizedHost, event, ...ids, projectRoot, type: 'error', status: 'failed', payload: { message: stringValue(raw.error) ?? 'Tool failed' } };
  }
  return { host: normalizedHost, event, ...ids, ...agent, projectRoot, ...toolEvent(normalizedHost, eventName, projectRoot, raw) };
}

export function normalizeHostHook(host: string, eventName: string, raw: Record<string, unknown>): NormalizedHostHook {
  // Stamped once here rather than in each branch: every branch would otherwise have to remember
  // to carry it, and the one that forgot would be the one a host-specific consumer needed.
  const normalized = { ...normalizeHostHookUnchecked(host, eventName, raw), hostEvent: eventName };
  // A precheck is answered and thrown away, never written, so the write validator is
  // guarding nothing here -- and it rejects on a sensitive path, which would turn "the
  // agent is about to touch .env" into a hook error printed in front of that call and
  // every retry of it. Anything a consumer does go on to persist passes the validator at
  // the store, which is the door that actually protects the row.
  if (normalized.event === 'tool-precheck') return normalized;
  return validateNormalizedHostHook(normalized);
}
