import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'smol-toml';
import { Document, parseDocument } from 'yaml';
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
  const config = existing === undefined ? {} as Record<string, unknown> : JSON.parse(existing) as Record<string, unknown>;
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

/**
 * A user-owned YAML file as a `yaml` Document, so comments, ordering and tags survive a merge.
 *
 * dsh keeps `cwd: !!js process.cwd()` in its patch rows and Hermes users annotate their
 * `config.yaml`; parse-to-object-and-stringify would erase both. A parse error is thrown, not
 * swallowed: the adapter reports it and leaves the file exactly as it found it.
 *
 * What does NOT survive, measured against Hermes' 2,147-line commented template on 2026-09-03:
 * comment blocks are re-indented to their neighbouring node and the two-space gap before an
 * inline comment collapses to one. Every comment line is still there (1,883 of 1,883), which is
 * more than the host's own `hermes config set` keeps -- that one drops them all.
 */
export async function readYamlDocument(configPath: string): Promise<Document | undefined> {
  const existing = await readTextIfExists(configPath);
  if (existing === undefined) return undefined;
  const doc = parseDocument(existing, { logLevel: 'silent' });
  if (doc.errors.length > 0) throw new Error(`${configPath}: ${doc.errors[0].message}`);
  return doc;
}

export async function mergeYamlDocument(
  configPath: string,
  mutate: (doc: Document) => boolean,
): Promise<MergeStatus> {
  const existing = await readTextIfExists(configPath);
  const doc = existing === undefined
    ? new Document({})
    : parseDocument(existing, { logLevel: 'silent' });
  if (doc.errors.length > 0) throw new Error(`${configPath}: ${doc.errors[0].message}`);
  if (!mutate(doc)) return 'unchanged';
  // The Document keeps every comment but re-indents comment blocks and emits LF. On a CRLF file
  // that produced MIXED endings (CRLF inside retained comments, LF between nodes), which is the
  // one outcome worse than either: keep the file's own convention throughout.
  // ponytail: comment re-indentation is accepted; a byte-preserving splice on node ranges is the
  // upgrade if a user's tracked config.yaml diff ever matters more than shipping.
  const output = doc.toString().replace(/\r?\n/g, existing?.includes('\r\n') ? '\r\n' : '\n');
  await writeWithBackup(configPath, output, existing);
  return existing === undefined ? 'configured' : 'updated';
}

/**
 * The installed package root, found by walking up from this module.
 *
 * The bundle puts every module in `dist/`, and vitest runs this from `src/cli/agents/`, so a
 * fixed `..` count is wrong in one of the two. The shipped plugins under `integrations/` are
 * addressed from here.
 */
export function packageRootDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (fsSync.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Knowl package root not found.');
    dir = parent;
  }
}
