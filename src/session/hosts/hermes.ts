import type { NormalizedHookEventName } from '../../core/host-hook-types.js';
import type { HostIdentity, HostOutput, HostProfile } from './profile.js';
import { hostString, toolNameIsShell } from './profile.js';

/**
 * Hermes' shell-hook events, mapped onto the engine's. Read from `agent/shell_hooks.py` and
 * `hermes_cli/hooks.py` in Hermes Agent v0.21.0 (2026.8.31) on 2026-09-03.
 *
 * Two events map to `turn-stop`, on purpose. `pre_verify` fires only on a turn that edited
 * code, just before the agent finishes, and it is the one Hermes event whose answer can keep
 * the turn going -- so it carries the capture nudge. `on_session_end` fires from the turn
 * finaliser on *every* turn (its payload has `turn_id` and `completed`; the name is historical)
 * and closes the turn on the ones `pre_verify` skipped. When both fire, the second finds the
 * turn binding already closed and is dropped as `event-loss`, which is the engine's existing
 * behaviour for a repeated stop. `on_session_finalize` is the real end of the session.
 */
const HERMES_EVENT_MAP: Record<string, NormalizedHookEventName> = {
  on_session_start: 'session-start',
  pre_llm_call: 'turn-start',
  pre_tool_call: 'tool-precheck',
  post_tool_call: 'session-event',
  pre_verify: 'turn-stop',
  on_session_end: 'turn-stop',
  on_session_finalize: 'session-stop',
};

/** Registered by `knowl init hermes`; `pre_llm_call` is the prompt event and is written beside them. */
export const HERMES_HOOK_EVENTS = [
  'on_session_start', 'pre_tool_call', 'post_tool_call', 'pre_verify', 'on_session_end', 'on_session_finalize',
] as const;

/**
 * Claude Code's `Stop` shape, which Hermes accepts on both of its decision events.
 *
 * `shell_hooks.py` normalises `{"decision": "block", "reason"}` on `pre_tool_call` into its own
 * `{"action": "block", "message"}` (the module calls that translation "the single most important
 * correctness invariant"), and `get_pre_verify_continue_message` reads the same pair on
 * `pre_verify` as "keep the turn going with this follow-up". One envelope, two channels. Not the
 * `hookSpecificOutput` wrapper Claude uses for its own PreToolUse verdict -- Hermes reads the
 * top-level keys only.
 */
const hermesBlock = (reason: string): HostOutput => ({ decision: 'block', reason });

/**
 * Hermes Agent, through the shell hooks in its own `config.yaml`.
 *
 * Hermes runs each `hooks.<event>[].command` as a subprocess (`shlex.split`, no shell) with a
 * Claude-Code-shaped JSON payload on stdin: `hook_event_name`, `tool_name`, `tool_input`,
 * `session_id`, `cwd`, and everything else under `extra`. Those top-level keys are the ones the
 * normaliser already reads, so this profile is Claude's dialect on the way in. `extra` never
 * reaches the engine -- the stdin allowlist keeps root fields only -- so `turn_id`, the prompt
 * text and `interrupted` are not available here.
 *
 * **Refusal**: `{"decision": "block", "reason"}` on stdout **and** exit 2, because Hermes reads
 * both (exit 2 blocks `pre_tool_call` "even when stdout carries no block JSON"). Same pair as
 * OpenHands.
 *
 * **Stop channel**: `pre_verify` accepts the same envelope and turns it into a follow-up message
 * that continues the turn, bounded by Hermes' own `max_verify_nudges`. So `stopContext` is real
 * here -- a first for a host whose plugin API had no stop hook. It fires only on turns that
 * edited code, which is exactly the turn the capture nudge is about.
 *
 * **Context**: `{"context": "..."}` on `pre_llm_call` is appended to the user message (Hermes caps
 * it at 10,000 characters). Whether `on_session_start` honours it is unverified, so the
 * session-start card is not emitted and the bootstrap rides the first `pre_llm_call`, which the
 * engine already serves for a session it has not seen. `post_tool_call` output is ignored by
 * Hermes, so there is no mid-turn envelope and the change card keeps its MCP channel.
 *
 * **`cwd` is the Hermes process's working directory**, not a per-session one (`Path.cwd()` in
 * `_serialize_payload`). From the `hermes` CLI launched in a project that is the project; from
 * the gateway or Hermes Desktop it is wherever that process started, and a hook that cannot
 * resolve a Knowl project is silently dropped -- the ordinary case for a global hook.
 *
 * **`lifecycleClaimable: false`.** Hermes asks for consent per (event, command) on first use at a
 * TTY, and a non-TTY process (gateway, Desktop) runs nothing until the allowlist or
 * `hooks_auto_accept` says so. Registered is not running; the card keeps the conditional line.
 *
 * Tool names from `tools/file_tools.py` and `tools/terminal_tool.py`: `read_file`, `write_file`,
 * `patch`, `search_files`, `terminal`; the path argument is `path`. `writeTools` rather than a
 * predicate so the `pre_tool_call` matcher -- a Python regex Hermes `fullmatch`es against the
 * tool name -- is built from the same list the gate reads.
 */
export const hermesProfile: HostProfile = {
  host: 'hermes',
  hookEvents: HERMES_HOOK_EVENTS,
  promptEvent: 'pre_llm_call',
  sharesSessionBinding: true,
  nativeOutput: true,
  midTurnDeliveryVerified: false,
  hookConfigStyle: 'hermes-yaml',
  denyExitCode: 2,
  lifecycleClaimable: false,
  writeTools: ['write_file', 'patch'],
  readsFiles: (_event, tool) => tool === 'read_file',
  identity(raw): HostIdentity {
    return { externalSessionId: hostString(raw.session_id) };
  },
  normalizedEvent(hostEvent) {
    return HERMES_EVENT_MAP[hostEvent];
  },
  isShellEvent(_hostEvent, toolName) {
    return toolNameIsShell(toolName) || toolName === 'terminal';
  },
  startContext(event, context) {
    return event === 'turn-start' ? { context } : undefined;
  },
  midTurnContext() {
    return undefined;
  },
  denyToolCall: hermesBlock,
  stopContext: hermesBlock,
};
