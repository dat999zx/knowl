import type { NormalizedHookEventName } from '../../core/host-hook-types.js';
import type { HostIdentity, HostOutput, HostProfile } from './profile.js';
import { hostString, toolNameIsShell } from './profile.js';

/**
 * OpenClaw's hook events mapped onto Knowl's engine lifecycle.
 *
 * `before_prompt_build` maps to `turn-start`: OpenClaw's prompt contribution hook where
 * the fixed orientation card is injected via `prependContext`. Exactly one hook publishes
 * the card; `agent_turn_prepare` and `heartbeat_prompt_contribution` do not publish context
 * because context contributions concatenate and multiple publishers would duplicate cards.
 *
 * `before_tool_call` maps to `tool-precheck`: The only blocking hook the host blocks on.
 * Evaluates the write gate before write tools (`exec`, `apply_patch`, `spawn_agent`) and
 * answers `{ block: true, blockReason }` when refused.
 *
 * `after_tool_call` maps to `session-event`: Observational hook for recording tool execution
 * outcomes and capturing file change events.
 *
 * `before_compaction` maps to `checkpoint`: Fires before conversation history compaction.
 * Runs under a 30-second budget to ensure memory is persisted before transcript truncation.
 *
 * `session_end` and `agent_end` map to `turn-stop`: Closes the current turn binding under
 * OpenClaw's 2-second total shutdown drain budget.
 *
 * `gateway_stop` maps to `session-stop`: Full gateway shutdown closing the active session
 * and releasing cached project handles.
 *
 * `session_start` maps to `session-start`: Binds session identity and warms the project
 * handle cache in memory so subsequent write gates never suffer cold client initialization.
 *
 * **The session-start card leaves through `before_prompt_build`, not through this event.**
 * `startContext` below deliberately answers an envelope for `turn-start` alone, because
 * OpenClaw ignores what a `session_start` handler returns -- so the plugin parks the
 * host-neutral `context` this event produces and hands it to the first prompt of the session.
 * The binding created here is what makes the engine's own `turn-start` answer empty, so
 * without that hand-off the card is composed and lost and the user gets no memory at all.
 */
const OPENCLAW_EVENT_MAP: Record<string, NormalizedHookEventName> = {
  before_prompt_build: 'turn-start',
  before_tool_call: 'tool-precheck',
  after_tool_call: 'session-event',
  before_compaction: 'checkpoint',
  session_end: 'turn-stop',
  agent_end: 'turn-stop',
  gateway_stop: 'session-stop',
  session_start: 'session-start',
};

const openclawBlock = (blockReason: string): HostOutput => ({ block: true, blockReason });

/**
 * The lifecycle events the plugin registers with `api.on(...)`, beside the prompt event
 * `before_prompt_build`.
 *
 * Documentation and a runtime declaration both: `hookEvents` means "events `knowl init` writes
 * into a file", and this host has none -- the gateway loads a plugin instead. Derived from the
 * event map rather than repeated by hand, so the two cannot drift apart.
 */
export const OPENCLAW_PLUGIN_EVENTS = Object.keys(OPENCLAW_EVENT_MAP)
  .filter(event => event !== 'before_prompt_build');

/**
 * OpenClaw host profile for in-process gateway execution.
 *
 * Like Cline and Hermes, OpenClaw has no hooks file: its lifecycle hooks are registered
 * in-process via `api.on(...)` through an extension plugin (`integrations/openclaw/`)
 * loaded by the gateway, rather than writing shell hook commands into user config.
 */
export const openclawProfile: HostProfile = {
  host: 'openclaw',
  hookEvents: [],
  // The runtime channel: registered with `api.on(...)` by the gateway plugin, invisible to
  // `hookEvents` because no file is written. Without this a conformance check asking whether
  // the host has a tool event answers `false` while `after_tool_call` fires on every call.
  pluginEvents: OPENCLAW_PLUGIN_EVENTS,
  promptEvent: 'before_prompt_build',
  sharesSessionBinding: true,
  nativeOutput: true,
  midTurnDeliveryVerified: false,
  hookConfigStyle: 'none',
  lifecycleClaimable: false,
  writeTools: ['exec', 'apply_patch', 'spawn_agent'],
  identity(raw): HostIdentity {
    return {
      externalSessionId: hostString(raw.session_id) ?? hostString(raw.sessionId) ?? hostString(raw.conversationId),
      externalTurnId: hostString(raw.turn_id) ?? hostString(raw.turnId),
      agentId: hostString(raw.agent_id) ?? hostString(raw.agentId),
      agentType: hostString(raw.agent_type) ?? hostString(raw.agentType),
    };
  },
  normalizedEvent(hostEvent) {
    return OPENCLAW_EVENT_MAP[hostEvent];
  },
  isShellEvent(_hostEvent, toolName) {
    return toolNameIsShell(toolName) || toolName === 'exec';
  },
  startContext(event, context) {
    return event === 'turn-start' ? { prependContext: context } : undefined;
  },
  midTurnContext(text) {
    // A distinct key from `startContext`'s `prependContext`, because the two arrive by
    // different routes and must not be confused: the turn-start card is prepended to the
    // prompt the model is about to receive, while this one is APPENDED to a tool result the
    // model is about to read. The middleware writes it into `content` rather than `details`
    // for the reason recorded at its registration -- OpenClaw strips `details` before provider
    // replay and compaction, so a card written there is one the model never reads twice.
    return { appendContent: text };
  },
  denyToolCall: openclawBlock,
};
