import { Readable, Transform } from 'node:stream';
import chain from 'stream-chain';
import { ignore } from 'stream-json/filters/ignore.js';
import { parser } from 'stream-json';
import { streamObject } from 'stream-json/streamers/stream-object.js';
import { SessionEventType } from '../../core/types.js';
import { LifecycleCapability, LifecycleEvent } from './types.js';

const capabilities: LifecycleCapability[] = ['supported', 'unsupported', 'degraded'];
const events: LifecycleEvent[] = ['session-start', 'session-event', 'session-stop', 'session-recover'];
const sessionEventTypes: SessionEventType[] = ['start', 'command', 'test', 'error', 'git', 'decision', 'checkpoint', 'stop'];
const MAX_RETAINED_STRING = 2_000;
const MAX_RETAINED_ARRAY_ITEMS = 50;
const ROOT_FIELDS = new Set([
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
const TAIL_FIELDS = new Set(['error', 'stdout', 'stderr']);
// Knowl write-tool arguments are retained so a new commit can be recognised as the
// caller's own work. They are compared in memory and never persisted: only summary,
// command, and changedPaths reach the stored event payload.
const KNOWL_WRITE_ARGS = ['title', 'id', 'supersedeId', 'supersedes', 'atoms'];
// What tells one call of a search tool from the next. Without these, every Grep in a
// session normalises to the same event -- the payload keeps only `summary: "Grep
// completed"` -- so two searches inside the debounce window counted as one and the
// second was dropped unprocessed, taking its change card with it. Short strings, bounded
// by MAX_RETAINED_STRING like every other retained field, and compared in memory only.
const TOOL_DISCRIMINATORS = ['pattern', 'glob', 'query', 'url'];
const NESTED_FIELDS: Record<string, Set<string>> = {
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
const NESTED_ARRAY_ITEM_FIELDS: Record<string, Set<string>> = {
  atoms: new Set(['title']),
};
const ARRAY_FIELDS = new Set(['workspace_roots', 'workspacePaths', 'changedPaths', 'changed_paths', 'file_paths', 'filePaths']);
/**
 * The `toolCall.args` leaves Antigravity's normalizer reads, and nothing else.
 *
 * Named individually rather than allowed wholesale, because the sibling keys are the file's new
 * contents (`CodeContent`, `ReplacementContent`, `ReplacementChunks`). Every other host's tool
 * arguments are allowlisted down to the fields that are actually read; letting one host's
 * arguments through by their parent would put whole file bodies in this process for no reader.
 */
const TOOL_CALL_ARG_FIELDS = new Set(['TargetFile', 'AbsolutePath', 'CommandLine', 'Query']);

function shouldDiscardPath(stack: Array<string | number | null>): boolean {
  if (stack.length === 0) return false;
  if (stack.length === 1) return !ROOT_FIELDS.has(String(stack[0]));
  if (typeof stack.at(-1) === 'number') {
    const index = Number(stack.at(-1));
    if (stack.length === 2) return !ARRAY_FIELDS.has(String(stack[0])) || index >= MAX_RETAINED_ARRAY_ITEMS;
    if (stack.length === 3) return !NESTED_FIELDS[String(stack[0])]?.has(String(stack[1])) || index >= MAX_RETAINED_ARRAY_ITEMS;
    return true;
  }
  const parent = String(stack[0]);
  if (stack.length >= 4 && typeof stack[2] === 'number') {
    // A field of an object inside an allowlisted array. Nothing deeper is ever kept.
    return stack.length > 4 || !NESTED_ARRAY_ITEM_FIELDS[String(stack[1])]?.has(String(stack[3]));
  }
  // `toolCall.args` is the one allowlisted pair with a third level worth keeping, and the one
  // whose siblings are file contents. Everything under it is named or dropped.
  if (parent === 'toolCall' && stack.length > 2) {
    return stack.length > 3 || stack[1] !== 'args' || !TOOL_CALL_ARG_FIELDS.has(String(stack[2]));
  }
  if (NESTED_FIELDS[parent]) return !NESTED_FIELDS[parent].has(String(stack[1]));
  return true;
}

function retainOnlyBoundedStrings() {
  let chunks: string[] | undefined;
  // The key the next string value belongs to. Keys arrive packed (`packKeys: true`) as one
  // `keyValue` token ahead of their value, so this is exact rather than inferred.
  let currentKey: string | undefined;
  let keepTail = false;
  return new Transform({
    objectMode: true,
    transform(token, _encoding, callback) {
      if (token.name === 'keyValue') currentKey = String(token.value);
      if (token.name === 'startString') {
        chunks = [];
        keepTail = currentKey !== undefined && TAIL_FIELDS.has(currentKey);
        callback();
        return;
      }
      if (chunks) {
        if (token.name === 'stringChunk') {
          if (keepTail) {
            // Rolling window: never hold more than twice the bound, never lose the end.
            chunks.push(String(token.value));
            const joined = chunks.join('');
            if (joined.length > 2 * MAX_RETAINED_STRING) chunks = [joined.slice(-MAX_RETAINED_STRING)];
          } else {
            const retained = chunks.join('').length;
            if (retained < MAX_RETAINED_STRING) chunks.push(String(token.value).slice(0, MAX_RETAINED_STRING - retained));
          }
          callback();
          return;
        }
        if (token.name === 'endString') {
          const joined = chunks.join('');
          const value = keepTail ? joined.slice(-MAX_RETAINED_STRING) : joined.slice(0, MAX_RETAINED_STRING);
          chunks = undefined;
          callback(null, { name: 'stringValue', value });
          return;
        }
        chunks = undefined;
      }
      callback(null, token);
    },
  });
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

export async function readLifecyclePayload(stdin = process.stdin): Promise<Record<string, unknown>> {
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
    parser({ packStrings: false, packKeys: true }),
    ignore({ filter: shouldDiscardPath, streamKeys: false }),
    retainOnlyBoundedStrings(),
    streamObject(),
  ]);
  const payload: Record<string, unknown> = {};
  for await (const entry of stream as AsyncIterable<{ key: string; value: unknown }>) {
    payload[entry.key] = entry.value;
  }
  return payload;
}

export function stringPayloadValue(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}


