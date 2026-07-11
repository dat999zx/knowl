import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.knowl-onboarding-cli-test');
const CLI_PATH = path.resolve('./dist/index.js');

function run(...args: string[]) {
  return execFileSync(process.execPath, [CLI_PATH, ...args], { cwd: ROOT, encoding: 'utf8' });
}

describe('CLI onboarding', () => {
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(ROOT, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
  });

  it('initializes non-interactively with vector search enabled', async () => {
    run('init', '--yes');
    const config = JSON.parse(await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8'));
    expect(config.search.vector.enabled).toBe(true);
  });

  it('uses explicit config subcommands and rejects legacy positional syntax', () => {
    expect(run('config', 'get', 'search.vector.enabled').trim()).toBe('true');
    expect(run('config', 'set', 'search.vector.enabled', 'false')).toContain('Set search.vector.enabled = false');
    expect(run('config', 'reset', 'search.vector.enabled')).toContain('Reset search.vector.enabled');
    expect(() => run('config', 'search.vector.enabled', 'true')).toThrow(/Use `knowl config set <key> <value>`/);
  }, 10_000);

  it('removes the connect command', () => {
    expect(() => run('connect', 'codex')).toThrow(/unknown command 'connect'/);
  });
});
