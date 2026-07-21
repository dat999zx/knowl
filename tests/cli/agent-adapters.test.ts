import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'smol-toml';
import { mergeCodexTomlConfig, mergeJsonMcpConfig } from '../../src/cli/agents/files.js';
import { createClaudeCodeAdapter, createCodexAdapter } from '../../src/cli/agents/project-adapters.js';
import { createCursorAdapter } from '../../src/cli/agents/cursor.js';
import { createClaudeDesktopAdapter } from '../../src/cli/agents/desktop-adapter.js';
import { knowlHookCommand } from '../../src/cli/agents/hook-config.js';
import { parseAgentNames } from '../../src/cli/agents/registry.js';

const ROOT = path.resolve('.knowl-agent-adapters-test');
const configPath = path.join(ROOT, 'mcp.json');
const writeJson = (filePath: string, value: unknown) => fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
const readJson = async (filePath: string) => JSON.parse(await fs.readFile(filePath, 'utf8'));

const collectHookCommands = (...configs: Array<Record<string, any>>) => {
  const commands: string[] = [];
  const walk = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.command === 'string') commands.push(record.command);
    for (const entry of Object.values(record)) walk(entry);
  };
  for (const config of configs) walk(config);
  return commands;
};

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
    expect(config.mcp_servers.knowl.args).toEqual(['serve']);
    expect(await adapter.verify(PROJECT)).toBe(true);
  });

  it('configures Claude Code and Cursor in project JSON configs', async () => {
    const claude = createClaudeCodeAdapter(environment);
    const cursor = createCursorAdapter(environment);
    await claude.configure(PROJECT);
    await cursor.configure(PROJECT);
    expect((await readJson(path.join(PROJECT, '.mcp.json'))).mcpServers.knowl.command).toBe('knowl.cmd');
    expect((await readJson(path.join(PROJECT, '.mcp.json'))).mcpServers.knowl.args).toEqual(['serve']);
    expect((await readJson(path.join(PROJECT, '.cursor', 'mcp.json'))).mcpServers.knowl.command).toBe('knowl.cmd');
  });

  it('configures and verifies Claude native instructions separately from MCP', async () => {
    const claude = createClaudeCodeAdapter(environment);
    await fs.mkdir(PROJECT, { recursive: true });
    await fs.writeFile(path.join(PROJECT, 'CLAUDE.md'), 'Claude rules stay.\n');
    expect(await claude.configureInstructions!(PROJECT)).toMatchObject({ status: 'updated' });
    expect(await fs.readFile(path.join(PROJECT, 'CLAUDE.md'), 'utf8')).toContain('@KNOWL.md');
    expect(await fs.readFile(path.join(PROJECT, 'CLAUDE.md'), 'utf8')).toContain('Claude rules stay.');
    expect(await claude.verifyInstructions!(PROJECT)).toBe(true);
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

  it('configures verified project-local lifecycle hooks for Codex, Claude Code, and Cursor', async () => {
    const codex = createCodexAdapter(environment);
    const claude = createClaudeCodeAdapter(environment);
    const cursor = createCursorAdapter(environment);

    expect(await codex.lifecycleCapability(PROJECT)).toBe('supported');
    expect(await claude.lifecycleCapability(PROJECT)).toBe('supported');
    expect(await cursor.lifecycleCapability(PROJECT)).toBe('supported');

    await fs.mkdir(path.join(PROJECT, '.codex'), { recursive: true });
    await fs.mkdir(path.join(PROJECT, '.claude'), { recursive: true });
    await fs.mkdir(path.join(PROJECT, '.cursor'), { recursive: true });
    await writeJson(path.join(PROJECT, '.codex', 'hooks.json'), { hooks: { Stop: [{ matcher: 'existing', hooks: [{ type: 'command', command: 'existing' }] }] } });
    await writeJson(path.join(PROJECT, '.claude', 'settings.local.json'), { permissions: { allow: ['Bash(npm test)'] } });
    await writeJson(path.join(PROJECT, '.cursor', 'hooks.json'), { version: 1, hooks: { afterFileEdit: [{ command: 'existing' }] } });

    expect(await codex.configureLifecycle(PROJECT)).toMatchObject({ agent: 'codex', status: 'configured' });
    expect(await claude.configureLifecycle(PROJECT)).toMatchObject({ agent: 'claude', status: 'configured' });
    expect(await cursor.configureLifecycle(PROJECT)).toMatchObject({ agent: 'cursor', status: 'configured' });

    const codexHooks = await readJson(path.join(PROJECT, '.codex', 'hooks.json'));
    const claudeSettings = await readJson(path.join(PROJECT, '.claude', 'settings.local.json'));
    const cursorHooks = await readJson(path.join(PROJECT, '.cursor', 'hooks.json'));
    expect(codexHooks.hooks.Stop[0].hooks[0].command).toBe('existing');
    expect(JSON.stringify(codexHooks)).toContain('knowl.cmd agent-hook codex SessionStart --json');
    expect(codexHooks.hooks.SessionStart[0].matcher).toBe('.*');
    expect(codexHooks.hooks.UserPromptSubmit).toBeUndefined();
    expect(claudeSettings.permissions.allow).toEqual(['Bash(npm test)']);
    expect(JSON.stringify(claudeSettings)).toContain('knowl.cmd agent-hook claude SessionStart --json');
    expect(claudeSettings.hooks.SessionStart[0].matcher).toBe('.*');
    expect(cursorHooks.hooks.afterFileEdit[0].command).toBe('existing');
    expect(JSON.stringify(cursorHooks)).toContain('knowl.cmd agent-hook cursor sessionStart --json');

    expect(JSON.stringify(codexHooks.hooks.PostToolUse)).not.toContain('Updating Knowl memory');
    expect(JSON.stringify(claudeSettings.hooks.PostToolUse)).not.toContain('Updating Knowl memory');
    expect(JSON.stringify(codexHooks.hooks.Stop)).not.toContain('Updating Knowl memory');
    expect(JSON.stringify(codexHooks.hooks.SessionStart)).not.toContain('Updating Knowl memory');
    expect(JSON.stringify(codexHooks.hooks.SessionStart)).toContain('Loading Knowl memory');
    expect(codexHooks.hooks.PostToolUse.at(-1).hooks[0].statusMessage).toBe('');
    expect(codexHooks.hooks.Stop.at(-1).hooks[0].statusMessage).toBe('');
    expect(codexHooks.hooks.SessionStart.at(-1).hooks[0].statusMessage).toBe('Loading Knowl memory');
    expect(claudeSettings.hooks.PostToolUse.at(-1).hooks[0].statusMessage).toBe('');
    expect(knowlHookCommand('win32', 'claude', 'PostToolUse')).toBe('knowl.cmd agent-hook claude PostToolUse --json');
    expect(knowlHookCommand('win32', 'claude', 'PostToolUse')).not.toContain('serve');
    const knowlHookCommands = collectHookCommands(codexHooks, claudeSettings, cursorHooks)
      .filter(command => command.includes('agent-hook') || command.includes('knowl'));
    expect(knowlHookCommands.length).toBeGreaterThan(0);
    for (const command of knowlHookCommands) {
      expect(command).toContain('agent-hook');
      expect(command).not.toContain('serve');
    }

    expect(await codex.verifyLifecycle(PROJECT)).toBe(true);
    expect(await claude.verifyLifecycle(PROJECT)).toBe(true);
    expect(await cursor.verifyLifecycle(PROJECT)).toBe(true);
    expect((await codex.configureLifecycle(PROJECT)).status).toBe('unchanged');
    expect((await claude.configureLifecycle(PROJECT)).status).toBe('unchanged');
    expect((await cursor.configureLifecycle(PROJECT)).status).toBe('unchanged');

    await expect(fs.access(path.join(PROJECT, '.codex', 'hooks.json.backup'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(PROJECT, '.claude', 'settings.local.json.backup'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(PROJECT, '.cursor', 'hooks.json.backup'))).resolves.toBeUndefined();
  });

  it('removes retired Knowl prompt hooks while preserving user hooks', async () => {
    const codex = createCodexAdapter(environment);
    const claude = createClaudeCodeAdapter(environment);
    const cursor = createCursorAdapter(environment);
    await fs.mkdir(path.join(PROJECT, '.codex'), { recursive: true });
    await fs.mkdir(path.join(PROJECT, '.claude'), { recursive: true });
    await fs.mkdir(path.join(PROJECT, '.cursor'), { recursive: true });
    await writeJson(path.join(PROJECT, '.codex', 'hooks.json'), { hooks: { UserPromptSubmit: [
      { matcher: '.*', hooks: [{ type: 'command', command: 'knowl.cmd agent-hook codex UserPromptSubmit --json' }] },
      { matcher: '.*', hooks: [{ type: 'command', command: 'user-hook' }] },
    ] } });
    await writeJson(path.join(PROJECT, '.claude', 'settings.local.json'), { hooks: { UserPromptSubmit: [
      { matcher: '.*', hooks: [{ type: 'command', command: 'knowl.cmd agent-hook claude UserPromptSubmit --json' }] },
      { matcher: '.*', hooks: [{ type: 'command', command: 'user-hook' }] },
    ] } });
    await writeJson(path.join(PROJECT, '.cursor', 'hooks.json'), { version: 1, hooks: { beforeSubmitPrompt: [
      { command: 'knowl.cmd agent-hook cursor beforeSubmitPrompt --json' },
      { command: 'user-hook' },
    ] } });

    await codex.configureLifecycle(PROJECT);
    await claude.configureLifecycle(PROJECT);
    await cursor.configureLifecycle(PROJECT);

    const codexHooks = await readJson(path.join(PROJECT, '.codex', 'hooks.json'));
    const claudeHooks = await readJson(path.join(PROJECT, '.claude', 'settings.local.json'));
    const cursorHooks = await readJson(path.join(PROJECT, '.cursor', 'hooks.json'));
    expect(codexHooks.hooks.UserPromptSubmit).toEqual([{ matcher: '.*', hooks: [{ type: 'command', command: 'user-hook' }] }]);
    expect(claudeHooks.hooks.UserPromptSubmit).toEqual([{ matcher: '.*', hooks: [{ type: 'command', command: 'user-hook' }] }]);
    expect(cursorHooks.hooks.beforeSubmitPrompt).toEqual([{ command: 'user-hook' }]);
  });

  it('keeps Claude Desktop lifecycle unsupported and rejects partial hook configuration', async () => {
    const desktop = createClaudeDesktopAdapter(environment);
    expect(await desktop.lifecycleCapability(PROJECT)).toBe('unsupported');
    expect(await desktop.configureLifecycle(PROJECT)).toMatchObject({ agent: 'claude-desktop', status: 'skipped' });
    expect(await desktop.verifyLifecycle(PROJECT)).toBe(false);

    const codex = createCodexAdapter(environment);
    await fs.mkdir(path.join(PROJECT, '.codex'), { recursive: true });
    await writeJson(path.join(PROJECT, '.codex', 'hooks.json'), {
      hooks: { SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: 'knowl.cmd agent-hook codex SessionStart --json' }] }] },
    });
    expect(await codex.verifyLifecycle(PROJECT)).toBe(false);
  });
});
