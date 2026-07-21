import path from 'node:path';
import { validateKnowledgeWrite } from '../../core/knowledge-validation.js';
import { SessionEventType } from '../../core/types.js';
import { isSessionEventType } from './lifecycle.js';
import { AgentName } from './types.js';

export type HookHost = 'codex' | 'claude' | 'cursor' | 'claude-desktop' | 'generic';
export type NormalizedHookEventName =
  | 'session-start'
  | 'turn-start'
  | 'session-event'
  | 'checkpoint'
  | 'turn-stop'
  | 'session-stop';

export interface NormalizedHostHook {
  host: HookHost;
  event: NormalizedHookEventName;
  externalSessionId: string;
  externalTurnId?: string;
  projectRoot: string;
  title?: string;
  status?: 'finished' | 'failed';
  type?: SessionEventType;
  payload: Record<string, unknown>;
}

const MAX_STRING = 2_000;
const MAX_RETAINED_INPUT = 4_000;
const AGENT_HOSTS = new Set<HookHost>(['codex', 'claude', 'cursor', 'claude-desktop', 'generic']);

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

function requireString(raw: Record<string, unknown>, key: string): string {
  const value = stringValue(raw[key]);
  if (!value) throw new IncompleteHostHookPayloadError(`Host hook payload requires ${key}.`);
  return value;
}

function requireProjectRoot(raw: Record<string, unknown>): string {
  const cwd = stringValue(raw.cwd);
  if (cwd) return path.resolve(cwd);
  const roots = Array.isArray(raw.workspace_roots) ? raw.workspace_roots : [];
  const root = stringValue(roots[0]);
  if (root) return path.resolve(root);
  throw new IncompleteHostHookPayloadError('Host hook payload requires cwd or workspace_roots.');
}

function externalIds(host: HookHost, raw: Record<string, unknown>) {
  const externalSessionId = host === 'cursor'
    ? stringValue(raw.conversation_id)
    : host === 'generic'
      ? stringValue(raw.sessionId)
      : stringValue(raw.session_id) ?? stringValue(raw.conversation_id) ?? stringValue(raw.thread_id);
  if (!externalSessionId) throw new IncompleteHostHookPayloadError('Host hook payload requires a session id.');
  const externalTurnId = host === 'cursor'
    ? stringValue(raw.generation_id)
    : host === 'generic'
      ? stringValue(raw.turnId)
      : stringValue(raw.turn_id) ?? stringValue(raw.generation_id);
  return { externalSessionId, externalTurnId };
}

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
      : [raw.file_path, raw.filePath, raw.path];
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

function toolEvent(host: HookHost, eventName: string, projectRoot: string, raw: Record<string, unknown>): Pick<NormalizedHostHook, 'type' | 'payload' | 'status'> {
  const input = toolInput(raw);
  const toolName = stringValue(raw.tool_name) ?? stringValue(raw.toolName) ?? '';
  const isShell = host === 'cursor'
    ? eventName === 'afterShellExecution'
    : toolName.toLocaleLowerCase() === 'bash' || toolName.toLocaleLowerCase() === 'shell';
  if (isShell) return { ...commandEvent(projectRoot, raw), status: typeof raw.exit_code === 'number' && raw.exit_code !== 0 ? 'failed' : undefined };

  const paths = changedPaths(projectRoot, { ...raw, ...input });
  if (paths.length > 0) return { type: 'checkpoint', payload: { changedPaths: paths } };
  return { type: 'checkpoint', payload: { summary: `${toolName || 'Tool'} completed`.slice(0, MAX_STRING) } };
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

function normalizeGeneric(eventName: string, raw: Record<string, unknown>, projectRoot: string, ids: ReturnType<typeof externalIds>): NormalizedHostHook {
  const event = eventName as NormalizedHookEventName;
  const allowed: NormalizedHookEventName[] = ['session-start', 'turn-start', 'session-event', 'checkpoint', 'turn-stop', 'session-stop'];
  if (!allowed.includes(event)) throw new Error(`Unsupported generic hook event: ${eventName}`);
  const type = event === 'session-event' ? raw.type : event === 'checkpoint' ? 'checkpoint' : undefined;
  if (event === 'session-event' && type === undefined) throw new IncompleteHostHookPayloadError('Generic session event requires a type.');
  if (type !== undefined && !isSessionEventType(type)) throw new Error(`Unsupported session event type: ${String(type)}`);
  const payload: Record<string, unknown> = {};
  for (const key of ['command', 'exitCode', 'passed', 'summary', 'message', 'code', 'text', 'changedPaths', 'commit', 'status', 'error', 'error_code', 'error_message', 'goal', 'completed', 'nextAction', 'blocker', 'artifactRefs', 'verificationStatus']) {
    if (raw[key] !== undefined) payload[key] = Array.isArray(raw[key]) ? raw[key] : typeof raw[key] === 'string' ? String(raw[key]).slice(0, MAX_STRING) : raw[key];
  }
  return {
    host: 'generic', event, ...ids, projectRoot,
    title: event === 'turn-start' ? stringValue(raw.title) ?? 'Agent turn' : stringValue(raw.title),
    status: event === 'turn-stop' || event === 'session-stop' ? (raw.status === 'failed' ? 'failed' : 'finished') : undefined,
    type: type as SessionEventType | undefined,
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
  if (!AGENT_HOSTS.has(host as HookHost)) throw new Error(`Unsupported hook host: ${host}`);
  const normalizedHost = host as HookHost;
  const projectRoot = requireProjectRoot(raw);
  const ids = externalIds(normalizedHost, raw);
  if (normalizedHost === 'generic') return normalizeGeneric(eventName, raw, projectRoot, ids);

  const eventMap: Record<string, NormalizedHookEventName> = normalizedHost === 'codex' || normalizedHost === 'claude'
    ? {
        SessionStart: 'session-start', UserPromptSubmit: 'turn-start', PostToolUse: 'session-event',
        PostToolUseFailure: 'session-event', PreCompact: 'checkpoint', Stop: 'turn-stop',
        StopFailure: 'turn-stop', SessionEnd: 'session-stop',
      }
    : {
        sessionStart: 'session-start', beforeSubmitPrompt: 'turn-start', afterShellExecution: 'session-event',
        postToolUse: 'session-event', postToolUseFailure: 'session-event', afterFileEdit: 'session-event',
        preCompact: 'checkpoint', stop: 'turn-stop', sessionEnd: 'session-stop',
      };
  const event = eventMap[eventName];
  if (!event) throw new Error(`Unsupported ${normalizedHost} hook event: ${eventName}`);
  if (event === 'session-start' || event === 'turn-start') {
    return { host: normalizedHost, event, ...ids, projectRoot, title: event === 'turn-start' ? 'Agent turn' : 'Agent session', payload: {} };
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
  return { host: normalizedHost, event, ...ids, projectRoot, ...toolEvent(normalizedHost, eventName, projectRoot, raw) };
}

export function normalizeHostHook(host: string, eventName: string, raw: Record<string, unknown>): NormalizedHostHook {
  return validateNormalizedHostHook(normalizeHostHookUnchecked(host, eventName, raw));
}
