import type { HostIdentity, HostProfile } from './profile.js';
import { agentIdentityFrom, hostString, toolNameIsShell } from './profile.js';
import { hookSpecificOutput, PASCAL_EVENT_MAP, startEventName } from './claude.js';

/**
 * Codex CLI implements the same hook schema as Claude Code, including
 * SubagentStart/SubagentStop and additionalContext on PostToolUse. Verified in
 * codex.exe 0.145.0: `hooks\src\engine\dispatcher.rs` carries the full event enum
 * alongside `additionalContext`, `additionalContextLimit`, and `hookSpecificOutput`.
 */
export const CODEX_HOOK_EVENTS = [
  'SessionStart', 'SubagentStart', 'PostToolUse', 'PostToolUseFailure',
  'PreCompact', 'Stop', 'SubagentStop',
] as const;

export const codexProfile: HostProfile = {
  host: 'codex',
  hookEvents: CODEX_HOOK_EVENTS,
  promptEvent: undefined,
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
