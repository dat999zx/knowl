import { SessionEventType } from './types.js';

/**
 * The shape a host hook has been normalized into, and the hosts we accept one from.
 *
 * These live in `core/` rather than beside `normalizeHostHook` because both sides of the hook
 * path need them: the CLI produces one, and the session layer consumes it. Declaring them in
 * the producing module made every consumer import *upward* into `cli/`, which is what turned
 * the hook path into a dependency cycle. A type has no behaviour to place, so it belongs at
 * the bottom where both sides can reach it without either depending on the other.
 */

export type HookHost =
  | 'codex' | 'claude' | 'cursor' | 'claude-desktop' | 'generic'
  | 'copilot' | 'openhands' | 'antigravity' | 'windsurf' | 'cline';

export type NormalizedHookEventName =
  | 'session-start'
  | 'turn-start'
  | 'session-event'
  | 'checkpoint'
  | 'turn-stop'
  | 'session-stop'
  | 'agent-start'
  | 'agent-stop'
  /**
   * A tool call the host is asking about *before* running it, and whose answer decides
   * whether it runs at all.
   *
   * Separate from `session-event` because tense is the whole point: a post-tool event
   * records what happened and its return value is advice, while this one is a question the
   * host is waiting on. Folding the two together would let a consumer record a write that
   * was then refused, and answer a refusal request for a call that already executed.
   */
  | 'tool-precheck';

export interface NormalizedHostHook {
  host: HookHost;
  event: NormalizedHookEventName;
  /**
   * The host's own name for the event, kept beside the normalized one.
   *
   * Normalization is lossy on purpose -- several host events map to one normalized event, which
   * is what lets the engine stay host-agnostic. But two consumers need the original back.
   * Windsurf names the *action* rather than the tool (`pre_write_code` says a file is being
   * written and carries no tool name at all), so its writes are unclassifiable without this;
   * and anything answering a pre-tool question has to know which event it is answering, since
   * a verdict stamped with the wrong event name is discarded by the host.
   */
  hostEvent?: string;
  externalSessionId: string;
  externalTurnId?: string;
  projectRoot: string;
  title?: string;
  status?: 'finished' | 'failed';
  type?: SessionEventType;
  payload: Record<string, unknown>;
  /**
   * The host's own name for the tool this event fired for, verbatim and unclassified.
   *
   * `changedPaths` records that a path was touched but not how, so a `Read` normalises to
   * exactly the same event as an `Edit` -- and "this session read that file" and "this
   * session wrote it" are opposite facts. The name was already computed to pick the shell
   * branch and to build the capture key, then discarded, so nothing downstream could tell
   * them apart. It also separates a real file from a `Grep` given a `path` argument, which
   * is allowlisted (`lifecycle.ts:34`) and emits a directory that looks like a changed file.
   *
   * Kept raw: deciding which tools count as a read is a consumer's judgement, and baking it
   * in here would hide the tools it guessed wrong about behind a field nobody can re-derive.
   */
  toolName?: string;
  /** True when this tool event is a Knowl MCP/CLI call — used to reset the drift reminder. */
  knowlTool?: boolean;
  /**
   * The Knowl tool this event fired for, normalized to its bare name.
   *
   * Hosts prefix MCP tools (`mcp__knowl__knowl_store`), so the raw name cannot be matched
   * against what the MCP server recorded under its own tool name.
   */
  knowlToolName?: string;
  /**
   * What makes this event distinct from its neighbours, for debounce purposes only.
   *
   * Never displayed or stored. The capture fingerprint is otherwise built from the
   * payload, and a non-shell tool event carries only `summary: "<Tool> completed"` --
   * so two different Grep calls looked identical and the second inside the debounce
   * window was dropped silently, taking its change card with it. The debounce still
   * needs to collapse the same event delivered twice, so this keys on the tool's
   * arguments rather than on a timestamp or a counter.
   */
  captureKey?: string;
  /** Claude subagent id. Present on every subagent event, absent on main-thread events. */
  agentId?: string;
  /** Claude subagent type, e.g. "Explore". Used only to title the binding. */
  agentType?: string;
  /**
   * Titles and ids the caller supplied in its own tool_input, used to recognise
   * this agent's own writes in new commits. Held in memory for comparison only and
   * never persisted, so no attribution column is needed.
   */
  knowlChangeKeys?: { ids: string[]; titles: string[] };
}
