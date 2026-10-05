import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The `initialize` card is the only text a session with no project can be told anything by: no
 * repository means no AGENTS.md. It used to say "for project work" and nothing else, so an agent in
 * a folder-less session was never told what the tools were for. Driven through the real server,
 * because the SDK captures the string at construction and no unit of the builder can show that it
 * reached the wire.
 */
const CLI = path.resolve('./dist/index.js');

function handshake(cwd: string, home: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'serve', '--host', 'claude'], {
      cwd, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, KNOWL_HOME: home, KNOWL_NO_UPDATE_CHECK: '1' },
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error('no initialize response')); }, 25_000);
    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const line = buffer.split('\n').find(entry => entry.includes('"id":1'));
      if (!line) return;
      clearTimeout(timer);
      child.kill();
      resolve(JSON.parse(line).result.instructions ?? '');
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } })}\n`);
  });
}

describe('the initialize card with no project', () => {
  let home = '';
  let nowhere = '';
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-gcard-home-'));
    nowhere = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-gcard-none-'));
  });
  afterEach(async () => {
    for (const dir of [home, nowhere]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('says what the tools are for when only the machine-wide store answers', async () => {
    const { spawnSync } = await import('node:child_process');
    spawnSync(process.execPath, [CLI, 'init', '--global', '-y'], { cwd: nowhere, env: { ...process.env, KNOWL_HOME: home } });

    const card = await handshake(nowhere, home);

    expect(card).toContain('KNOWL WORKFLOW');
    expect(card).toMatch(/no project is open/);
    expect(card).toContain('personal-defaults');
  });
});
