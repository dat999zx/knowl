import { readTextIfExists, MergeStatus, writeWithBackup } from './files.js';
import { HookHost } from './host-hook.js';
import { hostProfile } from '../../session/hosts/index.js';
import { KNOWL_MCP_SERVER_KEY } from '../../core/knowl-guidance.js';
import { HOOK_TOOL_NAME, type HookTransport } from '../../core/hooks-transport.js';

// `statusMessage` is in the Anthropic-shaped hosts' schema and not in OpenHands'.
type NestedCommandHook = { type: 'command'; command: string; timeout: number; statusMessage?: string };
/**
 * A hook that calls a tool on an already-connected MCP server instead of spawning a process.
 * The same fields on Claude Code (2.1.257) and Codex (0.148): `server`, `tool`, `input` with
 * `${path}` templates read off the hook's JSON input, `timeout` in seconds, `statusMessage`.
 */
type NestedMcpHook = {
  type: 'mcp_tool'; server: string; tool: string; input: Record<string, string>; timeout: number; statusMessage?: string;
};
type NestedHook = NestedCommandHook | NestedMcpHook;
type NestedEntry = { matcher: string; hooks: NestedHook[] };

/** What a nested merge or verify may be told beyond the host: today, only the transport. */
export type HookConfigOptions = { transport?: HookTransport };
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

/**
 * Whether a nested hook entry is Knowl's own lifecycle handler for this host, in either shape.
 *
 * The `mcp_tool` half is keyed on the tool and on the `host` template constant, not on the
 * server name alone: a person's own `mcp_tool` hook against the knowl server is theirs, and
 * the same server serves several hosts' files, so the host in the input is what says whose
 * entry this is. Recognising both shapes is what lets a transport change replace the other
 * shape's entries rather than stack beside them.
 */
const ownsHook = (hook: Record<string, unknown>, host: HookHost): boolean => {
  if (ownsCommand(hook.command, host)) return true;
  if (hook.type !== 'mcp_tool' || hook.tool !== HOOK_TOOL_NAME) return false;
  const input = hook.input;
  return typeof input === 'object' && input !== null && (input as Record<string, unknown>).host === host;
};

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
  owns: (hook: Record<string, unknown>) => boolean,
): { entries: Record<string, any>[]; removed: boolean } {
  let removed = false;
  const retained = entries.flatMap(entry => {
    if (!Array.isArray(entry.hooks)) return [entry];
    const hooks = entry.hooks.filter((hook: Record<string, unknown>) => {
      const owned = owns(hook);
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

/**
 * The hook input fields the `mcp_tool` entry forwards, as `${field}` templates.
 *
 * A command hook receives the host's whole JSON payload on stdin and `readLifecyclePayload`
 * keeps the allowlisted parts of it. An `mcp_tool` hook receives only what its `input` names,
 * so this is that allowlist restated as templates: the identity fields both hosts' profiles
 * read, the tool name, the two tool objects, the subagent identity, and the prompt and
 * final-message heads the fleet reduces to one line. Nothing here reaches the server that the
 * stdin path would have dropped, and the server runs the same filter over it again.
 */
const MCP_HOOK_INPUT_FIELDS = [
  'session_id', 'conversation_id', 'thread_id', 'turn_id', 'cwd', 'hook_event_name',
  'tool_name', 'tool_input', 'tool_response', 'agent_id', 'agent_type',
  'prompt', 'last_assistant_message', 'error',
] as const;

/**
 * The leaves of the two tool objects, forwarded a second time by dotted path.
 *
 * Codex documents that a placeholder filling a whole value keeps its JSON type, so
 * `${tool_input}` arrives as the object. Claude Code documents substitution for string values
 * and says nothing about an object-valued path, so the same template may arrive as text or
 * not at all. The leaves the lifecycle actually reads are therefore named individually as
 * well -- `${tool_input.file_path}` is the documented form on both hosts -- and the server
 * rebuilds the object from them when the whole-object template did not resolve. The set is
 * `lifecycle.ts`'s nested allowlist for the two objects, spelled out.
 */
const MCP_HOOK_INPUT_LEAVES = [
  'tool_input.command', 'tool_input.file_path', 'tool_input.notebook_path', 'tool_input.path',
  'tool_input.pattern', 'tool_input.glob', 'tool_input.query', 'tool_input.url',
  'tool_input.title', 'tool_input.id', 'tool_input.supersedeId', 'tool_input.supersedes',
  'tool_response.exit_code', 'tool_response.stdout', 'tool_response.stderr',
] as const;

/** `tool_input.file_path` -> `tool_input__file_path`: one flat key per leaf, no dots to misread. */
export const mcpHookLeafKey = (leaf: string): string => leaf.replace('.', '__');

export function mcpHookInput(host: HookHost, event: string): Record<string, string> {
  const input: Record<string, string> = { host, event };
  for (const field of MCP_HOOK_INPUT_FIELDS) input[field] = `\${${field}}`;
  for (const leaf of MCP_HOOK_INPUT_LEAVES) input[mcpHookLeafKey(leaf)] = `\${${leaf}}`;
  return input;
}

/** Whether this event goes over MCP for this host under the given transport. */
function overMcp(host: HookHost, event: string, transport: HookTransport | undefined): boolean {
  return transport === 'mcp' && (hostProfile(host).mcpToolHookEvents ?? []).includes(event);
}

function nestedEntry(platform: NodeJS.Platform, host: HookHost, event: string, options: HookConfigOptions = {}): NestedEntry {
  // OpenHands' schema has no `statusMessage`, and its matcher wildcard is `*` rather than the
  // regex `.*` the Anthropic-shaped hosts take. Emitting a field a host does not define is
  // usually ignored and occasionally fatal to parsing the whole file, which would take every
  // other handler in it down too.
  const openHands = hostProfile(host).hookConfigStyle === 'openhands-toplevel';
  const matcher = nestedMatcher(host, event, openHands ? '*' : '.*');
  if (overMcp(host, event, options.transport)) {
    // Same 30s as the command entry. The host's default for this type is 600s, which would let
    // a wedged server hold a PreToolUse -- and the user behind it -- for ten minutes.
    return {
      matcher,
      hooks: [{
        type: 'mcp_tool',
        server: KNOWL_MCP_SERVER_KEY,
        tool: HOOK_TOOL_NAME,
        input: mcpHookInput(host, event),
        timeout: 30,
        statusMessage: nestedStatusMessage(event),
      }],
    };
  }
  return {
    matcher,
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
  options: HookConfigOptions = {},
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
    const retained = removeOwnedNestedHandlers(current, hook => ownsHook(hook, host));
    hadOwnEntry ||= retained.removed;
    if (retained.entries.length > 0) nextHooks[event] = retained.entries;
    else delete nextHooks[event];
  }
  for (const event of events) {
    const current = Array.isArray(hooks[event]) ? hooks[event] as Record<string, any>[] : [];
    // Both shapes are Knowl's own, so switching the transport replaces the other shape's
    // entry instead of leaving a process hook and a tool hook to fire side by side.
    const filtered = removeOwnedNestedHandlers(current, hook => ownsHook(hook, host));
    hadOwnEntry ||= filtered.removed;
    nextHooks[event] = [...filtered.entries, nestedEntry(platform, host, event, options)];
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
    const withoutLegacy = removeOwnedNestedHandlers(promptCurrent, hook => ownsHook(hook, host));
    hadOwnEntry ||= withoutLegacy.removed;
    const withoutReminder = removeOwnedNestedHandlers(withoutLegacy.entries, hook => ownsReminderCommand(hook.command, host));
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
  options: HookConfigOptions = {},
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
    const noRetiredPromptHandler = !promptHandlers.some((hook: any) => ownsHook(hook, host));
    const reminderHandlers = promptHandlers.filter((hook: any) => ownsReminderCommand(hook.command, host));
    const promptValid = promptEvent
      ? reminderHandlers.length === 1 && promptEntries.some((entry: unknown) => equal(entry, reminderEntry(platform, host)))
      : reminderHandlers.length === 0;
    // A retired event still carrying a Knowl handler means this file was written by a build
    // that declared an event the host does not have. Nothing else looks for extras, so without
    // this the dead handler survives every re-init and every `doctor --fix`.
    const noRetiredEvents = retiredEventsFor(host).every(event =>
      !(config.hooks?.[event] as any[] | undefined)?.some((entry: any) =>
        (Array.isArray(entry.hooks) ? entry.hooks : []).some((hook: any) => ownsHook(hook, host))));
    const extrasPresent = Object.entries(extraKeys).every(([key, value]) => equal(config[key], value));
    return noRetiredPromptHandler && promptValid && noRetiredEvents && extrasPresent
      && events.every(event => Array.isArray(config.hooks?.[event])
      // Exactly the entry the current transport would write. A file written under the other
      // transport therefore verifies false, which is what puts "lifecycle hooks missing or
      // stale" in front of the person and `doctor --fix` behind the rewrite.
      && config.hooks[event].some((entry: unknown) => equal(entry, nestedEntry(platform, host, event, options))));
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
  // The transport reaches only the nested writer. The flat and Antigravity shapes belong to
  // hosts that declare no `mcpToolHookEvents`, and `nestedEntry` asks the profile before it
  // asks the option, so a host without the field keeps its process hooks whatever is set.
  options: HookConfigOptions = {},
): Promise<MergeStatus> {
  switch (hostProfile(host).hookConfigStyle) {
    case 'none': return 'unchanged';
    // Owned by `createHermesAdapter`, which writes the block into the host's YAML config.
    case 'hermes-yaml': return 'unchanged';
    case 'flat-commands': return mergeFlatHookConfig(configPath, platform, host, extraKeys(host));
    case 'antigravity-nested': return mergeAntigravityHookConfig(configPath, platform, host);
    default: return mergeNestedHookConfig(configPath, platform, host, extraKeys(host), options);
  }
}

export async function verifyHookConfig(
  configPath: string,
  platform: NodeJS.Platform,
  host: HookHost,
  options: HookConfigOptions = {},
): Promise<boolean> {
  switch (hostProfile(host).hookConfigStyle) {
    case 'none': return true;
    case 'hermes-yaml': return true;
    case 'flat-commands': return verifyFlatHookConfig(configPath, platform, host, extraKeys(host));
    case 'antigravity-nested': return verifyAntigravityHookConfig(configPath, platform, host);
    default: return verifyNestedHookConfig(configPath, platform, host, extraKeys(host), options);
  }
}
