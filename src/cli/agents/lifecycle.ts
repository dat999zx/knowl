import { Readable } from 'node:stream';
import chain from 'stream-chain';
import { parser } from 'stream-json';
import { streamObject } from 'stream-json/streamers/stream-object.js';
import { SessionEventType } from '../../core/types.js';
import { LifecycleCapability, LifecycleEvent } from './types.js';

const capabilities: LifecycleCapability[] = ['supported', 'unsupported', 'degraded'];
const events: LifecycleEvent[] = ['session-start', 'session-event', 'session-stop', 'session-recover'];
const sessionEventTypes: SessionEventType[] = ['start', 'command', 'test', 'error', 'git', 'decision', 'checkpoint', 'stop'];
export const MAX_RETAINED_STRING = 2_000;
export const MAX_RETAINED_ARRAY_ITEMS = 50;
export const ROOT_FIELDS = new Set([
  // `cascade_id` is Windsurf's third identity fallback and was read by its profile while this
  // list dropped it -- harmless only for as long as Windsurf also sends one of the first two.
  'session_id', 'sessionId', 'thread_id', 'turn_id', 'turnId', 'conversation_id', 'cascade_id', 'generation_id',
  'cwd', 'workspace_roots',
  'title', 'query', 'agent', 'type', 'status', 'summary', 'command', 'exit_code', 'exitCode', 'passed',
  'message', 'code', 'text', 'changedPaths', 'changed_paths', 'commit', 'file_path', 'filePath', 'path', 'notebook_path',
  'tool_name', 'toolName', 'error', 'error_code', 'error_message', 'tool_input', 'toolInput', 'tool_response', 'toolResponse',
  // Claude subagent identity: without these the agent-scoped binding degrades to the
  // shared main-thread row and SubagentStart/Stop cannot resolve an agent at all.
  'agent_id', 'agentId', 'agent_type', 'agentType',
  // The turn's ask and the turn's answer, for the fleet's one-line "what is this session on".
  // `prompt` was already read by the correction-signal classifier in `host-hook.ts`, which
  // could never fire in production because this list dropped the field before it arrived --
  // a hook that computes from a field it never receives passes every test that bypasses stdin.
  // Neither reaches `payload`; see `errorText` / `assistantMessage` on NormalizedHostHook.
  'prompt', 'last_assistant_message',
  // Antigravity's payload is protojson: every key camelCase, the session under
  // `conversationId`, the root under `workspacePaths`, and the tool nested in `toolCall`
  // rather than split across `tool_name`/`tool_input`. This list is an allowlist, so before
  // these three lines every Antigravity hook arrived with no session id and no root and threw
  // `IncompleteHostHookPayloadError` -- which the entry swallows in silence, so the host looked
  // exactly like one nobody had configured. `normalizePayload` restates them downstream.
  'conversationId', 'workspacePaths', 'toolCall',
]);
/**
 * Keys whose LAST characters matter more than their first.
 *
 * Every retained string keeps its head, which is right for a prompt or a path and wrong for
 * command output: a failing test run prints its banner first and its failure last, so the
 * head of `stdout` is the list of files that passed. These keep the tail instead, at the same
 * bound, so the line that names the failure survives.
 */
export const TAIL_FIELDS = new Set(['error', 'stdout', 'stderr']);
// Knowl write-tool arguments are retained so a new commit can be recognised as the
// caller's own work. They are compared in memory and never persisted: only summary,
// command, and changedPaths reach the stored event payload.
export const KNOWL_WRITE_ARGS = ['title', 'id', 'supersedeId', 'supersedes', 'atoms'];
// What tells one call of a search tool from the next. Without these, every Grep in a
// session normalises to the same event -- the payload keeps only `summary: "Grep
// completed"` -- so two searches inside the debounce window counted as one and the
// second was dropped unprocessed, taking its change card with it. Short strings, bounded
// by MAX_RETAINED_STRING like every other retained field, and compared in memory only.
export const TOOL_DISCRIMINATORS = ['pattern', 'glob', 'query', 'url'];
export const NESTED_FIELDS: Record<string, Set<string>> = {
  tool_input: new Set(['command', 'changedPaths', 'changed_paths', 'file_path', 'filePath', 'path', 'notebook_path', ...TOOL_DISCRIMINATORS, ...KNOWL_WRITE_ARGS]),
  toolInput: new Set(['command', 'changedPaths', 'changed_paths', 'file_path', 'filePath', 'path', 'notebook_path', ...TOOL_DISCRIMINATORS, ...KNOWL_WRITE_ARGS]),
  // `stdout`/`stderr` are kept here, tail-bounded, for the fleet's error signature and never
  // persisted: `appendMemorySessionEvent` strips both keys, and the fleet reduces them to one
  // line before it writes anything.
  tool_response: new Set(['exit_code', 'exitCode', 'stdout', 'stderr']),
  toolResponse: new Set(['exit_code', 'exitCode', 'stdout', 'stderr']),
  error: new Set(['code', 'type', 'message', 'error']),
  toolCall: new Set(['name', 'args']),
};
// Fields kept inside an allowlisted array of objects, e.g. tool_input.atoms[i].
// Without this, allowing `atoms` above would retain whole atom bodies; only the
// title is needed to recognise a commit as the caller's own.
export const NESTED_ARRAY_ITEM_FIELDS: Record<string, Set<string>> = {
  atoms: new Set(['title']),
};
export const ARRAY_FIELDS = new Set(['workspace_roots', 'workspacePaths', 'changedPaths', 'changed_paths', 'file_paths', 'filePaths']);
/**
 * The `toolCall.args` leaves Antigravity's normalizer reads, and nothing else.
 *
 * Named individually rather than allowed wholesale, because the sibling keys are the file's new
 * contents (`CodeContent`, `ReplacementContent`, `ReplacementChunks`). Every other host's tool
 * arguments are allowlisted down to the fields that are actually read; letting one host's
 * arguments through by their parent would put whole file bodies in this process for no reader.
 */
export const TOOL_CALL_ARG_FIELDS = new Set(['TargetFile', 'AbsolutePath', 'CommandLine', 'Query']);

export type LifecyclePayload = Record<string, unknown>;

function boundString(key: string, val: string): string {
  if (TAIL_FIELDS.has(key)) {
    return val.length > MAX_RETAINED_STRING ? val.slice(-MAX_RETAINED_STRING) : val;
  }
  return val.length > MAX_RETAINED_STRING ? val.slice(0, MAX_RETAINED_STRING) : val;
}

export function readLifecyclePayloadObject(raw: unknown): LifecyclePayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const source = raw as Record<string, unknown>;
  const payload: LifecyclePayload = {};

  for (const [key, value] of Object.entries(source)) {
    if (!ROOT_FIELDS.has(key)) continue;

    if (typeof value === 'string') {
      payload[key] = boundString(key, value);
    } else if (Array.isArray(value)) {
      if (!ARRAY_FIELDS.has(key)) continue;
      payload[key] = value.slice(0, MAX_RETAINED_ARRAY_ITEMS).map((item) => {
        if (typeof item === 'string') return boundString(key, item);
        return item;
      });
    } else if (value !== null && typeof value === 'object') {
      const allowedNested = NESTED_FIELDS[key];
      if (!allowedNested) continue;

      const nestedSource = value as Record<string, unknown>;
      const nestedResult: Record<string, unknown> = {};

      for (const [nestedKey, nestedValue] of Object.entries(nestedSource)) {
        if (!allowedNested.has(nestedKey)) continue;

        if (key === 'toolCall' && nestedKey === 'args') {
          if (nestedValue !== null && typeof nestedValue === 'object' && !Array.isArray(nestedValue)) {
            const argsObj = nestedValue as Record<string, unknown>;
            const filteredArgs: Record<string, unknown> = {};
            for (const [argKey, argValue] of Object.entries(argsObj)) {
              if (TOOL_CALL_ARG_FIELDS.has(argKey)) {
                filteredArgs[argKey] = typeof argValue === 'string' ? boundString(argKey, argValue) : argValue;
              }
            }
            nestedResult[nestedKey] = filteredArgs;
          } else {
            nestedResult[nestedKey] = typeof nestedValue === 'string' ? boundString(nestedKey, nestedValue) : nestedValue;
          }
        } else if (Array.isArray(nestedValue)) {
          const itemFields = NESTED_ARRAY_ITEM_FIELDS[nestedKey];
          nestedResult[nestedKey] = nestedValue.slice(0, MAX_RETAINED_ARRAY_ITEMS).map((item) => {
            if (item !== null && typeof item === 'object' && !Array.isArray(item) && itemFields) {
              const itemObj = item as Record<string, unknown>;
              const filteredItem: Record<string, unknown> = {};
              for (const [itemKey, itemVal] of Object.entries(itemObj)) {
                if (itemFields.has(itemKey)) {
                  filteredItem[itemKey] = typeof itemVal === 'string' ? boundString(itemKey, itemVal) : itemVal;
                }
              }
              return filteredItem;
            }
            if (typeof item === 'string') {
              return boundString(nestedKey, item);
            }
            return item;
          });
        } else if (typeof nestedValue === 'string') {
          nestedResult[nestedKey] = boundString(nestedKey, nestedValue);
        } else {
          nestedResult[nestedKey] = nestedValue;
        }
      }
      payload[key] = nestedResult;
    } else {
      payload[key] = value;
    }
  }

  return payload;
}

export function isLifecycleCapability(value: string): value is LifecycleCapability {
  return capabilities.includes(value as LifecycleCapability);
}

export function isLifecycleEvent(value: string): value is LifecycleEvent {
  return events.includes(value as LifecycleEvent);
}

export function isSessionEventType(value: unknown): value is SessionEventType {
  return typeof value === 'string' && sessionEventTypes.includes(value as SessionEventType);
}

export function parseLifecyclePayload(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  const value = JSON.parse(raw);
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Agent lifecycle payload must be a JSON object.');
  return value as Record<string, unknown>;
}

/**
 * Drop a leading UTF-8 byte order mark from the first stdin chunk.
 *
 * The streaming JSON parser is handed raw chunks, and a BOM before the opening brace is
 * not a value, so it fails the whole hook with "expected a value" and exit 1 -- no capture,
 * no change card, for a payload that is otherwise perfectly good JSON. Hosts write clean
 * UTF-8, but a hook wrapped in a PowerShell redirect or `Out-File` on Windows does not,
 * and the resulting failure gives no hint that an invisible three-byte prefix caused it.
 */
function stripByteOrderMark(chunk: unknown): unknown {
  if (typeof chunk === 'string') {
    return chunk.charCodeAt(0) === 0xfeff ? chunk.slice(1) : chunk;
  }
  if (Buffer.isBuffer(chunk) && chunk.length >= 3
    && chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf) {
    return chunk.subarray(3);
  }
  return chunk;
}

export async function readLifecyclePayload(stdin = process.stdin): Promise<LifecyclePayload> {
  if (stdin.isTTY) return {};
  const iterator = stdin[Symbol.asyncIterator]();
  let first = await iterator.next();
  while (!first.done && String(first.value).length === 0) first = await iterator.next();
  if (first.done) return {};

  const source = Readable.from((async function* () {
    yield stripByteOrderMark(first.value);
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  })());
  const stream = chain([
    source,
    parser(),
    streamObject(),
  ]);
  const raw: Record<string, unknown> = {};
  for await (const entry of stream as AsyncIterable<{ key: string; value: unknown }>) {
    raw[entry.key] = entry.value;
  }
  return readLifecyclePayloadObject(raw);
}

export function stringPayloadValue(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}


