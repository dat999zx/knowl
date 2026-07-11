import fs from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';

export interface McpEntry {
  command: string;
  args: string[];
}

export type MergeStatus = 'configured' | 'updated' | 'unchanged';

function equalEntry(value: unknown, entry: McpEntry) {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<McpEntry>;
  return candidate.command === entry.command
    && Array.isArray(candidate.args)
    && candidate.args.length === entry.args.length
    && candidate.args.every((arg, index) => arg === entry.args[index]);
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
  const config = existing === undefined ? {} as Record<string, unknown> : JSON.parse(existing) as Record<string, unknown>;
  const servers = config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers)
    ? config.mcpServers as Record<string, unknown>
    : {};
  if (equalEntry(servers.knowl, entry)) return 'unchanged';
  const status: MergeStatus = servers.knowl === undefined ? 'configured' : 'updated';
  config.mcpServers = { ...servers, knowl: entry };
  await writeWithBackup(configPath, `${JSON.stringify(config, null, 2)}\n`, existing);
  return status;
}

export async function mergeCodexTomlConfig(configPath: string, entry: McpEntry): Promise<MergeStatus> {
  const existing = await readTextIfExists(configPath);
  const config = existing === undefined ? {} as Record<string, any> : parse(existing) as Record<string, any>;
  const servers = config.mcp_servers && typeof config.mcp_servers === 'object' && !Array.isArray(config.mcp_servers)
    ? config.mcp_servers as Record<string, unknown>
    : {};
  if (equalEntry(servers.knowl, entry)) return 'unchanged';
  const status: MergeStatus = servers.knowl === undefined ? 'configured' : 'updated';
  config.mcp_servers = { ...servers, knowl: entry };
  await writeWithBackup(configPath, stringify(config), existing);
  return status;
}
