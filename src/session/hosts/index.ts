import type { HookHost } from '../../core/host-hook-types.js';
import type { HostProfile } from './profile.js';
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
