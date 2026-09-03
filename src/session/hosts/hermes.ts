import type { NormalizedHookEventName } from '../../core/host-hook-types.js';
import type { HostIdentity, HostProfile } from './profile.js';
import { hostString, toolNameIsShell } from './profile.js';

/** The events `integrations/hermes/knowl/__init__.py` sends. No `turn-stop`: see below. */
export const HERMES_EVENTS: NormalizedHookEventName[] = [
  'session-start', 'turn-start', 'tool-precheck', 'session-event', 'session-stop',
];

/**
 * Hermes Agent, whose lifecycle arrives through a Python plugin in `~/.hermes/plugins/knowl`.
 *
 * Hermes plugin hooks (developer guide, 2026-09-03): `on_session_start`, `pre_llm_call`
 * (returns context appended to the user message), `pre_tool_call` (returns
 * `{"action": "block", "message"}` to veto), `post_tool_call`, `on_session_end`. There is **no
 * hook between the model's last step and the end of the turn**, so `stopContext` is absent and
 * the capture nudge rides the MCP tool-result channel, exactly as for MCP-only hosts. Present
 * it would be a claim about a channel the host does not have.
 *
 * `nativeOutput: false`: the plugin reads `context` and `denied` off the host-neutral result.
 * `{denied}` is the plugin contract for the refusal, turned into Hermes' block directive there.
 *
 * Tool names from `tools/file_tools.py` and `tools/terminal_tool.py` in NousResearch/hermes-agent:
 * `read_file`, `write_file`, `patch`, `search_files`, `terminal`; the path argument is `path`.
 */
export const hermesProfile: HostProfile = {
  host: 'hermes',
  hookEvents: [],
  promptEvent: undefined,
  sharesSessionBinding: true,
  nativeOutput: false,
  midTurnDeliveryVerified: false,
  hookConfigStyle: 'none',
  lifecycleClaimable: false,
  identity(raw): HostIdentity {
    return {
      externalSessionId: hostString(raw.session_id),
      externalTurnId: hostString(raw.turn_id),
    };
  },
  normalizedEvent(hostEvent) {
    return HERMES_EVENTS.includes(hostEvent as NormalizedHookEventName)
      ? hostEvent as NormalizedHookEventName
      : undefined;
  },
  isShellEvent(_hostEvent, toolName) {
    return toolNameIsShell(toolName) || toolName === 'terminal';
  },
  startContext() {
    return undefined;
  },
  midTurnContext() {
    return undefined;
  },
  denyToolCall: reason => ({ denied: reason }),
  readsFiles: (_event, tool) => tool === 'read_file',
  writesFiles: (_event, tool) => ['write_file', 'patch'].includes(tool),
};
