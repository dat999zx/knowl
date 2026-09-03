import path from 'node:path';
import { Readable } from 'node:stream';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { findProjectRoot } from '../core/config.js';
import { ProjectNotFoundError } from '../core/errors.js';
import { HOOK_TOOL_NAME } from '../core/hooks-transport.js';
import { readLifecyclePayload } from './agents/lifecycle.js';
import { IncompleteHostHookPayloadError, normalizeHostHook } from './agents/host-hook.js';
import { hostProfile, isHookHost } from '../session/hosts/index.js';
import { handleHostLifecycleEvent } from '../session/host-lifecycle.js';

/**
 * The lifecycle hook, arriving as a tool call on the running MCP server instead of as a fresh
 * `knowl agent-hook` process.
 *
 * It lives beside `agent-hook.ts` rather than under `session/` because it is that module's
 * sibling and needs the same two things it does -- the stdin allowlist and the host-hook
 * normaliser, both `cli/agents` -- which `session/` may not import (see
 * `tests/architecture/module-boundaries.test.ts`). The MCP server reaches it through a dynamic
 * import, which that test reads as a deferral rather than a static edge: the module is loaded
 * on the first hook that arrives, and never in a server whose repo left the transport at
 * `command`.
 *
 * This is `runAgentHook` with the process boundary removed: the same normaliser, the same
 * handler, the same output, on a database that is already open in a process that is already
 * warm. What differs is how the payload arrives and where the answer goes, and both of those
 * are this module's whole job.
 *
 * **The payload arrives as tool arguments, not stdin.** The hooks file names each field as a
 * `${path}` template (`hook-config.ts`, `mcpHookInput`), and the host fills in what it has. A
 * template it could not fill may come back as the literal `${...}`, as an empty string, or not
 * at all; an object-valued path may come back as the object, as its JSON, or as the text an
 * object renders to. `hookPayloadFromArguments` folds every one of those into the shape the
 * stdin path produces, and then the payload goes through `readLifecyclePayload` itself -- the
 * same allowlist and the same string bounds -- so nothing reaches the handler by this route that
 * would have been dropped by the other.
 *
 * **The answer goes back as text content.** Both hosts read a tool's text the way they read a
 * command hook's stdout: JSON is parsed as the hook's verdict, anything else is plain text. So a
 * `PreToolUse` refusal, a `Stop` block and a mid-turn `additionalContext` all travel exactly as
 * they did, serialised into one text block. There is no exit code to get wrong.
 *
 * **Silence is a result, not a failure.** An event for a directory that is not this project, an
 * incomplete payload, and the hook's own tool call are all answered with empty content, which
 * the host reads as "nothing to say". They are the ordinary cases the process path is quiet about
 * for the same reasons (see `runAgentHook`), and a hook that reported them would be a channel
 * nobody reads when something is actually wrong.
 */

const TEMPLATE = /^\$\{[^}]*\}$/;

/** A template the host left unfilled, or the text an object becomes when rendered into a string. */
function unresolved(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  return typeof value === 'string' && (TEMPLATE.test(value) || value === '[object Object]');
}

/** An object that arrived as itself, or as its JSON. Anything else is not an object. */
function objectArgument(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string' && value.startsWith('{')) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Text that merely begins with a brace.
    }
  }
  return undefined;
}

/** The two objects the hooks file forwards both whole and by leaf. */
const OBJECT_FIELDS = ['tool_input', 'tool_response'] as const;

/**
 * The raw hook payload the command path would have read from stdin, rebuilt from tool arguments.
 *
 * Exported for its tests: the three arrival shapes above are what the host decides, and the
 * only place to pin that every one of them yields the same payload is here.
 */
export function hookPayloadFromArguments(args: Record<string, unknown>): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === 'host' || key === 'event' || key.includes('__') || unresolved(value)) continue;
    raw[key] = value;
  }
  for (const parent of OBJECT_FIELDS) {
    const leaves: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (!key.startsWith(`${parent}__`) || unresolved(value)) continue;
      leaves[key.slice(parent.length + 2)] = value;
    }
    // The whole object wins where both resolved: it is the host's own copy, and a leaf is only
    // ever a subset of it.
    const merged = { ...leaves, ...(objectArgument(args[parent]) ?? {}) };
    if (Object.keys(merged).length > 0) raw[parent] = merged;
    else delete raw[parent];
  }
  // A number that came through a template arrives as its digits. The normaliser reads
  // `exit_code` as a number and would otherwise report every command as having exited 0.
  const response = raw.tool_response as Record<string, unknown> | undefined;
  if (response && typeof response.exit_code === 'string' && /^-?\d+$/.test(response.exit_code)) {
    response.exit_code = Number(response.exit_code);
  }
  return raw;
}

const SILENT: CallToolResult = { content: [] };

export async function runHookOverMcp(
  args: Record<string, unknown>,
  context: { projectId: string | null; projectRoot: string | null },
): Promise<CallToolResult> {
  const host = typeof args.host === 'string' ? args.host : '';
  const event = typeof args.event === 'string' ? args.event : '';
  if (!isHookHost(host) || !event || !context.projectId || !context.projectRoot) return SILENT;
  try {
    // Through the stdin reader on purpose: it is the allowlist, and a second copy of it here
    // would be a second answer to what a hook may carry.
    const payload = await readLifecyclePayload(
      Readable.from([JSON.stringify(hookPayloadFromArguments(args))]) as unknown as typeof process.stdin,
    );
    // The host may fire a tool event for this very call. Recording it would file one session
    // event per hook, each describing the hook that filed it.
    if (typeof payload.tool_name === 'string' && payload.tool_name.endsWith(HOOK_TOOL_NAME)) return SILENT;

    const normalized = normalizeHostHook(host, event, payload);
    // The server serves one project. A hook fired from a directory that resolves elsewhere --
    // the agent `cd`-ed into a sibling checkout -- belongs to that project's store, which this
    // process cannot open; the command transport would have served it, this one stays quiet.
    const root = await findProjectRoot(normalized.projectRoot);
    if (path.resolve(root) !== path.resolve(context.projectRoot)) return SILENT;
    normalized.projectRoot = context.projectRoot;

    const result = await handleHostLifecycleEvent(context.projectId, normalized);

    // Same gate and same `embed: false` as the process path, for parity rather than principle:
    // in this process the model may already be warm, and the lexical pass is what the catch-up
    // needs. Widening it is a separate measurement.
    if (normalized.event === 'turn-stop' || normalized.event === 'session-stop') {
      const { catchUpTranscripts } = await import('../transcripts/catch-up.js');
      await catchUpTranscripts(context.projectRoot, { embed: false }).catch(() => undefined);
    }

    const output = result.hostOutput ?? (hostProfile(host).nativeOutput ? undefined : result);
    return output ? { content: [{ type: 'text', text: JSON.stringify(output) }] } : SILENT;
  } catch (error) {
    if (error instanceof IncompleteHostHookPayloadError || error instanceof ProjectNotFoundError) return SILENT;
    // A non-blocking error on both hosts: the tool runs, the stop proceeds, and the message is
    // in the host's log -- the same place the process path's stderr went.
    return { isError: true, content: [{ type: 'text', text: `Error handling agent hook: ${(error as Error).message}` }] };
  }
}
