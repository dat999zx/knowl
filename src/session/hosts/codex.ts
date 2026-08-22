import type { HostIdentity, HostProfile } from './profile.js';
import { agentIdentityFrom, hostString, toolNameIsShell } from './profile.js';
import {
  anthropicDenyToolCall, anthropicStopContext, hookSpecificOutput,
  PASCAL_EVENT_MAP_WITH_PRETOOL, startEventName,
} from './claude.js';

/**
 * Codex CLI implements the Anthropic hook schema, including the permission route.
 *
 * Verified 2026-08-22 against codex-cli **0.147.0** (`codex.exe`, win32-x64) by string
 * inspection of the shipped binary. Present: `SessionStart`, `SessionEnd`, `SubagentStart`,
 * `SubagentStop`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`,
 * `PostCompact`, `UserPromptSubmit`, `permissionDecision`, `permissionDecisionReason`,
 * `hookSpecificOutput`, `additionalContext`.
 *
 * **`PostToolUseFailure` and `StopFailure` are absent from the binary and were removed here.**
 * Both had been declared since this profile was written, so every `.codex/hooks.json` Knowl
 * ever produced carried two handlers Codex silently ignored. They stay on `claude`, which does
 * implement them. Existing files keep them until a merge strips them -- see
 * `RETIRED_HOOK_EVENTS` in `hook-config.ts`, because the merge copies unknown keys through and
 * `verify` only looks for what is missing.
 *
 * **Three events Codex has that are deliberately not registered.**
 * - `PostCompact` normalizes to `checkpoint`, the same as `PreCompact`, so registering both
 *   writes two checkpoint rows per compaction.
 * - `PermissionRequest` also normalizes to `tool-precheck`; see `PASCAL_EVENT_MAP_WITH_PRETOOL`
 *   for why answering it would stamp the refusal with the wrong event name.
 * - `UserPromptSubmit` is the `promptEvent` and must not also be a lifecycle event: the merge
 *   writes the lifecycle handler under that key and then overwrites the key with the reminder
 *   entry, so a host declaring both loses its lifecycle handler in a way re-running `knowl
 *   init` reproduces rather than repairs.
 *
 * **Two caveats that are not ours to fix.** Codex hooks are gated behind
 * `[features].codex_hooks = true` in `~/.codex/config.toml`, and they do not run on Windows at
 * all -- so the deny and stop paths here are declared from the binary's own symbols rather
 * than from an observed end-to-end run. `midTurnDeliveryVerified` stays true on the strength
 * of the earlier verification of the events that already worked.
 */
export const CODEX_HOOK_EVENTS = [
  'SessionStart', 'SubagentStart', 'PreToolUse', 'PostToolUse',
  'PreCompact', 'Stop', 'SubagentStop', 'SessionEnd',
] as const;

export const codexProfile: HostProfile = {
  host: 'codex',
  hookEvents: CODEX_HOOK_EVENTS,
  promptEvent: 'UserPromptSubmit',
  sharesSessionBinding: true,
  nativeOutput: true,
  midTurnDeliveryVerified: true,
  hookConfigStyle: 'claude-nested',
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
  stopContext: anthropicStopContext,
};
