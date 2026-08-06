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

export type HookHost = 'codex' | 'claude' | 'cursor' | 'claude-desktop' | 'generic';

export type NormalizedHookEventName =
  | 'session-start'
  | 'turn-start'
  | 'session-event'
  | 'checkpoint'
  | 'turn-stop'
  | 'session-stop'
  | 'agent-start'
  | 'agent-stop';

export interface NormalizedHostHook {
  host: HookHost;
  event: NormalizedHookEventName;
  externalSessionId: string;
  externalTurnId?: string;
  projectRoot: string;
  title?: string;
  status?: 'finished' | 'failed';
  type?: SessionEventType;
  payload: Record<string, unknown>;
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
