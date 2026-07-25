import type { NormalizedHookEventName } from '../host-hook.js';
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
