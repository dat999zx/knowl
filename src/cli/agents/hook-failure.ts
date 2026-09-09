import { HookHost } from '../../core/host-hook-types.js';
import { HOST_PROFILES, hostProfile, isHookHost } from '../../session/hosts/index.js';

/** What `--json` means on a hook command, in the one shape both of them take. */
export type HookOutputOptions = { json?: boolean };

/** Every host declaring a prompt event, which is exactly the set `agent-reminder` can serve. */
export const REMINDER_HOSTS: HookHost[] = (Object.keys(HOST_PROFILES) as HookHost[])
  .filter(host => Boolean(HOST_PROFILES[host].promptEvent));

/** Every host with a lifecycle hook profile, which is exactly the set `agent-hook` can serve. */
export const HOOK_HOSTS: HookHost[] = Object.keys(HOST_PROFILES) as HookHost[];

/**
 * How a hook command reports its own failure, and whether it may say so in the exit status.
 *
 * Both of these run as a host's hook process, so a failure has three audiences and they want
 * different things. A person wants the line on stderr. A host configured with `--json` parses
 * stdout, and an empty stdout is `JSON.parse('')` -- which is why `reportCommandFailure` already
 * writes both streams for the sibling `agent-lifecycle` command, and why `--json` was worth
 * implementing here rather than deleting from the config files that already carry it.
 *
 * The third audience is the editor. `refusesOnAnyNonZeroExit` marks a host that reads ANY
 * non-zero exit from a hook as a refusal of the action the hook was called on, so on Copilot our
 * own crash would deny the user's edit rather than report a Knowl problem. `agent-hook` has
 * respected that since the field was added; `agent-reminder` had no equivalent, and it runs on
 * Copilot too -- `copilot.promptEvent` is `userPromptSubmitted`.
 *
 * Returns whether the caller may exit non-zero, rather than exiting, so the decision stays at
 * the call site and the caller can finish closing the store first.
 */
export function reportHookFailure(
  host: string,
  options: HookOutputOptions,
  label: string,
  error: unknown,
): boolean {
  const message = `${label}: ${String((error as { message?: unknown })?.message ?? error)}`;
  console.error(message);
  if (options.json) console.log(JSON.stringify({ error: { message } }));
  return !(isHookHost(host) && hostProfile(host).refusesOnAnyNonZeroExit);
}
