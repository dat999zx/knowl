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
 * OpenClaw host profile for in-process gateway execution.
 *
 * Like Cline and Hermes, OpenClaw has no hooks file: its lifecycle hooks are registered
 * in-process via `api.on(...)` through an extension plugin (`integrations/openclaw/`)
 * loaded by the gateway, rather than writing shell hook commands into user config.
 */
export const openclawProfile: HostProfile = {
  host: 'openclaw',
  hookEvents: [],
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
  midTurnContext() {
    return undefined;
  },
  denyToolCall: openclawBlock,
};
