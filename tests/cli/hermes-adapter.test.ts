import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHermesAdapter, hermesHomeDir, hermesPluginSourceDir } from '../../src/cli/agents/hermes.js';
import { parseAgentNames } from '../../src/cli/agents/registry.js';

const dirs: string[] = [];
const workspace = async () => { const d = await mkdtemp(path.join(tmpdir(), 'knowl-hermes-')); dirs.push(d); return d; };
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

describe('hermes adapter', () => {
  let home: string;
  const saved = process.env.HERMES_HOME;
  beforeEach(async () => { home = await workspace(); process.env.HERMES_HOME = home; });
  afterEach(() => { if (saved === undefined) delete process.env.HERMES_HOME; else process.env.HERMES_HOME = saved; });

  const env = (installed: boolean, platform: NodeJS.Platform = 'linux') =>
    ({ platform, homeDir: '/nowhere', appDataDir: '/nowhere', commandExists: async () => installed });
  const config = async () => parse(await readFile(path.join(home, 'config.yaml'), 'utf8')) as Record<string, any>;
  const pluginFile = (name: string) => path.join(home, 'plugins', 'knowl', name);

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

  it('copies the plugin, enables it, and writes the MCP server', async () => {
    const adapter = createHermesAdapter(env(true));
    const result = await adapter.configure('/repo');
    expect(result.status).toBe('configured');
    expect(result.scope).toBe('global');
    expect(result.message).toContain('Restart Hermes');

    const saved = await config();
    expect(saved.mcp_servers.knowl).toEqual({ command: 'knowl', args: ['serve', '--host', 'hermes'] });
    expect(saved.plugins.enabled).toContain('knowl');
    // The plugin is the whole lifecycle now; nothing writes hook commands.
    expect(saved.hooks).toBeUndefined();

    expect(await readFile(pluginFile('__init__.py'), 'utf8')).toContain('agent-hook');
    expect(await readFile(pluginFile('plugin.yaml'), 'utf8')).toContain('name: knowl');
    expect(await adapter.verify('/repo')).toBe(true);
    expect(await adapter.verifyLifecycle!('/repo')).toBe(true);
    expect((await adapter.configureLifecycle!('/repo')).status).toBe('unchanged');
  });

  it('removes the shell hooks an earlier version wrote, keeping the user\'s own', async () => {
    await writeFile(path.join(home, 'config.yaml'), [
      '# hermes',
      'hooks:',
      '  pre_tool_call:',
      '    - command: knowl agent-hook hermes pre_tool_call --json',
      '      matcher: write_file|patch',
      '      timeout: 30',
      '    - command: ~/.hermes/agent-hooks/block-rm-rf.sh',
      '      matcher: terminal',
      '  pre_verify:',
      '    - command: knowl.cmd agent-hook hermes pre_verify --json',
      '      timeout: 30',
      '',
    ].join('\n'), 'utf8');

    expect((await createHermesAdapter(env(true)).configure('/repo')).status).toBe('updated');
    const text = await readFile(path.join(home, 'config.yaml'), 'utf8');
    expect(text).toContain('# hermes');
    expect(text).not.toContain('agent-hook hermes');

    const saved = parse(text) as Record<string, any>;
    // The person's own hook survives; the event we emptied is gone rather than left blank.
    expect(saved.hooks.pre_tool_call).toHaveLength(1);
    expect(saved.hooks.pre_tool_call[0].command).toBe('~/.hermes/agent-hooks/block-rm-rf.sh');
    expect(saved.hooks.pre_verify).toBeUndefined();
  });

  it('drops the hooks key entirely when every entry in it was ours', async () => {
    await writeFile(path.join(home, 'config.yaml'),
      'model: x\nhooks:\n  pre_verify:\n    - command: knowl agent-hook hermes pre_verify --json\n', 'utf8');
    await createHermesAdapter(env(true)).configure('/repo');
    const saved = await config();
    expect(saved.model).toBe('x');
    expect(saved.hooks).toBeUndefined();
  });

  it('keeps comments, other keys and other plugins, and is idempotent', async () => {
    await writeFile(path.join(home, 'config.yaml'),
      '# hermes\nmodel: x\nmcp_servers:\n  other:\n    command: other\nplugins:\n  enabled:\n    - other\n  disabled:\n    - knowl\n', 'utf8');
    const adapter = createHermesAdapter(env(true));
    expect((await adapter.configure('/repo')).status).toBe('updated');
    expect((await adapter.configure('/repo')).status).toBe('unchanged');

    const text = await readFile(path.join(home, 'config.yaml'), 'utf8');
    expect(text).toContain('# hermes');
    expect(text).toContain('model: x');
    const saved = parse(text) as Record<string, any>;
    expect(saved.mcp_servers.other.command).toBe('other');
    expect(saved.plugins.enabled).toEqual(['other', 'knowl']);
    expect(saved.plugins.disabled).toEqual([]);
    expect((await adapter.detect('/repo')).configured).toBe(true);
  });

  it('names knowl.cmd on Windows', async () => {
    await createHermesAdapter(env(true, 'win32')).configure('/repo');
    expect((await config()).mcp_servers.knowl.command).toBe('knowl.cmd');
  });

  it('is not configured while the plugin is disabled or missing', async () => {
    const adapter = createHermesAdapter(env(true));
    await adapter.configure('/repo');
    expect((await adapter.detect('/repo')).configured).toBe(true);

    await rm(path.join(home, 'plugins', 'knowl'), { recursive: true, force: true });
    expect((await adapter.detect('/repo')).configured).toBe(false);
    expect(await adapter.verifyLifecycle!('/repo')).toBe(false);
    expect((await adapter.configureLifecycle!('/repo')).status).toBe('failed');
  });

  it('configures without hermes on PATH, since it never runs it', async () => {
    const adapter = createHermesAdapter(env(false));
    expect((await adapter.configure('/repo')).status).toBe('configured');
    expect((await adapter.detect('/repo')).installed).toBe(false);
    expect(await adapter.verify('/repo')).toBe(true);
  });

  it('reports an unparseable config.yaml and leaves it alone', async () => {
    await writeFile(path.join(home, 'config.yaml'), 'a: [\n', 'utf8');
    const adapter = createHermesAdapter(env(true));
    const result = await adapter.configure('/repo');
    expect(result.status).toBe('failed');
    expect(await readFile(path.join(home, 'config.yaml'), 'utf8')).toBe('a: [\n');
    expect((await adapter.detect('/repo')).configured).toBe(false);
  });

  it('ships the plugin sources the installer copies', async () => {
    expect(await readFile(path.join(hermesPluginSourceDir(), 'plugin.yaml'), 'utf8')).toContain('name: knowl');
  });
});
