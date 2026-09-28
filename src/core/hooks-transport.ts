import type { ProjectConfig } from './types.js';
import { loadConfig } from './config.js';

/**
 * How a host reaches Knowl's lifecycle handler: a fresh `knowl agent-hook` process per event,
 * or a tool call on the MCP server the host already holds open.
 *
 * `command` is what every host has always been installed with, and it costs a process per
 * event. Measured on the installed entrypoint (#224): ~224–231ms per invocation, warm cache,
 * after `module.enableCompileCache()`. Over 102 real Claude Code transcripts that is 31s of
 * serialized startup at the p50 session and 190s at the p90 — serialized because `PreToolUse`
 * runs ahead of the tool and the host waits on it.
 *
 * `mcp` moves the mid-session events onto the connection the host already has: Claude Code
 * 2.1.257 and Codex 0.148 both run a hook as a call to a tool on a connected MCP server. The
 * server already holds the database open and, on a store with local embeddings, has already
 * loaded the model; every one of those is re-established per hook process today.
 *
 * `mcp` by default, and the cost is accepted: an `mcp_tool` hook names a tool on the server and
 * MCP has no hidden-tool concept, so the lifecycle target appears in `tools/list` as one more
 * catalog entry. Only hosts whose profile declares `mcpToolHookEvents` (Claude Code, Codex) get
 * `mcp_tool` hooks; every other host keeps command hooks whatever this says. The session-start
 * event stays a `command` hook everywhere because the host's own reference says it fires
 * before servers finish connecting -- which is also where the fallback to `command` runs when
 * the host has no `knowl` server registered.
 */
export type HookTransport = 'command' | 'mcp';

export const HOOK_TRANSPORTS: readonly HookTransport[] = ['command', 'mcp'];

/**
 * The tool the `mcp` transport calls. One name, spelled here and nowhere else: the hooks file
 * names it, the server registers it, and the dispatch wrapper exempts it from the change
 * notice — three places that would drift apart if each spelled it for itself.
 */
export const HOOK_TOOL_NAME = 'knowl_hook';

/** Unset is `mcp`; anything unrecognised falls to `command`, the transport every host works on. */
export function hooksTransport(config?: ProjectConfig | null): HookTransport {
  const value = config?.hooks?.transport;
  if (value === undefined) return 'mcp';
  return HOOK_TRANSPORTS.includes(value as HookTransport) ? value as HookTransport : 'command';
}

/**
 * The transport a repo's hooks file should be written with, read from disk at the moment the
 * file is written. An unreadable or absent config is `command`, for the reason every gate in
 * this codebase fails toward its quietest value: the failure mode of turning something on by
 * accident is a hooks file that names a tool the server was never told to register.
 */
export async function resolveHookTransport(root: string): Promise<HookTransport> {
  const config = await loadConfig(root).catch(() => null);
  return config ? hooksTransport(config) : 'command';
}
