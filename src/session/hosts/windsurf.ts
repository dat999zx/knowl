import type { NormalizedHookEventName } from '../../core/host-hook-types.js';
import type { HostIdentity, HostProfile } from './profile.js';
import { agentIdentityFrom, hostString } from './profile.js';

/**
 * Windsurf names its events after the *action*, not after the tool call that performs it.
 *
 * That is worth more here than it looks: `pre_read_code` and `post_read_code` say a file was
 * read, which every other host only reveals by naming a tool and leaving the classification to
 * us (see `toolName` on `NormalizedHostHook`). The read-set the impact detector depends on is
 * exactly this distinction, told rather than inferred.
 */
const WINDSURF_EVENT_MAP: Record<string, NormalizedHookEventName> = {
  post_setup_worktree: 'session-start',
  pre_user_prompt: 'turn-start',
  pre_read_code: 'session-event',
  post_read_code: 'session-event',
  pre_write_code: 'tool-precheck',
  post_write_code: 'session-event',
  pre_run_command: 'tool-precheck',
  post_run_command: 'session-event',
  pre_mcp_tool_use: 'tool-precheck',
  post_mcp_tool_use: 'session-event',
  post_cascade_response: 'turn-stop',
  post_cascade_response_with_transcript: 'turn-stop',
};

/**
 * The registered subset.
 *
 * `pre_read_code`, `pre_mcp_tool_use` and `pre_run_command` are mapped but not registered: the
 * gate only ever refuses writes (`IMPACT_WRITE_TOOLS`), so a pre-hook on a read would fire in
 * front of every file the agent opens to answer "no opinion" -- latency on the hottest path in
 * the session, for a verdict that is decided before it is computed. `pre_write_code` is the one
 * that can say no.
 *
 * `post_cascade_response_with_transcript` is mapped but not registered either: it fires
 * *alongside* `post_cascade_response` for the same response, so registering both would close
 * the turn twice.
 */
export const WINDSURF_HOOK_EVENTS = [
  'post_setup_worktree', 'post_read_code', 'pre_write_code', 'post_write_code',
  'post_run_command', 'post_mcp_tool_use', 'post_cascade_response',
] as const;

/**
 * Windsurf, now shipping as Devin Desktop -- Cascade Hooks are the same feature under both names.
 *
 * **Exit code 2 is the entire verdict channel.** There is no JSON verdict of any kind, so
 * `denyToolCall` returns the reason for `agent-hook` to print on stderr and nothing else reads
 * the object. Only pre-hooks can block; a post-hook's exit status is ignored because the action
 * already happened.
 *
 * **There is no stop event and no session-end event**, so `stopContext` is absent -- not
 * "unverified", absent from the host. `post_cascade_response` fires *after* a response and
 * cannot withhold it, which is why it maps to `turn-stop` rather than being treated as a stop
 * channel. The capture nudge therefore cannot reach Windsurf through a hook at all.
 *
 * **No context injection is documented**, so both context helpers return undefined and this host
 * is bootstrapped and notified over MCP. stderr on exit 2 is documented as reaching Cascade, but
 * the reference frames hook output as user-facing, so it is not claimed as a model channel.
 *
 * **Not covered here: the Devin CLI's own `.devin/` hooks**, which are a different file, a
 * different schema and a separate integration target. Sharing a vendor is not sharing a wire.
 */
export const windsurfProfile: HostProfile = {
  host: 'windsurf',
  hookEvents: WINDSURF_HOOK_EVENTS,
  promptEvent: undefined,
  sharesSessionBinding: true,
  nativeOutput: true,
  midTurnDeliveryVerified: false,
  hookConfigStyle: 'flat-commands',
  denyExitCode: 2,
  identity(raw): HostIdentity {
    return {
      externalSessionId: hostString(raw.conversation_id) ?? hostString(raw.session_id) ?? hostString(raw.cascade_id),
      externalTurnId: hostString(raw.turn_id) ?? hostString(raw.generation_id),
      ...agentIdentityFrom(raw),
    };
  },
  normalizedEvent(hostEvent) {
    return WINDSURF_EVENT_MAP[hostEvent];
  },
  // Windsurf names the action, so the event *is* the classification and there is no tool name
  // to match. This is the case `readsFiles`/`writesFiles` exist for: a host that says outright
  // what happened, instead of naming a tool and leaving us to recognise it.
  readsFiles(hostEvent) {
    return hostEvent === 'post_read_code';
  },
  writesFiles(hostEvent) {
    return hostEvent === 'pre_write_code' || hostEvent === 'post_write_code';
  },
  isShellEvent(hostEvent) {
    // The event name says it, so there is no tool name to classify.
    return hostEvent === 'pre_run_command' || hostEvent === 'post_run_command';
  },
  startContext() {
    return undefined;
  },
  midTurnContext() {
    return undefined;
  },
  denyToolCall(reason) {
    return { reason };
  },
};
