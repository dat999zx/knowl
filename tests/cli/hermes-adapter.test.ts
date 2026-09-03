import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHermesAdapter, hermesHomeDir } from '../../src/cli/agents/hermes.js';
import { parseAgentNames } from '../../src/cli/agents/registry.js';

const dirs: string[] = [];
const workspace = async () => { const d = await mkdtemp(path.join(tmpdir(), 'knowl-hermes-')); dirs.push(d); return d; };
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

describe('hermes adapter', () => {
  let home: string;
  const saved = process.env.HERMES_HOME;
  beforeEach(async () => { home = await workspace(); process.env.HERMES_HOME = home; });
  afterEach(() => { if (saved === undefined) delete process.env.HERMES_HOME; else process.env.HERMES_HOME = saved; });

  const env = (installed: boolean) => ({ platform: 'linux' as const, homeDir: '/nowhere', appDataDir: '/nowhere', commandExists: async () => installed });

  it('resolves the home the way Hermes does: HERMES_HOME, else LOCALAPPDATA on Windows, else ~/.hermes', () => {
    const base = { appDataDir: '/nowhere', commandExists: async () => false };
    expect(hermesHomeDir({ ...base, platform: 'linux', homeDir: '/home/u' })).toBe(home);
    delete process.env.HERMES_HOME;
    expect(hermesHomeDir({ ...base, platform: 'linux', homeDir: '/home/u' })).toBe(path.join('/home/u', '.hermes'));
    const savedLocal = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = path.join('C:', 'Users', 'u', 'AppData', 'Local');
    expect(hermesHomeDir({ ...base, platform: 'win32', homeDir: 'C:/Users/u' })).toBe(path.join('C:', 'Users', 'u', 'AppData', 'Local', 'hermes'));
    delete process.env.LOCALAPPDATA;
    expect(hermesHomeDir({ ...base, platform: 'win32', homeDir: 'C:/Users/u' })).toBe(path.join('C:/Users/u', 'AppData', 'Local', 'hermes'));
    if (savedLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = savedLocal;
  });

  it('is a supported agent name', () => {
    expect(parseAgentNames(['hermes'])).toEqual(['hermes']);
  });

  it('copies the plugin, writes mcp_servers.knowl and enables the plugin', async () => {
    const calls: string[][] = [];
    const adapter = createHermesAdapter(env(true), { exec: async (f, a) => { calls.push([f, ...a]); } });
    const result = await adapter.configure('/repo');
    expect(result.status).toBe('configured');
    expect(result.scope).toBe('global');
    const config = await readFile(path.join(home, 'config.yaml'), 'utf8');
    expect(config).toContain('mcp_servers:\n  knowl:\n    command: knowl\n    args:\n      - serve\n      - --host\n      - hermes');
    const init = await readFile(path.join(home, 'plugins', 'knowl', '__init__.py'), 'utf8');
    expect(init).toContain('agent-hook');
    expect(await readFile(path.join(home, 'plugins', 'knowl', 'plugin.yaml'), 'utf8')).toContain('name: knowl');
    expect(calls).toEqual([['hermes', 'plugins', 'enable', 'knowl']]);
    expect(await adapter.verify('/repo')).toBe(true);
    expect(result.message).toContain('/reload-mcp');
  });

  it('keeps the rest of config.yaml and is idempotent', async () => {
    await writeFile(path.join(home, 'config.yaml'), '# hermes\nmodel: x\nmcp_servers:\n  other:\n    command: other\n', 'utf8');
    const adapter = createHermesAdapter(env(true), { exec: async () => {} });
    expect((await adapter.configure('/repo')).status).toBe('updated');
    expect((await adapter.configure('/repo')).status).toBe('unchanged');
    const config = await readFile(path.join(home, 'config.yaml'), 'utf8');
    expect(config).toContain('# hermes');
    expect(config).toContain('model: x');
    expect(config).toContain('other:\n    command: other');
  });

  it('prints the enable command when hermes is not on PATH', async () => {
    const adapter = createHermesAdapter(env(false), { exec: async () => { throw new Error('must not run'); } });
    const result = await adapter.configure('/repo');
    expect(result.status).toBe('configured');
    expect(result.message).toContain('hermes plugins enable knowl');
  });

  it('reports an unparseable config.yaml and leaves it alone', async () => {
    await writeFile(path.join(home, 'config.yaml'), 'a: [\n', 'utf8');
    const adapter = createHermesAdapter(env(true), { exec: async () => {} });
    const result = await adapter.configure('/repo');
    expect(result.status).toBe('failed');
    expect(await readFile(path.join(home, 'config.yaml'), 'utf8')).toBe('a: [\n');
  });
});
