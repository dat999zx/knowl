import type { NormalizedHookEventName } from '../../core/host-hook-types.js';
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
 * The shared map plus the pre-tool event, for hosts that implement the permission route.
 *
 * This used to be Claude-only, on the grounds that codex 0.145.0's dispatcher enum carried no
 * `PreToolUse` -- true when it was written, and no longer true: codex 0.147.0's binary carries
 * `PreToolUse`, `PermissionRequest`, `permissionDecision` and `permissionDecisionReason`
 * (verified 2026-08-22 by string inspection of the shipped `codex.exe`). The rule the old
 * comment protected still stands and is what keeps this separate from `PASCAL_EVENT_MAP`: a
 * name a host does not implement has to keep being rejected, because the gate downstream reads
 * a mapping as evidence the host can answer.
 *
 * `PermissionRequest` is deliberately **not** here even though both hosts have it. It would
 * normalize to `tool-precheck` like `PreToolUse` does, and `normalizeHostHook` discards the
 * host event name at that point -- so the refusal would come back stamped
 * `hookEventName: "PreToolUse"` while answering a different event, and the write would land
 * while the caller was told it was blocked. One event per verdict, until the normalized shape
 * can carry which one it is answering.
 */
export const PASCAL_EVENT_MAP_WITH_PRETOOL: Record<string, NormalizedHookEventName> = {
  ...PASCAL_EVENT_MAP,
  PreToolUse: 'tool-precheck',
};

/**
 * Claude Code's documented refusal envelope, shared by every host that reuses the route.
 *
 * Deliberately not the `additionalContext` envelope above -- that one is advice attached to a
 * call that already ran, and reusing it here would let the write through while the reason
 * explains why it was stopped.
 *
 * The reason passes through whole. Every other host string in this file is truncated at
 * MAX_HOST_STRING, but this one is the recovery instruction itself: cutting it mid-sentence
 * leaves the agent blocked and not told what to do about it, which is the one failure a gate
 * cannot survive.
 */
export function anthropicDenyToolCall(reason: string): HostOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

/**
 * Claude Code's documented Stop shape: a top-level `decision`/`reason` pair, not the
 * `hookSpecificOutput` envelope the context helpers use.
 *
 * `block` withholds the stop and shows the model the reason, which is the only way anything
 * reaches an agent at stop time -- `SessionEnd` fires once the model is already gone. So this
 * necessarily costs a turn, and the caller treats it as expensive: it is claimed once per
 * session against `capture_outcomes.nudged` before it is ever returned, because a block keyed
 * on a condition the agent may rightly decline to clear would otherwise repeat forever.
 */
export function anthropicStopContext(reason: string): HostOutput {
  return { decision: 'block', reason };
}

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
  hookConfigStyle: 'claude-nested',
  // The same four names `IMPACT_WRITE_TOOLS` in `host-lifecycle.ts` falls back to, said here so
  // the pre-tool matcher can be built from them. Claude Code applies every file write through
  // one of these; `Bash` is deliberately absent, because the gate needs the paths a tool
  // declares and a shell command does not declare any.
  writeTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
  identity(raw): HostIdentity {
    return {
      externalSessionId: hostString(raw.session_id) ?? hostString(raw.conversation_id) ?? hostString(raw.thread_id),
      externalTurnId: hostString(raw.turn_id) ?? hostString(raw.generation_id),
      ...agentIdentityFrom(raw),
    };
  },
  normalizedEvent(hostEvent) {
    return PASCAL_EVENT_MAP_WITH_PRETOOL[hostEvent];
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
  denyToolCall: anthropicDenyToolCall,
  // The advisory half of the same event: `additionalContext` on `PreToolUse`, which this host
  // reads as context for the call that is about to run. Declared here and not on the hosts
  // whose pre-tool envelope has not been read, so nobody is handed JSON they will print.
  preToolContext: text => hookSpecificOutput('PreToolUse', text),
  stopContext: anthropicStopContext,
};
