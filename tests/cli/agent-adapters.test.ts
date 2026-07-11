import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'smol-toml';
import { mergeCodexTomlConfig, mergeJsonMcpConfig } from '../../src/cli/agents/files.js';
import { createClaudeCodeAdapter, createCodexAdapter } from '../../src/cli/agents/project-adapters.js';
import { createCursorAdapter } from '../../src/cli/agents/cursor.js';
import { createClaudeDesktopAdapter } from '../../src/cli/agents/desktop-adapter.js';
import { parseAgentNames } from '../../src/cli/agents/registry.js';

const ROOT = path.resolve('.knowl-agent-adapters-test');
const configPath = path.join(ROOT, 'mcp.json');
const writeJson = (filePath: string, value: unknown) => fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
const readJson = async (filePath: string) => JSON.parse(await fs.readFile(filePath, 'utf8'));

afterEach(async () => fs.rm(ROOT, { recursive: true, force: true }));

describe('agent configuration files', () => {
  it('preserves unrelated JSON MCP servers and creates a backup', async () => {
    await fs.mkdir(ROOT, { recursive: true });
    await writeJson(configPath, { mcpServers: { existing: { command: 'existing' } } });
    await mergeJsonMcpConfig(configPath, { command: 'knowl', args: ['serve'] });
    const saved = await readJson(configPath);
    expect(saved.mcpServers.existing.command).toBe('existing');
    expect(saved.mcpServers.knowl).toEqual({ command: 'knowl', args: ['serve'] });
    await expect(fs.access(`${configPath}.backup`)).resolves.toBeUndefined();
  });

  it('does not rewrite an unchanged JSON MCP entry', async () => {
    await fs.mkdir(ROOT, { recursive: true });
    await writeJson(configPath, { mcpServers: { knowl: { command: 'knowl', args: ['serve'] } } });
    const before = await fs.readFile(configPath, 'utf8');
    expect(await mergeJsonMcpConfig(configPath, { command: 'knowl', args: ['serve'] })).toBe('unchanged');
    expect(await fs.readFile(configPath, 'utf8')).toBe(before);
  });

  it('preserves unrelated Codex TOML sections', async () => {
    await fs.mkdir(ROOT, { recursive: true });
    await fs.writeFile(configPath, 'model = "test-model"\n[mcp_servers.other]\ncommand = "other"\n', 'utf8');
    await mergeCodexTomlConfig(configPath, { command: 'knowl', args: ['serve'] });
    const saved = parse(await fs.readFile(configPath, 'utf8')) as Record<string, any>;
    expect(saved.model).toBe('test-model');
    expect(saved.mcp_servers.other.command).toBe('other');
    expect(saved.mcp_servers.knowl.args).toEqual(['serve']);
  });

  it('rejects malformed config without overwriting it', async () => {
    await fs.mkdir(ROOT, { recursive: true });
    await fs.writeFile(configPath, '{broken', 'utf8');
    await expect(mergeJsonMcpConfig(configPath, { command: 'knowl', args: ['serve'] })).rejects.toThrow();
    expect(await fs.readFile(configPath, 'utf8')).toBe('{broken');
  });
});

describe('agent adapters', () => {
  const HOME = path.join(ROOT, 'home');
  const PROJECT = path.join(ROOT, 'project');
  const environment = {
    platform: 'win32' as NodeJS.Platform,
    homeDir: HOME,
    appDataDir: path.join(HOME, 'AppData', 'Roaming'),
    commandExists: async (command: string) => ['codex', 'claude', 'cursor'].includes(command),
  };

  it('configures Codex in the project TOML config', async () => {
    const adapter = createCodexAdapter(environment);
    expect((await adapter.detect(PROJECT)).installed).toBe(true);
    await adapter.configure(PROJECT);
    const config = parse(await fs.readFile(path.join(PROJECT, '.codex', 'config.toml'), 'utf8')) as Record<string, any>;
    expect(config.mcp_servers.knowl.command).toBe('knowl.cmd');
    expect(await adapter.verify(PROJECT)).toBe(true);
  });

  it('configures Claude Code and Cursor in project JSON configs', async () => {
    const claude = createClaudeCodeAdapter(environment);
    const cursor = createCursorAdapter(environment);
    await claude.configure(PROJECT);
    await cursor.configure(PROJECT);
    expect((await readJson(path.join(PROJECT, '.mcp.json'))).mcpServers.knowl.command).toBe('knowl.cmd');
    expect((await readJson(path.join(PROJECT, '.cursor', 'mcp.json'))).mcpServers.knowl.command).toBe('knowl.cmd');
  });

  it('marks Claude Desktop as global and writes its platform config', async () => {
    const adapter = createClaudeDesktopAdapter(environment);
    expect((await adapter.detect(PROJECT)).scope).toBe('global');
    await adapter.configure(PROJECT);
    const desktopPath = path.join(HOME, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json');
    expect((await readJson(desktopPath)).mcpServers.knowl.command).toBe('knowl.cmd');
  });

  it('deduplicates agent names and rejects unsupported names', () => {
    expect(parseAgentNames(['codex', 'claude', 'codex'])).toEqual(['codex', 'claude']);
    expect(() => parseAgentNames(['unknown'])).toThrow('Unsupported agent "unknown"');
  });
});
