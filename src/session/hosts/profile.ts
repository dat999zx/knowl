import type { HookHost, NormalizedHookEventName } from '../../core/host-hook-types.js';

export const MAX_HOST_STRING = 2_000;

export type HostOutput = Record<string, unknown>;

export type HostIdentity = {
  externalSessionId?: string;
  externalTurnId?: string;
  agentId?: string;
  agentType?: string;
};

/**
 * Everything that differs between hosts. Core code asks a profile instead of
 * branching on the host name.
 *
 * Capability is expressed by return value: a host that cannot receive context
 * returns undefined, so no flag can claim support the envelope does not deliver.
 */
export interface HostProfile {
  readonly host: HookHost;
  /** Host-native lifecycle events `knowl init` registers. Empty means MCP-only. */
  readonly hookEvents: readonly string[];
  /** Host event carrying the prompt-time guidance card, if the host has one. */
  readonly promptEvent?: string;
  /** True when one session binding spans turns, so turn-stop closes only the turn. */
  readonly sharesSessionBinding: boolean;
  /** True when the CLI emits host-shaped JSON instead of the host-neutral result. */
  readonly nativeOutput: boolean;
  /**
   * True only when a mid-turn envelope is known to reach the model.
   *
   * Distinct from `midTurnContext` returning something, and the distinction is not
   * pedantic: Cursor accepts and logs `additional_context` but open upstream reports say
   * it never reaches the model. Anything deciding "is this host already telling the agent"
   * has to ask this, not whether an envelope exists -- inferring it from the envelope
   * silences the fallback channel for precisely the host that depends on it.
   */
  readonly midTurnDeliveryVerified: boolean;
  /**
   * The shape of the file `knowl init` writes this host's handlers into.
   *
   * A shape rather than a host name, because the shapes are shared and the vendors are not:
   * Claude and Codex take the same nested object, Copilot takes it with a `version` key,
   * Antigravity nests a hook *name* above the event, Cursor and the two flat hosts take a
   * command list per event. Keying the merge here is what keeps adding a host to one file --
   * the alternative is a widening union repeated in three function signatures, which is where
   * the host name had already started to reappear.
   *
   * `none` is a real value rather than `undefined` so a profile that simply forgot to declare
   * a shape fails conformance instead of silently registering nothing.
   */
  readonly hookConfigStyle:
    /** `{hooks: {Event: [{matcher, hooks: [...]}]}}` -- Claude Code, Codex. */
    | 'claude-nested'
    /** `{"<hook-name>": {Event: [{matcher, hooks: [...]}]}}` -- one level deeper. */
    | 'antigravity-nested'
    /** Events at the **top level**, with no `hooks` wrapper around them. */
    | 'openhands-toplevel'
    /** `{hooks: {event: [{command, ...}]}}` -- a flat command list, no matcher. Cursor, Windsurf. */
    | 'flat-commands'
    | 'none';
  /**
   * The process exit status this host reads as a refusal, when its deny channel is the exit
   * code rather than stdout.
   *
   * Two conventions, opposite rules, and both fail silently. Claude Code and Codex read a
   * `PreToolUse` verdict from stdout **only on exit 0** -- a non-zero exit reads as a crashed
   * hook and the verdict is discarded, so the tool runs anyway. Windsurf has no stdout verdict
   * at all and blocks on **exit 2**, so returning JSON and exiting 0 there allows the write
   * while reporting a block. OpenHands accepts both and lets the JSON win.
   *
   * Absent means the envelope is the refusal, which is the existing behaviour and the default.
   */
  readonly denyExitCode?: number;
  /**
   * True when this host treats *any* unexpected non-zero exit as a refusal.
   *
   * Copilot does: its reference states a non-zero exit other than 2 denies the tool call. That
   * inverts the failure direction the rest of this subsystem is built on -- everywhere else a
   * broken hook allows the write, and here a broken hook blocks somebody's edit with no reason
   * attached, from a code path that was only trying to report its own crash. The hook entry
   * reads this to suppress its error exit, so a Knowl bug degrades to "nothing was recorded for
   * this call" rather than "you cannot edit this file".
   */
  readonly refusesOnAnyNonZeroExit?: true;
  /**
   * Whether this event read or wrote a file, in this host's own vocabulary.
   *
   * The impact subsystem has to tell "this session read that file" from "this session wrote
   * it" -- opposite facts that arrive as the same normalized event. That distinction was
   * hardcoded as Claude Code's tool names (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`,
   * `Read`, `NotebookRead`) and consulted for every host, so on any other one every lookup
   * missed: no read recorded, no write detected, and the write gate answering "no opinion"
   * before it ever consulted `denyToolCall`. A host could declare a refusal channel and be
   * structurally unable to reach it.
   *
   * A predicate rather than a name list because the hosts genuinely disagree about where the
   * answer lives. Most name a tool; Windsurf names the *action* (`pre_write_code` says it and
   * carries no tool name at all). One shape covers both, and a host that names tools writes a
   * one-line `includes`.
   *
   * Omitted means "Claude Code's names", which is what `claude` and `generic` use -- not a
   * guess for anyone else, because every other host declares its own. A vocabulary that has
   * not been read stays absent rather than being invented.
   */
  readsFiles?: (hostEvent: string, toolName: string) => boolean;
  writesFiles?: (hostEvent: string, toolName: string) => boolean;
  /**
   * The write tools by name, when this host's write rule is a plain list.
   *
   * Serves two callers that must never disagree: `toolWritesFile`, which decides whether the
   * write gate has anything to do, and the pre-tool hook entry's `matcher`, which decides
   * whether the host bothers to *start the process that would ask*.
   *
   * That second one is the point. `runWriteGate` returns on its first line for any tool that
   * does not write a file, so a `.*` matcher spent a process spawn and a database open on every
   * Read, Grep, Glob, Bash and Task in a session to reach an immediate no-op -- measured at
   * ~170ms each. A matcher built from this list means the host never starts it.
   *
   * Declared here rather than derived from `writesFiles`, because a predicate has no
   * enumerable domain: nothing can turn `(_e, t) => t === 'apply_patch'` into a regex. A host
   * whose rule is not a plain name list -- cursor and windsurf key off the *event* -- leaves
   * this unset and keeps the wildcard, which is correct rather than merely safe: their pre-tool
   * event only fires on writes already.
   */
  writeTools?: readonly string[];
  /**
   * The top-level keys this host's hooks file must carry beside its events.
   *
   * Copilot rejects a file without `"version": 1`; Cursor requires the same key. Data rather
   * than a config-shape variant, because that is what it is -- treating it as a shape gave
   * Copilot its own enum member and left the dispatcher branching on `host === 'cursor'` for
   * the identical need, which is the branching `hookConfigStyle` exists to remove.
   */
  readonly hookFileExtraKeys?: Readonly<Record<string, unknown>>;
  /**
   * Seconds a flat-shaped host allows one handler, when its schema defines the field at all.
   *
   * Cursor documents `timeout`; Windsurf documents four other keys and no timeout. Emitting a
   * field a host does not define is usually ignored and occasionally fatal to parsing the whole
   * file -- which would take every other handler in it down too, including somebody else's.
   */
  readonly hookEntryTimeout?: number;
  /**
   * Whether the MCP card may state, unconditionally, that this host's hooks own the lifecycle.
   *
   * Registering hook events is not the same as those hooks running, and the card is the one
   * place where being wrong is expensive: an agent told "never call knowl_task_start" that then
   * gets no hooks records nothing at all, and the sentence is what caused it.
   *
   * False for three shapes of "registered but maybe not running":
   * - **Codex**, whose hooks are behind `[features].codex_hooks` and do not run on Windows.
   * - **Antigravity and Windsurf**, whose MCP entry is written once at user scope while their
   *   hooks are per project -- so the same server answers in projects that have no hooks file.
   *
   * Those hosts get the neutral line, which says hooks own the lifecycle *when active* and
   * otherwise to use the manual loop. That is exactly right for them, and it is what they were
   * getting before the card learned to be specific.
   */
  readonly lifecycleClaimable?: boolean;
  /**
   * The working directory this event happened in, if this host does not name it `cwd`.
   *
   * `cwd` then `workspace_roots[0]` was hardcoded for every host, and it is the one field with
   * no graceful degradation: a host that names it something else throws
   * `IncompleteHostHookPayloadError` on *every* event, which the hook entry deliberately
   * swallows in silence -- so the integration reports nothing, logs nothing, and looks exactly
   * like a host nobody has configured.
   *
   * Optional because the two default names cover every host read so far. It exists so the next
   * one can say so in its profile rather than having the default quietly decide for it.
   */
  projectRoot?: (raw: Record<string, unknown>) => string | undefined;
  identity(raw: Record<string, unknown>): HostIdentity;
  normalizedEvent(hostEvent: string): NormalizedHookEventName | undefined;
  isShellEvent(hostEvent: string, toolName: string): boolean;
  startContext(event: NormalizedHookEventName, context: string): HostOutput | undefined;
  midTurnContext(text: string): HostOutput | undefined;
  /**
   * The host's own envelope for refusing the tool call this hook fired for, if it has one.
   *
   * Capability by return value again, and fail closed: a host whose refusal channel is not
   * confirmed leaves this absent, so calling it yields undefined. The alternative -- assuming
   * every host can deny -- emits an envelope the host ignores and then reports the call as
   * blocked, so the write lands while the caller is told it did not. A gate that degrades to
   * advisory is recoverable; one that lies about what it stopped is not.
   *
   * `reason` is the entire message the agent receives, because a denial has no second
   * channel: whatever the agent needs in order to recover has to be inside this string.
   */
  denyToolCall?: (reason: string) => HostOutput | undefined;
  /**
   * The host's envelope for speaking to the agent as it stops, if it has one.
   *
   * Capability by return value again, and absent for every host whose stop channel is not
   * confirmed. Note what this necessarily is on the hosts that do have it: **there is no
   * non-blocking way to reach a model at stop time.** A stop hook either withholds the stop and
   * hands back a reason, which costs a turn, or it says nothing at all -- and a session-end hook
   * fires after the model is gone, so it can reach a log and never the agent.
   *
   * That is why this is a separate member from `midTurnContext` rather than a reuse of it. A
   * mid-turn card is free: it rides an event the agent was already getting. This is not free, so
   * a caller has to choose it deliberately, and the only caller does so behind a config that
   * defaults to off.
   */
  stopContext?: (reason: string) => HostOutput | undefined;
}

export const hostString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_HOST_STRING) : undefined;

/** Shared by hosts whose tool events name the tool rather than the channel. */
export const toolNameIsShell = (toolName: string): boolean =>
  toolName.toLocaleLowerCase() === 'bash' || toolName.toLocaleLowerCase() === 'shell';

export const agentIdentityFrom = (raw: Record<string, unknown>): Pick<HostIdentity, 'agentId' | 'agentType'> => ({
  agentId: hostString(raw.agent_id) ?? hostString(raw.agentId),
  agentType: hostString(raw.agent_type) ?? hostString(raw.agentType),
});
