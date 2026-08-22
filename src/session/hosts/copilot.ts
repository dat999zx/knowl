import type { NormalizedHookEventName } from '../../core/host-hook-types.js';
import type { HostIdentity, HostProfile } from './profile.js';
import { agentIdentityFrom, hostString, toolNameIsShell } from './profile.js';
import { anthropicStopContext, hookSpecificOutput } from './claude.js';

/**
 * GitHub Copilot's events, in the casing its reference documents as canonical.
 *
 * Verified against docs.github.com/en/copilot/reference/hooks-reference on 2026-08-22, because
 * the first version of this file guessed and got two wrong: it registered `stop` and
 * `userPromptSubmit`, and the canonical names are `agentStop` and `userPromptSubmitted`. Both
 * were handlers under keys GitHub never fires -- the same dead-entry failure this release
 * removes from Codex, introduced in the commit that removed it.
 *
 * The PascalCase set is a *different list*, not a casing of this one, so the two cannot be
 * derived from each other.
 */
const COPILOT_EVENT_MAP: Record<string, NormalizedHookEventName> = {
  sessionStart: 'session-start',
  userPromptSubmitted: 'turn-start',
  preToolUse: 'tool-precheck',
  postToolUse: 'session-event',
  postToolUseFailure: 'session-event',
  subagentStart: 'agent-start',
  subagentStop: 'agent-stop',
  preCompact: 'checkpoint',
  agentStop: 'turn-stop',
  sessionEnd: 'session-stop',
};

export const COPILOT_HOOK_EVENTS = [
  'sessionStart', 'subagentStart', 'preToolUse', 'postToolUse', 'postToolUseFailure',
  'preCompact', 'agentStop', 'subagentStop', 'sessionEnd',
] as const;

/**
 * GitHub Copilot (CLI, and the cloud coding agent) reuses Claude Code's hook payloads.
 *
 * The verdict envelopes are delegations rather than copies, so if the two routes ever diverge
 * they diverge in one place. What is *not* shared is the failure direction, and that is the
 * whole reason this profile needs two fields nothing else sets.
 *
 * **Copilot fails closed**, which is why `refusesOnAnyNonZeroExit` exists -- see that field.
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
  promptEvent: 'userPromptSubmitted',
  sharesSessionBinding: true,
  nativeOutput: true,
  midTurnDeliveryVerified: false,
  hookConfigStyle: 'claude-nested',
  // Copilot rejects a hooks file without it.
  hookFileExtraKeys: { version: 1 },
  // Copilot's editing tools, not Claude's. Without these the impact subsystem recognises
  // neither reads nor writes here, and the deny channel below is unreachable.
  //
  // These names are the weakest assertion in this file: unlike the events and the verdict
  // shape they are not quoted from the hooks reference, which documents the hook payload and
  // not the agent's tool vocabulary. A wrong name costs detection on this host and nothing
  // else -- the gate degrades to "no opinion", which is its designed failure direction.
  // `str_replace_editor` reads *and* writes, discriminated by an argument this layer does not
  // see, and it appears in the write list only -- deliberately, and matching `openhands.ts`,
  // which faces the identical dual tool. `runToolEventImpact` tests reads first, so listing it
  // in both made every Copilot edit record as a read: no re-index, no detection, and a
  // read-set belief the session does not hold. A false write costs a detection pass; a false
  // read manufactures a finding against nobody.
  readsFiles: (_event, tool) => ['view', 'read'].includes(tool),
  writesFiles: (_event, tool) => ['create', 'str_replace', 'str_replace_editor', 'edit', 'write'].includes(tool),
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
  // The same `hookSpecificOutput` shape as Claude's, in Copilot's own casing -- and the name
  // has to match the event that fired, because output stamped with a different `hookEventName`
  // is discarded. This is `startEventName` for Copilot's vocabulary; writing it as a two-way
  // ternary dropped the subagent card the moment `subagentStart` was registered, by answering
  // it with the prompt event's name.
  startContext(event, context) {
    const name = event === 'session-start' ? 'sessionStart'
      : event === 'agent-start' ? 'subagentStart'
        : 'userPromptSubmitted';
    return hookSpecificOutput(name, context);
  },
  midTurnContext(text) {
    return hookSpecificOutput('postToolUse', text);
  },
  // **Flat, not `hookSpecificOutput`.** Copilot's reference puts `permissionDecision` at the
  // top level; Claude Code nests it. Reusing the shared Anthropic builder here emitted a field
  // Copilot does not read, so the refusal arrived through `denyExitCode` alone -- blocking the
  // write with no reason attached, which is the one failure `denyToolCall`'s contract says a
  // gate cannot survive.
  denyToolCall(reason) {
    return { permissionDecision: 'deny', permissionDecisionReason: reason };
  },
  stopContext: anthropicStopContext,
};
