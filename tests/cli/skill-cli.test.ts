import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TEST_DIR = path.join(os.tmpdir(), 'knowl-cli-skill-test');
const CLI_PATH = path.resolve('./dist/index.js');

describe('CLI learned skills', () => {
  afterAll(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it('should create, list, read, and run learned skill packages from the CLI', async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(TEST_DIR, { recursive: true });

    execSync(`node "${CLI_PATH}" init --yes`, {
      cwd: TEST_DIR,
      encoding: 'utf-8',
    });

    const createOutput = execFileSync(process.execPath, [
      CLI_PATH,
      'skill',
      'create',
      'run_app',
      '--purpose',
      'Start the app locally',
      '--markdown',
      '# Run App\n\nUse this to start the app.\n',
      '--file',
      "run.js=console.log('cli-skill-ok');\n",
      '--script',
      'run.js',
    ], {
      cwd: TEST_DIR,
      encoding: 'utf-8',
    });
    expect(createOutput).toContain('Created skill run_app');

    const listOutput = execSync(`node "${CLI_PATH}" skill list`, {
      cwd: TEST_DIR,
      encoding: 'utf-8',
    });
    expect(listOutput).toContain('run_app');
    expect(listOutput).toContain('Start the app locally');

    const readOutput = execSync(`node "${CLI_PATH}" skill read run_app`, {
      cwd: TEST_DIR,
      encoding: 'utf-8',
    });
    expect(readOutput).toContain('# Run App');
    expect(readOutput).toContain('"name": "run_app"');

    // Running is gated on a human approving these exact bytes, so the CLI flow has to include
    // it. Exercised through the real command rather than the module, because that command is
    // the whole interface a user has to this decision.
    const approveOutput = execSync(`node "${CLI_PATH}" skill approve run_app`, {
      cwd: TEST_DIR,
      encoding: 'utf-8',
    });
    expect(approveOutput).toContain('Approved skill "run_app"');
    expect(approveOutput).toMatch(/Hash: sha256:[0-9a-f]{64}/);

    const trustOutput = execSync(`node "${CLI_PATH}" skill trust`, {
      cwd: TEST_DIR,
      encoding: 'utf-8',
    });
    expect(trustOutput).toContain('run_app');

    const runOutput = execSync(`node "${CLI_PATH}" skill run run_app`, {
      cwd: TEST_DIR,
      encoding: 'utf-8',
    });
    expect(runOutput).toContain('cli-skill-ok');

    const stateOutput = execSync(`node "${CLI_PATH}" state`, {
      cwd: TEST_DIR,
      encoding: 'utf-8',
    });
    expect(stateOutput).toContain('run_app');

    const agents = await fs.readFile(path.join(TEST_DIR, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('knowl_skill_list');
    expect(agents).toContain('knowl_skill_read');
    expect(agents).toContain('knowl_skill_run');
  }, 120_000);
});
