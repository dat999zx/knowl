import type { NormalizedHookEventName } from '../host-hook.js';
import type { HostIdentity, HostOutput, HostProfile } from './profile.js';
import { agentIdentityFrom, hostString, toolNameIsShell } from './profile.js';

/** Event names shared by hosts that implement the Anthropic-style hook schema. */
export const PASCAL_EVENT_MAP: Record<string, NormalizedHookEventName> = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'turn-start',
  PostToolUse: 'session-event',
  PostToolUseFailure: 'session-event',
  PreCompact: 'checkpoint',
  Stop: 'turn-stop',
  StopFailure: 'turn-stop',
  SubagentStart: 'agent-start',
  SubagentStop: 'agent-stop',
  SessionEnd: 'session-stop',
};

/**
 * Claude's map: the shared one plus the pre-tool event.
 *
 * Kept out of `PASCAL_EVENT_MAP` deliberately. Codex imports that map, and its own event
 * list was verified against codex 0.145.0's dispatcher enum, which carries no PreToolUse --
 * so adding it there would teach Codex to normalise an event it never registers and can
 * never answer, and the gate downstream would treat that host as gated when it is not.
 * A name a host does not implement has to keep being rejected.
 */
const CLAUDE_EVENT_MAP: Record<string, NormalizedHookEventName> = {
  ...PASCAL_EVENT_MAP,
  PreToolUse: 'tool-precheck',
};

/** `hookSpecificOutput` envelope used by Claude Code and Codex CLI. */
export function hookSpecificOutput(hookEventName: string, context: string): HostOutput {
  return { hookSpecificOutput: { hookEventName, additionalContext: context } };
}

export function startEventName(event: NormalizedHookEventName): string {
  if (event === 'session-start') return 'SessionStart';
  if (event === 'agent-start') return 'SubagentStart';
  return 'UserPromptSubmit';
}

export const CLAUDE_HOOK_EVENTS = [
  'SessionStart', 'SubagentStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PreCompact', 'Stop', 'StopFailure', 'SubagentStop', 'SessionEnd',
] as const;

export const claudeProfile: HostProfile = {
  host: 'claude',
  hookEvents: CLAUDE_HOOK_EVENTS,
  promptEvent: 'UserPromptSubmit',
  sharesSessionBinding: true,
  nativeOutput: true,
  midTurnDeliveryVerified: true,
  identity(raw): HostIdentity {
    return {
      externalSessionId: hostString(raw.session_id) ?? hostString(raw.conversation_id) ?? hostString(raw.thread_id),
      externalTurnId: hostString(raw.turn_id) ?? hostString(raw.generation_id),
      ...agentIdentityFrom(raw),
    };
  },
  normalizedEvent(hostEvent) {
    return CLAUDE_EVENT_MAP[hostEvent];
  },
  isShellEvent(_hostEvent, toolName) {
    return toolNameIsShell(toolName);
  },
  startContext(event, context) {
    return hookSpecificOutput(startEventName(event), context);
  },
  midTurnContext(text) {
    return hookSpecificOutput('PostToolUse', text);
  },
  // Claude Code's documented refusal: it reads the decision, blocks the tool call, and shows
  // the model `permissionDecisionReason`. Deliberately not the `additionalContext` envelope
  // above -- that one is advice attached to a call that already ran, and reusing it here
  // would let the write through while the reason explains why it was stopped.
  //
  // The reason is passed through whole. Every other host string in this file is truncated at
  // MAX_HOST_STRING, but this one is the recovery instruction itself: cutting it mid-sentence
  // leaves the agent blocked and not told what to do about it, which is the one failure a
  // gate cannot survive.
  denyToolCall(reason) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    };
  },
};
