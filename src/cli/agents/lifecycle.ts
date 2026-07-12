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
  'session_id', 'sessionId', 'thread_id', 'turn_id', 'turnId', 'conversation_id', 'generation_id', 'cwd', 'workspace_roots',
  'title', 'query', 'agent', 'type', 'status', 'summary', 'command', 'exit_code', 'exitCode', 'passed',
  'message', 'code', 'text', 'changedPaths', 'changed_paths', 'commit', 'file_path', 'filePath', 'path',
  'tool_name', 'toolName', 'error', 'tool_input', 'toolInput', 'tool_response', 'toolResponse',
]);
const NESTED_FIELDS: Record<string, Set<string>> = {
  tool_input: new Set(['command', 'changedPaths', 'changed_paths', 'file_path', 'filePath', 'path']),
  toolInput: new Set(['command', 'changedPaths', 'changed_paths', 'file_path', 'filePath', 'path']),
  tool_response: new Set(['exit_code', 'exitCode']),
  toolResponse: new Set(['exit_code', 'exitCode']),
};
const ARRAY_FIELDS = new Set(['workspace_roots', 'changedPaths', 'changed_paths', 'file_paths', 'filePaths']);

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
  if (NESTED_FIELDS[parent]) return !NESTED_FIELDS[parent].has(String(stack[1]));
  return true;
}

function retainOnlyBoundedStrings() {
  let chunks: string[] | undefined;
  return new Transform({
    objectMode: true,
    transform(token, _encoding, callback) {
      if (token.name === 'startString') {
        chunks = [];
        callback();
        return;
      }
      if (chunks) {
        if (token.name === 'stringChunk') {
          const retained = chunks.join('').length;
          if (retained < MAX_RETAINED_STRING) chunks.push(String(token.value).slice(0, MAX_RETAINED_STRING - retained));
          callback();
          return;
        }
        if (token.name === 'endString') {
          const value = chunks.join('').slice(0, MAX_RETAINED_STRING);
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

export async function readLifecyclePayload(stdin = process.stdin): Promise<Record<string, unknown>> {
  if (stdin.isTTY) return {};
  const iterator = stdin[Symbol.asyncIterator]();
  let first = await iterator.next();
  while (!first.done && String(first.value).length === 0) first = await iterator.next();
  if (first.done) return {};

  const source = Readable.from((async function* () {
    yield first.value;
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
