import type { NormalizedHookEventName } from '../../core/host-hook-types.js';
import type { HostIdentity, HostProfile } from './profile.js';
import { agentIdentityFrom, hostString, toolNameIsShell } from './profile.js';

const OPENHANDS_EVENT_MAP: Record<string, NormalizedHookEventName> = {
  session_start: 'session-start',
  user_prompt_submit: 'turn-start',
  pre_tool_use: 'tool-precheck',
  post_tool_use: 'session-event',
  stop: 'turn-stop',
  session_end: 'session-stop',
};

export const OPENHANDS_HOOK_EVENTS = [
  'session_start', 'pre_tool_use', 'post_tool_use', 'stop', 'session_end',
] as const;

/**
 * OpenHands file-based agents, which answer on both channels at once.
 *
 * A hook returns `{"decision": "deny", "reason": …}` on stdout **and** exits 2; the JSON wins
 * where they disagree. Both are declared here because a host that reads only the status still
 * blocks correctly, and a host that reads only the JSON still gets the reason -- and OpenHands
 * is the one host documented to read both.
 *
 * **`stopContext` is present, and this is the judgement call in this file.** OpenHands' `stop`
 * hook can deny, and its own documented example is `"Linting failed. Fix the issues before
 * finishing."` -- a sentence addressed to the agent, not to a human reading a log. Against
 * that, `reason` is described elsewhere as surfacing in the UI. So the envelope carries the
 * text on `additionalContext` as well, which the same reference describes as injected into the
 * agent's prompt: two documented fields, one of which is documented to reach the model, and an
 * unknown key is ignored rather than fatal. If it turns out neither reaches the agent, the cost
 * is one capture nudge per session spent on a message nobody reads, in a feature that is off by
 * default -- and the fix is deleting one member.
 *
 * **`midTurnDeliveryVerified` stays false** on the ordinary rule: the docs say `additionalContext`
 * is injected into the prompt, nobody here has watched it arrive, and until someone does the MCP
 * tool-result channel keeps talking to this host.
 *
 * **The sandbox caveat, unresolved.** OpenHands runs agents in isolated containers by default, so
 * a hook command reaches Knowl only if `knowl` is on the runtime image's PATH and `.knowl/` is on
 * a mounted volume. Local and CLI mode are unaffected. This profile is correct either way -- a
 * hook that cannot run simply never fires -- but hosted OpenHands needs image documentation that
 * does not exist yet.
 */
export const openhandsProfile: HostProfile = {
  host: 'openhands',
  hookEvents: OPENHANDS_HOOK_EVENTS,
  promptEvent: 'user_prompt_submit',
  sharesSessionBinding: true,
  nativeOutput: true,
  midTurnDeliveryVerified: false,
  hookConfigStyle: 'openhands-toplevel',
  denyExitCode: 2,
  identity(raw): HostIdentity {
    return {
      externalSessionId: hostString(raw.conversation_id) ?? hostString(raw.session_id),
      externalTurnId: hostString(raw.turn_id) ?? hostString(raw.generation_id),
      ...agentIdentityFrom(raw),
    };
  },
  normalizedEvent(hostEvent) {
    return OPENHANDS_EVENT_MAP[hostEvent];
  },
  isShellEvent(_hostEvent, toolName) {
    return toolNameIsShell(toolName) || toolName.toLocaleLowerCase() === 'terminal';
  },
  startContext(_event, context) {
    return { additionalContext: context };
  },
  midTurnContext(text) {
    return { additionalContext: text };
  },
  denyToolCall(reason) {
    return { decision: 'deny', reason };
  },
  stopContext(reason) {
    return { decision: 'deny', reason, additionalContext: reason };
  },
};
