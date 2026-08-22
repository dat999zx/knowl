import type { NormalizedHookEventName } from '../../core/host-hook-types.js';
import type { HostIdentity, HostProfile } from './profile.js';
import { agentIdentityFrom, hostString, toolNameIsShell } from './profile.js';

const ANTIGRAVITY_EVENT_MAP: Record<string, NormalizedHookEventName> = {
  PreToolUse: 'tool-precheck',
  PostToolUse: 'session-event',
  PreInvocation: 'session-event',
  PostInvocation: 'session-event',
  Stop: 'turn-stop',
};

/**
 * `PreInvocation` is left unregistered on purpose.
 *
 * It and `PostInvocation` bracket the same model call, so registering both records two
 * session-events for one thing. `PostInvocation` is the one kept, because it is the half that
 * knows what happened.
 */
export const ANTIGRAVITY_HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'PostInvocation', 'Stop',
] as const;

/**
 * Google Antigravity 2.0 -- PascalCase events like Claude's, and nothing else like Claude's.
 *
 * Three differences, each of which silently produces a working-looking integration that does
 * nothing:
 *
 * 1. **The file is one level deeper.** `{"<hook-name>": {"PreToolUse": [{matcher, hooks}]}}`,
 *    not `{"hooks": {...}}`. Writing Claude's shape yields a file Antigravity parses and
 *    ignores. See `mergeAntigravityHookConfig`, which owns only the `"knowl"` key.
 * 2. **The verdict is `decision`, not `permissionDecision`.** Reusing `anthropicDenyToolCall`
 *    here would emit a field Antigravity does not read, so the refusal is computed, reported,
 *    and never applied.
 * 3. **Stop continues rather than blocks**, and its reason is documented as injected as a
 *    system message into the conversation -- which is the one thing a stop channel has to do
 *    for the capture nudge to be worth spending, so `stopContext` is declared.
 *
 * **No prompt event exists**, so there is no per-turn card here, and `startContext` returns
 * undefined: context injection on Antigravity goes through `injectSteps` on the invocation
 * events, which is a different mechanism with a different payload and is not wired up. Session
 * bootstrap therefore arrives over MCP, and `midTurnDeliveryVerified` stays false to keep that
 * channel talking.
 *
 * **Replaces the Gemini CLI adapter**, which was instructions-only and whose host was
 * discontinued. Its config still lives under `~/.gemini/config/` at global scope, which is the
 * only trace of that lineage that matters here.
 */
export const antigravityProfile: HostProfile = {
  host: 'antigravity',
  hookEvents: ANTIGRAVITY_HOOK_EVENTS,
  promptEvent: undefined,
  sharesSessionBinding: true,
  nativeOutput: true,
  midTurnDeliveryVerified: false,
  hookConfigStyle: 'antigravity-nested',
  readToolNames: ['read_file', 'view_file', 'ReadFile'],
  writeToolNames: ['write_file', 'edit_file', 'replace_file_content', 'WriteFile', 'EditFile'],
  identity(raw): HostIdentity {
    return {
      externalSessionId: hostString(raw.session_id) ?? hostString(raw.conversation_id) ?? hostString(raw.thread_id),
      externalTurnId: hostString(raw.turn_id) ?? hostString(raw.generation_id),
      ...agentIdentityFrom(raw),
    };
  },
  normalizedEvent(hostEvent) {
    return ANTIGRAVITY_EVENT_MAP[hostEvent];
  },
  isShellEvent(_hostEvent, toolName) {
    return toolNameIsShell(toolName);
  },
  startContext() {
    return undefined;
  },
  midTurnContext() {
    return undefined;
  },
  denyToolCall(reason) {
    return { decision: 'deny', reason };
  },
  stopContext(reason) {
    return { decision: 'continue', reason };
  },
};
