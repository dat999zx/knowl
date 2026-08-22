import { promptReminderFor } from '../../core/knowl-guidance.js';
import { hostProfile, isHookHost, HostOutput } from '../../session/hosts/index.js';

/**
 * Hosts whose key does not title-case into their own name.
 *
 * Every other host does -- `codex` -> `Codex`, `windsurf` -> `Windsurf` -- so listing them here
 * would be six lines restating what the fallback already returns, and a seventh host would be
 * assumed to need one.
 */
const HOST_LABELS: Record<string, string> = {
  openhands: 'OpenHands',
};

const hostLabel = (host: string): string =>
  HOST_LABELS[host] ?? host.charAt(0).toUpperCase() + host.slice(1);

/**
 * Prompt-time guidance card for hosts that declare a prompt event. The envelope comes
 * from the host profile, so a host is supported here exactly when it says it can
 * receive context at turn start.
 *
 * The card names this host rather than always naming Claude: its closing line is the one that
 * tells the agent not to open a manual task loop, and a Codex session told that *Claude's*
 * hooks own the lifecycle can reasonably read the sentence as being about a different session.
 */
export function createAgentReminderOutput(host: string): HostOutput {
  const unsupported = new Error(`Unsupported reminder host: ${host}`);
  if (!isHookHost(host)) throw unsupported;
  const profile = hostProfile(host);
  if (!profile.promptEvent) throw unsupported;
  const output = profile.startContext('turn-start', promptReminderFor(hostLabel(host)));
  if (!output) throw unsupported;
  return output;
}
