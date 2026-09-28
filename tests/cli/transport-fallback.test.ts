import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import { mergeHookConfig } from '../../src/cli/agents/hook-config.js';
import { checkMcpTransport } from '../../src/cli/agents/transport-fallback.js';
import { HOOK_TOOL_NAME } from '../../src/core/hooks-transport.js';

/**
 * A host drops an `mcp_tool` hook quietly when the server it names is not connected, so session
 * start -- always a command hook -- is where Knowl notices the server is missing and falls back.
 */
const dirs: string[] = [];
const scratch = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'knowl-transport-fallback-'));
  dirs.push(dir);
  return dir;
};

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function claudeRepo(mcpServers: Record<string, unknown>) {
  const root = await scratch();
  const home = await scratch();
  const hooks = path.join(root, '.claude', 'settings.local.json');
  await mergeHookConfig(hooks, process.platform, 'claude', { transport: 'mcp' });
  await writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers }));
  return { root, home, hooks };
}

describe('checkMcpTransport', () => {
  it('rewrites mcp hooks to command hooks when the knowl server is not registered', async () => {
    const { root, home, hooks } = await claudeRepo({ other: { command: 'x' } });
    expect(await readFile(hooks, 'utf8')).toContain(HOOK_TOOL_NAME);

    const notice = await checkMcpTransport(root, 'claude', home);

    expect(notice).toBe('Knowl hooks fell back to command: the knowl MCP server is not registered for claude. Run knowl init claude to restore it.');
    expect(await readFile(hooks, 'utf8')).not.toContain(HOOK_TOOL_NAME);
    expect(await readFile(hooks, 'utf8')).toContain('agent-hook claude');
  });

  it('leaves hooks alone when the server is registered in the project', async () => {
    const { root, home, hooks } = await claudeRepo({ knowl: { command: 'knowl', args: ['serve'] } });
    expect(await checkMcpTransport(root, 'claude', home)).toBeNull();
    expect(await readFile(hooks, 'utf8')).toContain(HOOK_TOOL_NAME);
  });

  it('leaves hooks alone when the server is registered for the user instead', async () => {
    const { root, home, hooks } = await claudeRepo({});
    await writeFile(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { knowl: { command: 'knowl' } } }));
    expect(await checkMcpTransport(root, 'claude', home)).toBeNull();
    expect(await readFile(hooks, 'utf8')).toContain(HOOK_TOOL_NAME);
  });

  it('finds a local-scope server whatever the separators and drive-letter case of the project key', async () => {
    const { root, home, hooks } = await claudeRepo({});
    let key = root.replace(/\\/g, '/');
    if (process.platform === 'win32') key = key[0] === key[0].toLowerCase() ? key[0].toUpperCase() + key.slice(1) : key[0].toLowerCase() + key.slice(1);
    await writeFile(path.join(home, '.claude.json'), JSON.stringify({ projects: { [key]: { mcpServers: { knowl: { command: 'knowl' } } } } }));
    expect(await checkMcpTransport(root, 'claude', home)).toBeNull();
    expect(await readFile(hooks, 'utf8')).toContain(HOOK_TOOL_NAME);
  });

  it('checks Codex against its TOML config', async () => {
    const root = await scratch();
    const home = await scratch();
    const hooks = path.join(root, '.codex', 'hooks.json');
    await mergeHookConfig(hooks, process.platform, 'codex', { transport: 'mcp' });
    await mkdir(path.join(root, '.codex'), { recursive: true });
    await writeFile(path.join(root, '.codex', 'config.toml'), '[mcp_servers.knowl]\ncommand = "knowl"\n');
    expect(await checkMcpTransport(root, 'codex', home)).toBeNull();

    await writeFile(path.join(root, '.codex', 'config.toml'), '');
    expect(await checkMcpTransport(root, 'codex', home)).toMatch(/not registered for codex/);
    expect(await readFile(hooks, 'utf8')).not.toContain(HOOK_TOOL_NAME);
  });

  it('skips hosts that never get mcp hooks, and repos without a hooks file', async () => {
    const root = await scratch();
    const home = await scratch();
    expect(await checkMcpTransport(root, 'cursor', home)).toBeNull();
    expect(await checkMcpTransport(root, 'claude', home)).toBeNull();
  });
});
