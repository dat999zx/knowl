import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'smol-toml';
import { mergeCodexTomlConfig, mergeJsonMcpConfig } from '../../src/cli/agents/files.js';

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
