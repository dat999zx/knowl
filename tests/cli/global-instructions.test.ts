import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GLOBAL_BLOCK, GLOBAL_BLOCK_END, GLOBAL_BLOCK_START, globalInstructionHosts, globalInstructionPath,
  globalInstructionsCurrent, installGlobalInstructions,
} from '../../src/cli/agents/global-instructions.js';

describe('global instruction files', () => {
  let home = '';
  beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-ginstr-')); });
  afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });
  const file = (host: Parameters<typeof globalInstructionPath>[0]) => globalInstructionPath(host, home)!;

  it('tells the model to use Knowl together with the host memory on every task, not just questions about the person', () => {
    expect(GLOBAL_BLOCK).toContain('together with any built-in memory');
    expect(GLOBAL_BLOCK).toContain('every task or question');
    expect(GLOBAL_BLOCK.length).toBeLessThan(900);
  });

  it('creates the file, with its folders, when the host has none', async () => {
    const result = await installGlobalInstructions('windsurf', home);
    expect(result?.status).toBe('configured');
    const text = await fs.readFile(file('windsurf'), 'utf8');
    expect(text).toContain('knowl_query');
    expect(text.length).toBeLessThan(6000); // Windsurf's global_rules.md cap
  });

  it('keeps what the person wrote, keeps a backup, and is idempotent', async () => {
    await fs.mkdir(path.dirname(file('claude')), { recursive: true });
    await fs.writeFile(file('claude'), '# mine\n\nAlways answer in English.\n', 'utf8');

    expect((await installGlobalInstructions('claude', home))?.status).toBe('updated');
    const after = await fs.readFile(file('claude'), 'utf8');
    expect(after).toContain('Always answer in English.');
    expect(after.indexOf('# mine')).toBe(0);
    expect(await fs.readFile(`${file('claude')}.backup`, 'utf8')).toBe('# mine\n\nAlways answer in English.\n');

    expect((await installGlobalInstructions('claude', home))?.status).toBe('unchanged');
    expect(await globalInstructionsCurrent('claude', home)).toBe(true);
  });

  it('replaces only the text between its own markers when the block is stale', async () => {
    await fs.mkdir(path.dirname(file('codex')), { recursive: true });
    await fs.writeFile(file('codex'), `before\n\n${GLOBAL_BLOCK_START}\nold wording\n${GLOBAL_BLOCK_END}\n\nafter\n`, 'utf8');

    expect(await globalInstructionsCurrent('codex', home)).toBe(false);
    await installGlobalInstructions('codex', home);

    const text = await fs.readFile(file('codex'), 'utf8');
    expect(text).not.toContain('old wording');
    expect(text.startsWith('before\n')).toBe(true);
    expect(text.trimEnd().endsWith('after')).toBe(true);
    expect(text.split(GLOBAL_BLOCK_START)).toHaveLength(2);
  });

  it('writes in the line endings the file already uses', async () => {
    await fs.mkdir(path.dirname(file('antigravity')), { recursive: true });
    await fs.writeFile(file('antigravity'), 'one\r\ntwo\r\n', 'utf8');
    await installGlobalInstructions('antigravity', home);
    const text = await fs.readFile(file('antigravity'), 'utf8');
    expect(text.replaceAll('\r\n', '')).not.toContain('\n');
  });

  it('names only hosts with a documented file, and skips the rest instead of guessing', async () => {
    expect(globalInstructionHosts().sort()).toEqual(['antigravity', 'claude', 'codex', 'windsurf']);
    expect(await installGlobalInstructions('cursor', home)).toBeUndefined();
    expect(await globalInstructionsCurrent('cursor', home)).toBeUndefined();
  });
});

describe('knowl init --global <host>', () => {
  let base = '';
  beforeEach(async () => { base = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-ginit-')); });
  afterEach(async () => { await fs.rm(base, { recursive: true, force: true }); });

  const run = (args: string[]) => spawnSync(process.execPath, [path.resolve('./dist/index.js'), ...args], {
    cwd: base, encoding: 'utf-8',
    // HOME/USERPROFILE point at the scratch dir so the file written is the scratch one, never the developer's.
    env: { ...process.env, KNOWL_HOME: path.join(base, 'kh'), HOME: base, USERPROFILE: base, KNOWL_NO_UPDATE_CHECK: '1', HERMES_HOME: path.join(base, 'hh') },
  });

  it('writes the host file only with --yes, and names a host it cannot write for', async () => {
    const target = path.join(base, '.codex', 'AGENTS.md');

    const declined = run(['init', '--global', 'codex']);
    expect(declined.stdout).toContain('left alone');
    await expect(fs.access(target)).rejects.toMatchObject({ code: 'ENOENT' });

    const yes = run(['init', '--global', 'codex', '-y']);
    expect(yes.stdout).toMatch(/codex: configured/);
    expect(await fs.readFile(target, 'utf8')).toContain(GLOBAL_BLOCK_START);

    expect(run(['init', '--global', 'cursor', '-y']).stdout).toMatch(/cursor: no documented global instruction file/);
  });
});
