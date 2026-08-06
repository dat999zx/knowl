import type { NormalizedHookEventName } from '../../core/host-hook-types.js';
import type { HostIdentity, HostProfile } from './profile.js';
import { hostString, toolNameIsShell } from './profile.js';

const GENERIC_EVENTS: NormalizedHookEventName[] = [
  'session-start', 'turn-start', 'session-event', 'checkpoint', 'turn-stop', 'session-stop',
];

/**
 * The host-neutral contract: callers send normalized event names directly and read
 * the lifecycle result as JSON, so there is no envelope to build.
 */
export const genericProfile: HostProfile = {
  host: 'generic',
  hookEvents: GENERIC_EVENTS,
  promptEvent: undefined,
  sharesSessionBinding: false,
  nativeOutput: false,
  midTurnDeliveryVerified: false,
  identity(raw): HostIdentity {
    return {
      externalSessionId: hostString(raw.sessionId),
      externalTurnId: hostString(raw.turnId),
    };
  },
  normalizedEvent(hostEvent) {
    return GENERIC_EVENTS.includes(hostEvent as NormalizedHookEventName)
      ? hostEvent as NormalizedHookEventName
      : undefined;
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
};
