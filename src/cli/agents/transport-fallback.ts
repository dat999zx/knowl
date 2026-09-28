import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import { readTextIfExists } from './files.js';
import { mergeHookConfig } from './hook-config.js';
import { hostProfile } from '../../session/hosts/index.js';
import { HOOK_TOOL_NAME } from '../../core/hooks-transport.js';
import { KNOWL_MCP_SERVER_KEY } from '../../core/knowl-guidance.js';
import type { HookHost } from '../../core/host-hook-types.js';

type Locations = { hooks: string; servers: Array<() => Promise<unknown>> };

const json = async (file: string): Promise<any> => {
  const text = await readTextIfExists(file);
  return text ? JSON.parse(text) : undefined;
};
const toml = async (file: string): Promise<any> => {
  const text = await readTextIfExists(file);
  return text ? parse(text) : undefined;
};

/**
 * Where each MCP-hook host keeps its hooks file and every place its `knowl` server can be
 * registered. The user-level files count: a server registered once for the user is connected in
 * this repo too, and falling back over it would undo a working setup at every session start.
 */
function locations(root: string, host: HookHost, home: string): Locations | null {
  switch (host) {
    case 'claude':
      return {
        hooks: path.join(root, '.claude', 'settings.local.json'),
        servers: [
          async () => (await json(path.join(root, '.mcp.json')))?.mcpServers,
          async () => (await json(path.join(home, '.claude.json')))?.mcpServers,
          async () => (await json(path.join(home, '.claude.json')))?.projects?.[root]?.mcpServers,
        ],
      };
    case 'codex':
      return {
        hooks: path.join(root, '.codex', 'hooks.json'),
        servers: [
          async () => (await toml(path.join(root, '.codex', 'config.toml')))?.mcp_servers,
          async () => (await toml(path.join(home, '.codex', 'config.toml')))?.mcp_servers,
        ],
      };
    default:
      return null;
  }
}

/**
 * The `mcp` transport's fallback, run at session start because that event is always a command
 * hook: it fires before MCP servers connect, so it is the one place Knowl runs whether or not the
 * server does. A host drops an `mcp_tool` hook with a non-blocking error when the server is not
 * connected and nobody tells Knowl -- so when the hooks file names `knowl_hook` and no config the
 * host reads registers `knowl`, rewrite the hooks as commands and return the line for the card.
 *
 * Two small file reads on the normal path, no network, and every error swallowed: a hook must
 * never fail over this.
 */
export async function checkMcpTransport(root: string, host: HookHost, home: string = os.homedir()): Promise<string | null> {
  try {
    if (!(hostProfile(host).mcpToolHookEvents ?? []).length) return null;
    const where = locations(root, host, home);
    if (!where) return null;
    const hooks = await readTextIfExists(where.hooks);
    if (!hooks?.includes(HOOK_TOOL_NAME)) return null;
    for (const servers of where.servers) {
      const registered = await servers().catch(() => undefined);
      if (registered && typeof registered === 'object' && KNOWL_MCP_SERVER_KEY in registered) return null;
    }
    await mergeHookConfig(where.hooks, process.platform, host, { transport: 'command' });
    return `Knowl hooks fell back to command: the knowl MCP server is not registered for ${host}. Run knowl init ${host} to restore it.`;
  } catch {
    return null;
  }
}
