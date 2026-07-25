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
  'SessionStart', 'SubagentStart', 'PostToolUse', 'PostToolUseFailure',
  'PreCompact', 'Stop', 'StopFailure', 'SubagentStop', 'SessionEnd',
] as const;

export const claudeProfile: HostProfile = {
  host: 'claude',
  hookEvents: CLAUDE_HOOK_EVENTS,
  promptEvent: 'UserPromptSubmit',
  sharesSessionBinding: true,
  nativeOutput: true,
  identity(raw): HostIdentity {
    return {
      externalSessionId: hostString(raw.session_id) ?? hostString(raw.conversation_id) ?? hostString(raw.thread_id),
      externalTurnId: hostString(raw.turn_id) ?? hostString(raw.generation_id),
      ...agentIdentityFrom(raw),
    };
  },
  normalizedEvent(hostEvent) {
    return PASCAL_EVENT_MAP[hostEvent];
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
};
