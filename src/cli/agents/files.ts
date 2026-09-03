import fs from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import { KNOWL_MCP_SERVER_KEY } from '../../core/knowl-guidance.js';

export interface McpEntry {
  command: string;
  args: string[];
}

export type MergeStatus = 'configured' | 'updated' | 'unchanged';

/**
 * Whether a stored MCP entry is the one we would write.
 *
 * Tolerant of a **missing trailing `--host <name>` pair**, and that asymmetry is the point.
 * `knowl init` started writing `serve --host <host>` so the server can send an exact guidance
 * card, but the comparison is what `detect()` answers with -- so a strict positional match
 * would have reported every install written before the flag as unconfigured, put every existing
 * user into `doctor`'s drift list, and invited `doctor --fix` to rewrite files that were working
 * perfectly. An entry without the flag runs identically; it just reads the neutral card.
 *
 * Extra arguments we did not write are still a mismatch -- somebody edited the entry on purpose,
 * and silently agreeing with it would hide that.
 */
export function mcpEntryMatches(value: unknown, entry: McpEntry) {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<McpEntry>;
  if (candidate.command !== entry.command || !Array.isArray(candidate.args)) return false;
  const args = candidate.args;
  if (args.length === entry.args.length) return args.every((arg, index) => arg === entry.args[index]);
  const withoutHost = entry.args.slice(0, entry.args.indexOf('--host'));
  return entry.args.includes('--host')
    && args.length === withoutHost.length
    && args.every((arg, index) => arg === withoutHost[index]);
}

export async function readTextIfExists(configPath: string) {
  try {
    return await fs.readFile(configPath, 'utf8');
  } catch (error: any) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function writeWithBackup(configPath: string, content: string, existing?: string) {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  if (existing !== undefined) await fs.copyFile(configPath, `${configPath}.backup`);
  const temporary = `${configPath}.tmp`;
  await fs.writeFile(temporary, content, 'utf8');
  await fs.rename(temporary, configPath);
}

export async function mergeJsonMcpConfig(configPath: string, entry: McpEntry): Promise<MergeStatus> {
  const existing = await readTextIfExists(configPath);
  // A 0-byte file is what Gemini CLI's migration leaves at `~/.gemini/config/mcp_config.json`,
  // which the Antigravity CLI then reads; an empty file holds no servers, it is not a parse error.
  const config = existing === undefined || existing.trim() === '' ? {} as Record<string, unknown> : JSON.parse(existing) as Record<string, unknown>;
  const servers = config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers)
    ? config.mcpServers as Record<string, unknown>
    : {};
  if (mcpEntryMatches(servers[KNOWL_MCP_SERVER_KEY], entry)) return 'unchanged';
  const status: MergeStatus = servers[KNOWL_MCP_SERVER_KEY] === undefined ? 'configured' : 'updated';
  config.mcpServers = { ...servers, [KNOWL_MCP_SERVER_KEY]: entry };
  await writeWithBackup(configPath, `${JSON.stringify(config, null, 2)}\n`, existing);
  return status;
}

export async function mergeCodexTomlConfig(configPath: string, entry: McpEntry): Promise<MergeStatus> {
  const existing = await readTextIfExists(configPath);
  const config = existing === undefined ? {} as Record<string, any> : parse(existing) as Record<string, any>;
  const servers = config.mcp_servers && typeof config.mcp_servers === 'object' && !Array.isArray(config.mcp_servers)
    ? config.mcp_servers as Record<string, unknown>
    : {};
  if (mcpEntryMatches(servers[KNOWL_MCP_SERVER_KEY], entry)) return 'unchanged';
  const status: MergeStatus = servers[KNOWL_MCP_SERVER_KEY] === undefined ? 'configured' : 'updated';
  config.mcp_servers = { ...servers, [KNOWL_MCP_SERVER_KEY]: entry };
  await writeWithBackup(configPath, stringify(config), existing);
  return status;
}
