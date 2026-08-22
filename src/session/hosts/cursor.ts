import type { NormalizedHookEventName } from '../../core/host-hook-types.js';
import type { HostIdentity, HostProfile } from './profile.js';
import { agentIdentityFrom, hostString } from './profile.js';

const CURSOR_EVENT_MAP: Record<string, NormalizedHookEventName> = {
  sessionStart: 'session-start',
  beforeSubmitPrompt: 'turn-start',
  afterShellExecution: 'session-event',
  postToolUse: 'session-event',
  postToolUseFailure: 'session-event',
  afterFileEdit: 'session-event',
  preCompact: 'checkpoint',
  stop: 'turn-stop',
  sessionEnd: 'session-stop',
};

export const CURSOR_HOOK_EVENTS = [
  'sessionStart', 'afterShellExecution', 'postToolUse', 'postToolUseFailure',
  'afterFileEdit', 'preCompact', 'stop', 'sessionEnd',
] as const;

export const cursorProfile: HostProfile = {
  host: 'cursor',
  hookEvents: CURSOR_HOOK_EVENTS,
  promptEvent: undefined,
  sharesSessionBinding: false,
  nativeOutput: true,
  // Emitted below but not surfaced to the model upstream, so nothing may treat Cursor as
  // already-notified. Flip to true once an upstream release is confirmed to show it.
  midTurnDeliveryVerified: false,
  hookConfigStyle: 'flat-commands',
  hookFileExtraKeys: { version: 1 },
  identity(raw): HostIdentity {
    return {
      externalSessionId: hostString(raw.conversation_id),
      externalTurnId: hostString(raw.generation_id),
      ...agentIdentityFrom(raw),
    };
  },
  normalizedEvent(hostEvent) {
    return CURSOR_EVENT_MAP[hostEvent];
  },
  // Cursor's `afterFileEdit` carries a path and no tool name, so nothing matched the shared
  // Claude-name fallback and impact detection never fired on this host. Like Windsurf, the
  // event is the classification. Cursor has no pre-tool event, so this feeds detection only --
  // there is no gate here to reach.
  writesFiles(hostEvent) {
    return hostEvent === 'afterFileEdit';
  },
  isShellEvent(hostEvent) {
    return hostEvent === 'afterShellExecution';
  },
  startContext(_event, context) {
    return { additional_context: context, sessionStart: true };
  },
  // Cursor documents additional_context on postToolUse, and its hooks accept and log
  // it, but open upstream reports say it is not surfaced to the model. Emitting costs
  // nothing and starts working when that is fixed.
  midTurnContext(text) {
    return { additional_context: text };
  },
};
