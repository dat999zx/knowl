import type { HookHost } from '../../core/host-hook-types.js';
import type { HostProfile } from './profile.js';
import {
  KNOWL_CLAUDE_MODE_LINE, KNOWL_HOST_NEUTRAL_MODE_LINE, KNOWL_MANUAL_MODE_LINE,
} from '../../core/knowl-guidance.js';
import { claudeProfile } from './claude.js';
import { codexProfile } from './codex.js';
import { cursorProfile } from './cursor.js';
import { claudeDesktopProfile } from './claude-desktop.js';
import { genericProfile } from './generic.js';
import { copilotProfile } from './copilot.js';
import { openhandsProfile } from './openhands.js';
import { antigravityProfile } from './antigravity.js';
import { windsurfProfile } from './windsurf.js';

export type { HostIdentity, HostOutput, HostProfile } from './profile.js';

export const HOST_PROFILES: Record<HookHost, HostProfile> = {
  claude: claudeProfile,
  codex: codexProfile,
  cursor: cursorProfile,
  'claude-desktop': claudeDesktopProfile,
  generic: genericProfile,
  copilot: copilotProfile,
  openhands: openhandsProfile,
  antigravity: antigravityProfile,
  windsurf: windsurfProfile,
};

export function hostProfile(host: HookHost): HostProfile {
  const profile = HOST_PROFILES[host];
  if (!profile) throw new Error(`Unsupported hook host: ${host}`);
  return profile;
}

export function isHookHost(value: string): value is HookHost {
  return Object.prototype.hasOwnProperty.call(HOST_PROFILES, value);
}

/**
 * The lifecycle sentence the MCP `initialize` card should carry for this host.
 *
 * Without a host the card sends the neutral line -- *"verified hooks, when active, own lifecycle
 * ... otherwise use the manual fallback"* -- which hands the agent a conditional and leaves it to
 * work out which branch applies. The install already answered that: `knowl init` writes the
 * host's own MCP config and puts the name on the command line, so a Claude session can be told
 * its hooks own the lifecycle full stop, and Claude Desktop can be told it owns the loop full
 * stop. This is also what finally sends `KNOWL_CLAUDE_OPERATIONAL_CARD`, which has been built
 * and pinned by tests since PR #12 and never delivered.
 *
 * A plain string, because it arrives from a command line: an unrecognised host falls back to
 * neutral rather than throwing, since a hand-edited MCP config must not stop the server booting.
 */
export function mcpModeLineForHost(host?: string): string {
  if (!host) return KNOWL_HOST_NEUTRAL_MODE_LINE;
  // Agents Knowl configures over MCP but never sends hook payloads from. They are not
  // `HookHost`s, so they have no profile to ask -- and they are precisely the hosts the manual
  // line exists for, so falling through to the conditional would leave the archetypal case
  // still inferring an answer this knows.
  if (MCP_ONLY_AGENTS.has(host)) return KNOWL_MANUAL_MODE_LINE;
  if (!isHookHost(host)) return KNOWL_HOST_NEUTRAL_MODE_LINE;
  const profile = hostProfile(host);
  if (profile.hookEvents.length === 0) return KNOWL_MANUAL_MODE_LINE;
  // Registered is not running: see `lifecycleClaimable`. A host that cannot promise its hooks
  // are live keeps the conditional line rather than telling an agent never to open the manual
  // loop it is about to need.
  if (profile.lifecycleClaimable === false) return KNOWL_HOST_NEUTRAL_MODE_LINE;
  return KNOWL_CLAUDE_MODE_LINE.replace('Claude hooks', `${HOST_DISPLAY_NAMES[host] ?? host} hooks`);
}

/** Agent names Knowl configures over MCP that are not hook hosts. */
const MCP_ONLY_AGENTS = new Set(['cline']);

/** Hosts whose key does not read as their own name in a sentence. */
const HOST_DISPLAY_NAMES: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  copilot: 'Copilot',
  openhands: 'OpenHands',
  antigravity: 'Antigravity',
  windsurf: 'Windsurf',
  cursor: 'Cursor',
  'claude-desktop': 'Claude Desktop',
};
