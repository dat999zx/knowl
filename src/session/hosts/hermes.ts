import type { NormalizedHookEventName } from '../../core/host-hook-types.js';
import type { HostIdentity, HostOutput, HostProfile } from './profile.js';
import { hostString, toolNameIsShell } from './profile.js';

/**
 * Hermes' hook events, mapped onto the engine's. Read from `agent/shell_hooks.py`,
 * `hermes_cli/plugins.py` and `hermes_cli/hooks.py` in Hermes Agent v0.21.0 (2026.8.31).
 *
 * **`on_session_start` is deliberately absent, and its absence is what delivers the bootstrap
 * card.** Binding the session there spends the card on an event whose return value Hermes
 * discards -- neither the plugin dispatcher nor the shell-hook bridge reads it -- and the first
 * real `pre_llm_call` then arrives on a session the engine has already seen, so it emits
 * nothing. Measured on 2026-09-04: a fresh session whose first event is `pre_llm_call` gets a
 * 3,030-character card; the same session preceded by `on_session_start` gets an empty answer on
 * both. Letting the first turn bind the session puts the card where Hermes actually reads it.
 * Everything session start did is still done -- one event later, by the turn that can carry it.
 *
 * Two events map to `turn-stop`, on purpose. `pre_verify` fires only on a turn that edited
 * code, just before the agent finishes, and it is the one Hermes event whose answer can keep
 * the turn going -- so it carries the capture nudge. `on_session_end` fires from the turn
 * finaliser on *every* turn (its payload has `turn_id` and `completed`; the name is historical)
 * and closes the turn on the ones `pre_verify` skipped. When both fire, the second finds the
 * turn binding already closed and is dropped as `event-loss`, which is the engine's existing
 * behaviour for a repeated stop. `on_session_finalize` is the real end of the session.
 */
const HERMES_EVENT_MAP: Record<string, NormalizedHookEventName> = {
  pre_llm_call: 'turn-start',
  pre_tool_call: 'tool-precheck',
  post_tool_call: 'session-event',
  pre_verify: 'turn-stop',
  on_session_end: 'turn-stop',
  on_session_finalize: 'session-stop',
};

/**
 * The lifecycle events the plugin forwards, beside the prompt event `pre_llm_call`.
 *
 * Documentation, not `hookEvents`: that field means "events `knowl init` writes into a file",
 * and this host has no such file -- the same position Cline is in, for the same reason.
 */
export const HERMES_PLUGIN_EVENTS = [
  'pre_llm_call', 'pre_tool_call', 'post_tool_call', 'pre_verify', 'on_session_end', 'on_session_finalize',
] as const;

/**
 * Claude Code's `Stop` shape, which Hermes accepts on both of its decision events.
 *
 * `shell_hooks.py` normalises `{"decision": "block", "reason"}` on `pre_tool_call` into its own
 * `{"action": "block", "message"}` (the module calls that translation "the single most important
 * correctness invariant"), and `get_pre_verify_continue_message` reads the same pair on
 * `pre_verify` as "keep the turn going with this follow-up". One envelope, two channels. Not the
 * `hookSpecificOutput` wrapper Claude uses for its own PreToolUse verdict -- Hermes reads the
 * top-level keys only.
 */
const hermesBlock = (reason: string): HostOutput => ({ decision: 'block', reason });

/**
 * Hermes Agent, through the Python plugin at `integrations/hermes/`.
 *
 * **Why a plugin and not the shell hooks this profile used to describe.** Hermes' `config.yaml`
 * takes `hooks.<event>[].command` entries in Claude Code's wire format, and 5.19.0 shipped them.
 * They are terminal-only: Hermes Desktop's `serve` backend takes a fast-launch path that reaches
 * `cmd_dashboard` without ever calling `register_from_config`, so not one of those hooks is
 * registered there (`hermes_cli/web_server.py` touches `shell_hooks` only to draw the dashboard's
 * approve/revoke list, and `tui_gateway/` never mentions it; upstream hermes-agent#69825).
 * `discover_plugins()` runs from `agent/agent_init.py`, which every path builds an agent through
 * -- terminal, Desktop, cron, gateway. So the plugin is the channel that reaches everyone, and
 * `hermes hooks doctor` reporting healthy on Desktop is the trap: it reads config, not the live
 * registry.
 *
 * The plugin sends exactly what the shell-hook bridge would have sent (`_serialize_payload` in
 * `agent/shell_hooks.py`): `hook_event_name`, `tool_name`, `tool_input`, `session_id`, `cwd`, and
 * the rest under `extra`. Those top-level keys are the ones the normaliser reads, so this profile
 * stays Claude's dialect on the way in, and `extra` still never reaches the engine -- the stdin
 * allowlist keeps root fields only.
 *
 * **Refusal**: `{"decision": "block", "reason"}` **and** exit 2, because the plugin reads both.
 * Same pair as OpenHands.
 *
 * **Stop channel**: `pre_verify` fires before a turn that edited code finishes and its answer
 * keeps the turn going, bounded by Hermes' `max_verify_nudges`. So `stopContext` is real here,
 * on exactly the turns the capture nudge is about.
 *
 * **Context**: `{"context": "..."}` on `pre_llm_call` is appended to the user message. Hermes does
 * not truncate an oversized card, it *spills* it (`tools/hook_output_spill.py`): past 10,000
 * characters the model receives a head/tail excerpt and a file path instead of the card, so the
 * plugin bounds what it returns rather than letting that happen. `post_tool_call` output is
 * ignored by Hermes, so there is no mid-turn envelope and the change card keeps its MCP channel --
 * though the plugin does carry a same-turn impact card through `transform_tool_result`, which
 * takes a plain string a subprocess could never have returned.
 *
 * **`cwd`.** The shell-hook payload carried `Path.cwd()`, the Hermes *process* directory, which on
 * Desktop is wherever the backend started. The plugin reads Hermes' own per-session context
 * instead (`agent/runtime_cwd.resolve_context_cwd`), so a Desktop session resolves the repository
 * the user actually opened.
 *
 * **`lifecycleClaimable: false`**, because the plugin is an opt-in install: a repository
 * configured for Hermes may have the MCP entry and no plugin, and the card must not tell an agent
 * its hooks own the lifecycle when nothing is loaded.
 *
 * Tool names from `tools/file_tools.py` and `tools/terminal_tool.py`: `read_file`, `write_file`,
 * `patch`, `search_files`, `terminal`; the path argument is `path`.
 */
export const hermesProfile: HostProfile = {
  host: 'hermes',
  // Empty because `knowl init` registers no file: installation is a plugin directory and two
  // list entries in the person's config. Not empty because the host has no lifecycle -- the
  // events it sends are in HERMES_PLUGIN_EVENTS, and the map above is what accepts them.
  hookEvents: [],
  promptEvent: 'pre_llm_call',
  sharesSessionBinding: true,
  nativeOutput: true,
  midTurnDeliveryVerified: false,
  // No hooks file: the lifecycle arrives through the plugin, and `knowl init hermes` installs
  // that rather than writing handlers into the person's config.
  hookConfigStyle: 'none',
  denyExitCode: 2,
  lifecycleClaimable: false,
  writeTools: ['write_file', 'patch'],
  readsFiles: (_event, tool) => tool === 'read_file',
  identity(raw): HostIdentity {
    return { externalSessionId: hostString(raw.session_id) };
  },
  normalizedEvent(hostEvent) {
    return HERMES_EVENT_MAP[hostEvent];
  },
  isShellEvent(_hostEvent, toolName) {
    return toolNameIsShell(toolName) || toolName === 'terminal';
  },
  startContext(event, context) {
    return event === 'turn-start' ? { context } : undefined;
  },
  midTurnContext() {
    return undefined;
  },
  denyToolCall: hermesBlock,
  stopContext: hermesBlock,
};
