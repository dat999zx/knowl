import type { NormalizedHookEventName } from '../../core/host-hook-types.js';
import type { HostIdentity, HostProfile } from './profile.js';
import { agentIdentityFrom, hostString, toolNameIsShell } from './profile.js';
import { anthropicDenyToolCall, anthropicStopContext, hookSpecificOutput } from './claude.js';

/**
 * GitHub Copilot's events, in the casing its reference documents as canonical.
 *
 * PascalCase aliases exist "for VS Code compatibility", but they are aliases and the list of
 * them is not the same list -- `SubagentStart` has no camelCase original, so registering it
 * would repeat exactly the mistake this release removes from Codex: a handler for an event the
 * host has never fired. Only names the reference lists are here.
 */
const COPILOT_EVENT_MAP: Record<string, NormalizedHookEventName> = {
  sessionStart: 'session-start',
  userPromptSubmit: 'turn-start',
  preToolUse: 'tool-precheck',
  postToolUse: 'session-event',
  stop: 'turn-stop',
  sessionEnd: 'session-stop',
};

export const COPILOT_HOOK_EVENTS = [
  'sessionStart', 'preToolUse', 'postToolUse', 'stop', 'sessionEnd',
] as const;

/**
 * GitHub Copilot (CLI, and the cloud coding agent) reuses Claude Code's hook payloads.
 *
 * The verdict envelopes are delegations rather than copies, so if the two routes ever diverge
 * they diverge in one place. What is *not* shared is the failure direction, and that is the
 * whole reason this profile needs two fields nothing else sets.
 *
 * **Copilot fails closed.** Its reference states that a non-zero exit other than 2 denies the
 * tool call. Every other host in this directory treats a crashed hook as "no opinion" and lets
 * the write through; here a Knowl bug would block somebody's edit with no reason attached and
 * nothing on screen connecting the two. `refusesOnAnyNonZeroExit` is read by the hook entry to
 * withhold its own error status for exactly this host -- see `src/cli/agent-hook.ts`.
 *
 * **`midTurnDeliveryVerified` stays false.** GitHub's reference asserts that `additionalContext`
 * from `postToolUse` is appended to `textResultForLlm` so the model sees it, which is a stronger
 * claim than any other unverified host has going for it -- and it is still a vendor statement
 * about a schema rather than an observed run, which is the bar this flag documents. Until
 * someone watches a Copilot session receive one, Copilot is notified over the MCP tool-result
 * channel, which is correct rather than degraded. Flipping it is a one-line change.
 *
 * **VS Code is deliberately not claimed.** The hooks reference covers the CLI and the cloud
 * coding agent; the PascalCase aliases describe a naming convention, not a second supported
 * surface. If the VS Code agent turns out to read the same file, nothing here needs to change.
 */
export const copilotProfile: HostProfile = {
  host: 'copilot',
  hookEvents: COPILOT_HOOK_EVENTS,
  promptEvent: 'userPromptSubmit',
  sharesSessionBinding: true,
  nativeOutput: true,
  midTurnDeliveryVerified: false,
  hookConfigStyle: 'copilot-nested',
  denyExitCode: 2,
  refusesOnAnyNonZeroExit: true,
  identity(raw): HostIdentity {
    return {
      externalSessionId: hostString(raw.session_id) ?? hostString(raw.sessionId) ?? hostString(raw.conversation_id),
      externalTurnId: hostString(raw.turn_id) ?? hostString(raw.turnId),
      ...agentIdentityFrom(raw),
    };
  },
  normalizedEvent(hostEvent) {
    return COPILOT_EVENT_MAP[hostEvent];
  },
  isShellEvent(_hostEvent, toolName) {
    return toolNameIsShell(toolName);
  },
  startContext(_event, context) {
    // Copilot's start and prompt events take the same `hookSpecificOutput` shape as Claude's,
    // but name the event in its own casing.
    return hookSpecificOutput('sessionStart', context);
  },
  midTurnContext(text) {
    return hookSpecificOutput('postToolUse', text);
  },
  denyToolCall: anthropicDenyToolCall,
  stopContext: anthropicStopContext,
};
