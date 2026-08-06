import { KNOWL_CLAUDE_PROMPT_REMINDER } from '../../core/knowl-guidance.js';
import { hostProfile, isHookHost, HostOutput } from '../../session/hosts/index.js';

/**
 * Prompt-time guidance card for hosts that declare a prompt event. The envelope comes
 * from the host profile, so a host is supported here exactly when it says it can
 * receive context at turn start.
 */
export function createAgentReminderOutput(host: string): HostOutput {
  const unsupported = new Error(`Unsupported reminder host: ${host}`);
  if (!isHookHost(host)) throw unsupported;
  const profile = hostProfile(host);
  if (!profile.promptEvent) throw unsupported;
  const output = profile.startContext('turn-start', KNOWL_CLAUDE_PROMPT_REMINDER);
  if (!output) throw unsupported;
  return output;
}
