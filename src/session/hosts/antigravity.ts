import type { NormalizedHookEventName } from '../../core/host-hook-types.js';
import type { HostIdentity, HostProfile } from './profile.js';
import { agentIdentityFrom, hostString, toolNameIsShell } from './profile.js';

const ANTIGRAVITY_EVENT_MAP: Record<string, NormalizedHookEventName> = {
  PreToolUse: 'tool-precheck',
  PostToolUse: 'session-event',
  // Antigravity has no session-start and no prompt-submit event. `PreInvocation` fires before
  // every model invocation, which is the same slot a prompt event occupies: it is where the
  // turn's context has to arrive if it is going to arrive at all.
  PreInvocation: 'turn-start',
  PostInvocation: 'session-event',
  Stop: 'turn-stop',
};

export const ANTIGRAVITY_HOOK_EVENTS = [
  'PreInvocation', 'PreToolUse', 'PostToolUse', 'PostInvocation', 'Stop',
] as const;

/**
 * Antigravity's context channel: steps spliced into the conversation trajectory.
 *
 * `ephemeralMessage` is the transient variant -- the other two are `userMessage`, which would
 * put words in the person's mouth, and `toolCall`, which would have Knowl execute something on
 * the agent's behalf. Neither is what a memory card is.
 *
 * Only `PreInvocation` and `PostInvocation` read this field. It is still returned for the
 * post-tool card, where Antigravity ignores it -- an unknown key costs nothing, and
 * `midTurnDeliveryVerified` stays false so the MCP channel keeps talking either way.
 */
const injectEphemeral = (text: string) => ({ injectSteps: [{ ephemeralMessage: text }] });

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
 * **There is no prompt-submit event and no session-start event**, which read at first as "no
 * context channel". Antigravity has one, shaped unlike anyone else's: `injectSteps` on the
 * invocation events splices steps into the conversation trajectory, and `PreInvocation` fires
 * before every model invocation -- the same slot a prompt event occupies. So bootstrap and the
 * per-turn card both ride `PreInvocation` here, rather than the host having neither.
 *
 * `midTurnDeliveryVerified` stays false regardless: nobody has watched one arrive, and the MCP
 * channel keeps talking until someone does.
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
  lifecycleClaimable: false,
  midTurnDeliveryVerified: false,
  hookConfigStyle: 'antigravity-nested',
  // Not quoted from a reference -- Antigravity documents its hook payload, not its agent's tool
  // vocabulary. A wrong name costs detection here and nothing else: the gate degrades to "no
  // opinion", which is its designed failure direction.
  readsFiles: (_event, tool) => ['read_file', 'view_file', 'ReadFile'].includes(tool),
  writesFiles: (_event, tool) =>
    ['write_file', 'edit_file', 'replace_file_content', 'WriteFile', 'EditFile'].includes(tool),
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
  startContext(_event, context) {
    return injectEphemeral(context);
  },
  midTurnContext(text) {
    return injectEphemeral(text);
  },
  denyToolCall(reason) {
    return { decision: 'deny', reason };
  },
  stopContext(reason) {
    return { decision: 'continue', reason };
  },
};
