import type { HostIdentity, HostProfile } from './profile.js';
import { hostString } from './profile.js';

/**
 * Claude Desktop is an MCP-only host: it has no lifecycle hook channel, so it
 * registers no events and can receive no injected context. It is still a HookHost
 * because `knowl init` configures its MCP server.
 */
export const claudeDesktopProfile: HostProfile = {
  host: 'claude-desktop',
  hookEvents: [],
  promptEvent: undefined,
  sharesSessionBinding: false,
  nativeOutput: true,
  midTurnDeliveryVerified: false,
  identity(raw): HostIdentity {
    return {
      externalSessionId: hostString(raw.session_id) ?? hostString(raw.conversation_id),
      externalTurnId: hostString(raw.turn_id),
    };
  },
  normalizedEvent() {
    return undefined;
  },
  isShellEvent() {
    return false;
  },
  startContext() {
    return undefined;
  },
  midTurnContext() {
    return undefined;
  },
};
