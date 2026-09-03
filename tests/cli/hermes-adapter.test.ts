import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHermesAdapter, hermesHomeDir } from '../../src/cli/agents/hermes.js';
import { parseAgentNames } from '../../src/cli/agents/registry.js';

const dirs: string[] = [];
const workspace = async () => { const d = await mkdtemp(path.join(tmpdir(), 'knowl-hermes-')); dirs.push(d); return d; };
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

const EVENTS = ['on_session_start', 'pre_llm_call', 'pre_tool_call', 'post_tool_call', 'pre_verify', 'on_session_end', 'on_session_finalize'];

describe('hermes adapter', () => {
  let home: string;
  const saved = process.env.HERMES_HOME;
  beforeEach(async () => { home = await workspace(); process.env.HERMES_HOME = home; });
  afterEach(() => { if (saved === undefined) delete process.env.HERMES_HOME; else process.env.HERMES_HOME = saved; });

  const env = (installed: boolean, platform: NodeJS.Platform = 'linux') =>
    ({ platform, homeDir: '/nowhere', appDataDir: '/nowhere', commandExists: async () => installed });
  const config = async () => parse(await readFile(path.join(home, 'config.yaml'), 'utf8')) as Record<string, any>;

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

  it('writes the MCP server and one shell hook per event into a fresh config.yaml', async () => {
    const adapter = createHermesAdapter(env(true));
    const result = await adapter.configure('/repo');
    expect(result.status).toBe('configured');
    expect(result.scope).toBe('global');
    expect(result.message).toContain('/reload-mcp');
    const saved = await config();
    expect(saved.mcp_servers.knowl).toEqual({ command: 'knowl', args: ['serve', '--host', 'hermes'] });
    expect(Object.keys(saved.hooks).sort()).toEqual([...EVENTS].sort());
    for (const event of EVENTS) {
      expect(saved.hooks[event], event).toHaveLength(1);
      expect(saved.hooks[event][0].command, event).toBe(`knowl agent-hook hermes ${event} --json`);
      expect(saved.hooks[event][0].timeout, event).toBe(30);
    }
    // The write-tool matcher keeps Hermes from spawning a process for every read.
    expect(saved.hooks.pre_tool_call[0].matcher).toBe('write_file|patch');
    expect(saved.hooks.post_tool_call[0].matcher).toBeUndefined();
    expect(await adapter.verify('/repo')).toBe(true);
    expect(await adapter.verifyLifecycle!('/repo')).toBe(true);
    expect((await adapter.configureLifecycle!('/repo')).status).toBe('unchanged');
  });

  it('names knowl.cmd on Windows', async () => {
    await createHermesAdapter(env(true, 'win32')).configure('/repo');
    const saved = await config();
    expect(saved.mcp_servers.knowl.command).toBe('knowl.cmd');
    expect(saved.hooks.pre_verify[0].command).toBe('knowl.cmd agent-hook hermes pre_verify --json');
  });

  it('keeps comments, other keys and foreign hooks, and is idempotent', async () => {
    await writeFile(path.join(home, 'config.yaml'),
      '# hermes\nmodel: x\nmcp_servers:\n  other:\n    command: other\nhooks:\n  pre_tool_call:\n    - matcher: terminal\n      command: ~/.hermes/agent-hooks/block-rm-rf.sh\n      timeout: 10\n', 'utf8');
    const adapter = createHermesAdapter(env(true));
    expect((await adapter.configure('/repo')).status).toBe('updated');
    expect((await adapter.configure('/repo')).status).toBe('unchanged');
    const text = await readFile(path.join(home, 'config.yaml'), 'utf8');
    expect(text).toContain('# hermes');
    expect(text).toContain('model: x');
    const saved = parse(text) as Record<string, any>;
    expect(saved.mcp_servers.other.command).toBe('other');
    expect(saved.hooks.pre_tool_call).toHaveLength(2);
    expect(saved.hooks.pre_tool_call[0].command).toBe('~/.hermes/agent-hooks/block-rm-rf.sh');
    expect(saved.hooks.pre_tool_call[1].command).toBe('knowl agent-hook hermes pre_tool_call --json');
  });

  it('replaces a stale knowl entry in place rather than adding a second', async () => {
    await writeFile(path.join(home, 'config.yaml'),
      'hooks:\n  pre_tool_call:\n    - command: knowl agent-hook hermes pre_tool_call --json\n      timeout: 60\n', 'utf8');
    const adapter = createHermesAdapter(env(true));
    expect((await adapter.configure('/repo')).status).toBe('updated');
    const saved = await config();
    expect(saved.hooks.pre_tool_call).toHaveLength(1);
    expect(saved.hooks.pre_tool_call[0]).toEqual({ command: 'knowl agent-hook hermes pre_tool_call --json', matcher: 'write_file|patch', timeout: 30 });
  });

  it('is not configured while any event lacks our entry', async () => {
    const adapter = createHermesAdapter(env(true));
    await adapter.configure('/repo');
    const text = await readFile(path.join(home, 'config.yaml'), 'utf8');
    await writeFile(path.join(home, 'config.yaml'), text.replace(/ {2}pre_verify:\n(.*\n){3}/, ''), 'utf8');
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
});
