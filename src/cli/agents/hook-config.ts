import { readTextIfExists, MergeStatus, writeWithBackup } from './files.js';
import { HookHost } from './host-hook.js';
import { hostProfile } from '../../session/hosts/index.js';

// `statusMessage` is in the Anthropic-shaped hosts' schema and not in OpenHands'.
type NestedHook = { type: 'command'; command: string; timeout: number; statusMessage?: string };
type NestedEntry = { matcher: string; hooks: NestedHook[] };
// One entry in a flat command list. `timeout` is Cursor's; Windsurf documents no such field.
type FlatEntry = { command: string; timeout?: number };

// One definition per host, in that host's profile. These re-exports keep existing
// importers working without duplicating the lists.
export const CODEX_HOOK_EVENTS = hostProfile('codex').hookEvents;
export const CLAUDE_HOOK_EVENTS = hostProfile('claude').hookEvents;
export const CURSOR_HOOK_EVENTS = hostProfile('cursor').hookEvents;
/**
 * Events Knowl used to register for a host and no longer does.
 *
 * The merge copies unknown keys straight through and `verify` only asserts that *declared*
 * events are present, so a handler for an event we stopped declaring survives every re-init
 * and every `doctor --fix` -- silently, because nothing ever looks for extras. That is not
 * hypothetical: `PostToolUseFailure` and `StopFailure` were declared for codex for years and
 * have never existed in any codex build, so they sit in every `.codex/hooks.json` Knowl has
 * written, firing nothing.
 *
 * Cursor's entry predates this and is unchanged; it is the precedent this generalises.
 */
const RETIRED_HOOK_EVENTS: Partial<Record<HookHost, readonly string[]>> = {
  cursor: ['beforeSubmitPrompt'],
  codex: ['PostToolUseFailure', 'StopFailure'],
};

const retiredEventsFor = (host: HookHost): readonly string[] => RETIRED_HOOK_EVENTS[host] ?? [];

export function knowlHookCommand(platform: NodeJS.Platform, host: HookHost, event: string) {
  const executable = platform === 'win32' ? 'knowl.cmd' : 'knowl';
  return `${executable} agent-hook ${host} ${event} --json`;
}

const ownsCommand = (value: unknown, host: HookHost) =>
  typeof value === 'string' && value.includes(` agent-hook ${host} `);

export function knowlReminderCommand(platform: NodeJS.Platform, host: HookHost): string {
  const executable = platform === 'win32' ? 'knowl.cmd' : 'knowl';
  return `${executable} agent-reminder ${host} --json`;
}

// Keyed on the host, like `ownsCommand`. It used to match ' agent-reminder claude ' literally,
// which was correct while Claude was the only host with a prompt event and silently wrong the
// moment a second one appeared: the reminder written for that host would not be recognised as
// Knowl's own on the next merge, so it would accumulate a duplicate per run.
const ownsReminderCommand = (value: unknown, host: HookHost) =>
  typeof value === 'string' && value.includes(` agent-reminder ${host} `);

function reminderEntry(platform: NodeJS.Platform, host: HookHost): { hooks: NestedHook[] } {
  // Same schema rule as `nestedEntry`: only fields this host's reference defines. This one had
  // its own copy of the entry shape and so kept emitting `statusMessage` into OpenHands' file
  // after the lifecycle entry had stopped.
  const openHands = hostProfile(host).hookConfigStyle === 'openhands-toplevel';
  return {
    hooks: [{
      type: 'command',
      command: knowlReminderCommand(platform, host),
      timeout: 30,
      ...(openHands ? {} : { statusMessage: '' }),
    }],
  };
}

function removeOwnedNestedHandlers(
  entries: Record<string, any>[],
  owns: (command: unknown) => boolean,
): { entries: Record<string, any>[]; removed: boolean } {
  let removed = false;
  const retained = entries.flatMap(entry => {
    if (!Array.isArray(entry.hooks)) return [entry];
    const hooks = entry.hooks.filter((hook: Record<string, unknown>) => {
      const owned = owns(hook.command);
      removed ||= owned;
      return !owned;
    });
    if (hooks.length === entry.hooks.length) return [entry];
    return hooks.length > 0 ? [{ ...entry, hooks }] : [];
  });
  return { entries: retained, removed };
}

function nestedStatusMessage(event: string): string {
  if (event === 'SessionStart') return 'Loading Knowl memory';
  // Keep the field present for host schema compatibility, but empty to avoid status spam.
  return '';
}

/**
 * Which tool names this event's handler needs to see.
 *
 * Everything but the pre-tool event needs all of them. The pre-tool handler runs the write gate,
 * and `runWriteGate` returns on its first line for a tool that does not write a file -- so under
 * a `.*` matcher every Read, Grep, Glob, Bash and Task in a session paid a process spawn and a
 * database open (~170ms each) to reach an immediate no-op. A host that declares `writeTools`
 * gets a matcher naming exactly those, and never starts the process for the rest.
 *
 * Anchored, because these are regexes to the host and an unanchored `Edit` also matches
 * `NotebookEdit` -- harmless here, but not something to leave to the tool names staying
 * disjoint. A host that declares no `writeTools`, or a wildcard-only schema, keeps the wildcard.
 */
function nestedMatcher(host: HookHost, event: string, wildcard: string): string {
  const profile = hostProfile(host);
  if (profile.normalizedEvent(event) !== 'tool-precheck') return wildcard;
  const tools = profile.writeTools;
  if (!tools || tools.length === 0) return wildcard;
  return `^(${tools.join('|')})$`;
}

function nestedEntry(platform: NodeJS.Platform, host: HookHost, event: string): NestedEntry {
  // OpenHands' schema has no `statusMessage`, and its matcher wildcard is `*` rather than the
  // regex `.*` the Anthropic-shaped hosts take. Emitting a field a host does not define is
  // usually ignored and occasionally fatal to parsing the whole file, which would take every
  // other handler in it down too.
  const openHands = hostProfile(host).hookConfigStyle === 'openhands-toplevel';
  return {
    matcher: nestedMatcher(host, event, openHands ? '*' : '.*'),
    hooks: [{
      type: 'command',
      command: knowlHookCommand(platform, host, event),
      timeout: 30,
      ...(openHands ? {} : { statusMessage: nestedStatusMessage(event) }),
    }],
  };
}

/**
 * One entry in a flat command list.
 *
 * Cursor documents `timeout`; Windsurf documents `command`, `powershell`, `show_output` and
 * `working_directory`, and no timeout. An undocumented key is usually ignored and occasionally
 * rejected, and a hooks file a host refuses to parse takes every *other* handler in it down
 * too -- so each host gets exactly the fields its own reference lists.
 *
 * Read off the profile rather than branched on the host name here. This was the last place the
 * writer still asked which vendor it was serving, which made `docs/hosts.md`'s claim that
 * nothing branches on a host name false by exactly one line.
 */
const flatEntry = (platform: NodeJS.Platform, host: HookHost, event: string): FlatEntry => ({
  command: knowlHookCommand(platform, host, event),
  ...(hostProfile(host).hookEntryTimeout === undefined
    ? {}
    : { timeout: hostProfile(host).hookEntryTimeout }),
});

const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export async function mergeNestedHookConfig(
  configPath: string,
  platform: NodeJS.Platform,
  host: HookHost,
  /** Top-level keys this host's file must carry beside its events; see `hookFileExtraKeys`. */
  extraKeys: Record<string, unknown> = {},
): Promise<MergeStatus> {
  const existing = await readTextIfExists(configPath);
  const config = existing === undefined ? {} as Record<string, unknown> : JSON.parse(existing) as Record<string, unknown>;
  // OpenHands keeps its events at the top level; everyone else nests them under `hooks`. That is
  // the *only* structural difference, and hand-rolling a second writer for it is what dropped
  // OpenHands' prompt-reminder block on the first attempt -- the copy was made before the block
  // was read. One writer, one container decision.
  const topLevel = hostProfile(host).hookConfigStyle === 'openhands-toplevel';
  const hooks = !topLevel && config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks)
    ? config.hooks as Record<string, unknown>
    : topLevel ? config : {};
  const events = hostProfile(host).hookEvents;
  let hadOwnEntry = false;
  // Spread first, so an event added to a profile after a settings.json was written appends
  // as a new key and every event already there keeps its position and its foreign handlers.
  // Note what this does *not* do: nothing re-runs the merge on its own. An install written by
  // an older build stays a version behind until `knowl init <host>` or `knowl doctor --fix`
  // runs -- `verifyNestedHookConfig` requires an entry for every declared event, so the
  // missing one surfaces as "lifecycle hooks missing or stale" with a host-init remedy
  // rather than as silence.
  const nextHooks = { ...hooks };
  // Retired events first, so a key that is both retired and re-declared cannot be stripped
  // after it was rewritten. None is today; ordering it this way means none ever can be.
  for (const event of retiredEventsFor(host)) {
    const current = Array.isArray(hooks[event]) ? hooks[event] as Record<string, any>[] : [];
    const retained = removeOwnedNestedHandlers(current, command => ownsCommand(command, host));
    hadOwnEntry ||= retained.removed;
    if (retained.entries.length > 0) nextHooks[event] = retained.entries;
    else delete nextHooks[event];
  }
  for (const event of events) {
    const current = Array.isArray(hooks[event]) ? hooks[event] as Record<string, any>[] : [];
    const filtered = removeOwnedNestedHandlers(current, command => ownsCommand(command, host));
    hadOwnEntry ||= filtered.removed;
    nextHooks[event] = [...filtered.entries, nestedEntry(platform, host, event)];
  }
  // A host without a declared prompt event never gets a prompt-time reminder handler -- and
  // never has Claude's event name substituted for its own, which is what the old fallback did.
  // Guarded rather than returned early: an early return here would skip the write below and
  // register no lifecycle handlers at all.
  const promptEvent = hostProfile(host).promptEvent;
  if (promptEvent) {
    const promptCurrent = Array.isArray(hooks[promptEvent])
      ? hooks[promptEvent] as Record<string, any>[]
      : [];
    // Two removals, one key. The first strips a *lifecycle* handler Knowl once wrote under the
    // prompt event and no longer does; the second strips the previous reminder so re-running
    // init replaces it instead of stacking a second copy.
    const withoutLegacy = removeOwnedNestedHandlers(promptCurrent, command => ownsCommand(command, host));
    hadOwnEntry ||= withoutLegacy.removed;
    const withoutReminder = removeOwnedNestedHandlers(withoutLegacy.entries, command => ownsReminderCommand(command, host));
    hadOwnEntry ||= withoutReminder.removed;
    nextHooks[promptEvent] = [...withoutReminder.entries, reminderEntry(platform, host)];
  }
  // For the top-level container `nextHooks` *is* the whole file -- it started as a copy of
  // `config`, so foreign keys are already in it. Spreading `config` in front of it again put
  // back every key the retired-event loop had just deleted, which is latent only because no
  // top-level host has a retired event yet.
  const next = topLevel
    ? { ...nextHooks, ...extraKeys }
    : { ...config, ...extraKeys, hooks: nextHooks };
  if (existing !== undefined && equal(config, next)) return 'unchanged';
  await writeWithBackup(configPath, `${JSON.stringify(next, null, 2)}\n`, existing);
  return hadOwnEntry ? 'updated' : 'configured';
}

export async function verifyNestedHookConfig(
  configPath: string,
  platform: NodeJS.Platform,
  host: HookHost,
  extraKeys: Record<string, unknown> = {},
): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readTextIfExists(configPath) ?? '{}') as Record<string, any>;
    const config = hostProfile(host).hookConfigStyle === 'openhands-toplevel'
      ? { ...parsed, hooks: parsed }
      : parsed;
    const events = hostProfile(host).hookEvents;
    // The host's own prompt event, not Claude's. Reading `CLAUDE_PROMPT_EVENT` here inspected
    // the wrong key for every host that names its prompt event differently, so verify and merge
    // disagreed about which key held the reminder -- and verify won, reporting stale hooks that
    // re-running init could not clear.
    const promptEvent = hostProfile(host).promptEvent;
    const promptEntries = promptEvent && Array.isArray(config.hooks?.[promptEvent])
      ? config.hooks[promptEvent]
      : [];
    const promptHandlers = promptEntries.flatMap((entry: any) => Array.isArray(entry.hooks) ? entry.hooks : []);
    const noRetiredPromptHandler = !promptHandlers.some((hook: any) => ownsCommand(hook.command, host));
    const reminderHandlers = promptHandlers.filter((hook: any) => ownsReminderCommand(hook.command, host));
    const promptValid = promptEvent
      ? reminderHandlers.length === 1 && promptEntries.some((entry: unknown) => equal(entry, reminderEntry(platform, host)))
      : reminderHandlers.length === 0;
    // A retired event still carrying a Knowl handler means this file was written by a build
    // that declared an event the host does not have. Nothing else looks for extras, so without
    // this the dead handler survives every re-init and every `doctor --fix`.
    const noRetiredEvents = retiredEventsFor(host).every(event =>
      !(config.hooks?.[event] as any[] | undefined)?.some((entry: any) =>
        (Array.isArray(entry.hooks) ? entry.hooks : []).some((hook: any) => ownsCommand(hook.command, host))));
    const extrasPresent = Object.entries(extraKeys).every(([key, value]) => equal(config[key], value));
    return noRetiredPromptHandler && promptValid && noRetiredEvents && extrasPresent
      && events.every(event => Array.isArray(config.hooks?.[event])
      && config.hooks[event].some((entry: unknown) => equal(entry, nestedEntry(platform, host, event))));
  } catch {
    return false;
  }
}

export async function mergeFlatHookConfig(
  configPath: string,
  platform: NodeJS.Platform,
  host: HookHost,
  extraKeys: Record<string, unknown> = {},
): Promise<MergeStatus> {
  const existing = await readTextIfExists(configPath);
  const config = existing === undefined ? {} as Record<string, unknown> : JSON.parse(existing) as Record<string, unknown>;
  const hooks = config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks)
    ? config.hooks as Record<string, unknown>
    : {};
  let hadOwnEntry = false;
  const nextHooks = { ...hooks };
  for (const event of retiredEventsFor(host)) {
    const current = Array.isArray(hooks[event]) ? hooks[event] as Record<string, unknown>[] : [];
    const retained = current.filter(entry => !ownsCommand(entry.command, host));
    hadOwnEntry ||= retained.length !== current.length;
    if (retained.length > 0) nextHooks[event] = retained;
    else delete nextHooks[event];
  }
  for (const event of hostProfile(host).hookEvents) {
    const current = Array.isArray(hooks[event]) ? hooks[event] as Record<string, unknown>[] : [];
    const retained = current.filter(entry => {
      const owned = ownsCommand(entry.command, host);
      hadOwnEntry ||= owned;
      return !owned;
    });
    nextHooks[event] = [...retained, flatEntry(platform, host, event)];
  }
  const next = { ...config, ...extraKeys, hooks: nextHooks };
  if (existing !== undefined && equal(config, next)) return 'unchanged';
  await writeWithBackup(configPath, `${JSON.stringify(next, null, 2)}\n`, existing);
  return hadOwnEntry ? 'updated' : 'configured';
}

export async function verifyFlatHookConfig(
  configPath: string,
  platform: NodeJS.Platform,
  host: HookHost,
  extraKeys: Record<string, unknown> = {},
): Promise<boolean> {
  try {
    const config = JSON.parse(await readTextIfExists(configPath) ?? '{}') as Record<string, any>;
    return Object.entries(extraKeys).every(([key, value]) => equal(config[key], value))
      && retiredEventsFor(host).every(event => !(config.hooks?.[event] as unknown[] | undefined)?.some(entry => ownsCommand((entry as Record<string, unknown>).command, host)))
      && hostProfile(host).hookEvents.every(event => Array.isArray(config.hooks?.[event])
      && config.hooks[event].some((entry: unknown) => equal(entry, flatEntry(platform, host, event))));
  } catch {
    return false;
  }
}



/**
 * Antigravity: one level deeper again -- a *hook name* above the event.
 *
 * `{"knowl": {"PreToolUse": [{matcher, hooks: [...]}]}}`. Owning only the `"knowl"` key is what
 * makes this safe to merge: every other top-level key is somebody else's hook set, and this
 * never reads or rewrites one.
 */
const ANTIGRAVITY_HOOK_NAME = 'knowl';

export async function mergeAntigravityHookConfig(
  configPath: string,
  platform: NodeJS.Platform,
  host: HookHost,
): Promise<MergeStatus> {
  const existing = await readTextIfExists(configPath);
  const config = existing === undefined ? {} as Record<string, unknown> : JSON.parse(existing) as Record<string, unknown>;
  const ours: Record<string, unknown> = {};
  for (const event of hostProfile(host).hookEvents) ours[event] = [nestedEntry(platform, host, event)];
  const next = { ...config, [ANTIGRAVITY_HOOK_NAME]: ours };
  if (existing !== undefined && equal(config, next)) return 'unchanged';
  const hadOwnEntry = config[ANTIGRAVITY_HOOK_NAME] !== undefined;
  await writeWithBackup(configPath, `${JSON.stringify(next, null, 2)}\n`, existing);
  return hadOwnEntry ? 'updated' : 'configured';
}

export async function verifyAntigravityHookConfig(
  configPath: string,
  platform: NodeJS.Platform,
  host: HookHost,
): Promise<boolean> {
  try {
    const config = JSON.parse(await readTextIfExists(configPath) ?? '{}') as Record<string, any>;
    const ours = config[ANTIGRAVITY_HOOK_NAME];
    return Boolean(ours) && hostProfile(host).hookEvents.every(event => Array.isArray(ours[event])
      && ours[event].some((entry: unknown) => equal(entry, nestedEntry(platform, host, event))));
  } catch {
    return false;
  }
}

/**
 * Write this host's hook handlers in whatever shape its profile declares.
 *
 * The one place that knows a shape's quirks -- Copilot's `version` key, Antigravity's extra
 * level, OpenHands having no wrapper at all. Every caller asks for a host and gets the right
 * file; none of them repeats the host name a second time to pick a writer.
 */
const extraKeys = (host: HookHost): Record<string, unknown> =>
  ({ ...hostProfile(host).hookFileExtraKeys });

export async function mergeHookConfig(
  configPath: string,
  platform: NodeJS.Platform,
  host: HookHost,
): Promise<MergeStatus> {
  switch (hostProfile(host).hookConfigStyle) {
    case 'none': return 'unchanged';
    case 'flat-commands': return mergeFlatHookConfig(configPath, platform, host, extraKeys(host));
    case 'antigravity-nested': return mergeAntigravityHookConfig(configPath, platform, host);
    default: return mergeNestedHookConfig(configPath, platform, host, extraKeys(host));
  }
}

export async function verifyHookConfig(
  configPath: string,
  platform: NodeJS.Platform,
  host: HookHost,
): Promise<boolean> {
  switch (hostProfile(host).hookConfigStyle) {
    case 'none': return true;
    case 'flat-commands': return verifyFlatHookConfig(configPath, platform, host, extraKeys(host));
    case 'antigravity-nested': return verifyAntigravityHookConfig(configPath, platform, host);
    default: return verifyNestedHookConfig(configPath, platform, host, extraKeys(host));
  }
}
