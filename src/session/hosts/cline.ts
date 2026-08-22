import type { NormalizedHookEventName } from '../../core/host-hook-types.js';
import type { HostIdentity, HostProfile } from './profile.js';
import { hostString, toolNameIsShell } from './profile.js';

/**
 * The events `integrations/cline/knowl-plugin.mjs` sends.
 *
 * They are the *normalized* names rather than Cline's own, because the mapping happens in the
 * plugin: it is the only code that can see Cline's method names, since they arrive as calls on
 * a JavaScript object rather than as a payload. That makes this profile look like `generic`,
 * and for the same reason -- the caller has already done the translation.
 */
const CLINE_EVENTS: NormalizedHookEventName[] = [
  'session-start', 'turn-start', 'session-event', 'checkpoint', 'turn-stop', 'session-stop',
];

/**
 * Cline, whose lifecycle arrives through a plugin rather than a hooks file.
 *
 * Cline has no hooks file and no shell-command channel: its hooks are `AgentPlugin` objects
 * loaded into its own runtime. For a while that was recorded here as "cannot be a HookHost",
 * which was half right and produced the wrong conclusion. It cannot be *configured* like one --
 * `knowl init` has no file to write, so `hookEvents` is empty and nothing is registered. But it
 * can absolutely *send* like one, and it does: the shipped plugin translates Cline's method
 * calls and shells out to `knowl agent-hook cline <event>`, the same entry point every other
 * host's hooks use.
 *
 * **`nativeOutput: false`**, alone among the non-generic hosts. There is no envelope to build
 * because the reader is our own plugin rather than a vendor's hook runner, so the host-neutral
 * lifecycle result goes back as-is and the plugin lifts `context` out of it.
 *
 * **`lifecycleClaimable: false`**, because the plugin is an opt-in file the person wires into
 * `ClineCore.start()`. A repository configured for Cline may or may not have done that, and the
 * MCP card must not tell an agent its hooks own the lifecycle when they may not be loaded at
 * all -- the conditional line is exactly right here.
 */
export const clineProfile: HostProfile = {
  host: 'cline',
  // Empty because `knowl init` registers nothing: installation is a path in the person's Cline
  // config, not a file Knowl writes. Not empty because the host has no lifecycle.
  hookEvents: [],
  promptEvent: undefined,
  sharesSessionBinding: true,
  nativeOutput: false,
  midTurnDeliveryVerified: false,
  hookConfigStyle: 'none',
  lifecycleClaimable: false,
  identity(raw): HostIdentity {
    return {
      externalSessionId: hostString(raw.conversation_id) ?? hostString(raw.session_id),
      externalTurnId: hostString(raw.turn_id),
    };
  },
  normalizedEvent(hostEvent) {
    return CLINE_EVENTS.includes(hostEvent as NormalizedHookEventName)
      ? hostEvent as NormalizedHookEventName
      : undefined;
  },
  isShellEvent(_hostEvent, toolName) {
    return toolNameIsShell(toolName) || toolName === 'execute_command';
  },
  // The plugin reads `context` off the host-neutral result and hands it to Cline as
  // `additionalContext`, so there is no envelope to build on this side.
  startContext() {
    return undefined;
  },
  midTurnContext() {
    return undefined;
  },
  readsFiles: (_event, tool) => ['read_file', 'search_files', 'list_code_definition_names'].includes(tool),
  writesFiles: (_event, tool) => ['write_to_file', 'replace_in_file', 'apply_diff'].includes(tool),
};
