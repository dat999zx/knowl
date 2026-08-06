import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * A database that went missing must stay missing until a person decides otherwise.
 *
 * Two defects made routine maintenance destroy the evidence of a recoverable loss:
 *
 * 1. `doctor` is exempt from the preAction missing-database guard so it can run when something
 *    is wrong. The exemption skipped the throw, but `runDoctor` still called `initDb`, and
 *    opening a libSQL `file:` URL creates the file. So diagnosing a repository whose database
 *    had moved rebuilt an empty one and reported the store ready -- and the guard could never
 *    fire again afterwards, because now the file existed. `knowl-sync` runs `doctor` in every
 *    repository on the machine.
 *
 * 2. The guard's own error names `knowl snapshot restore` as the first recovery to try, and
 *    `snapshot` was not exempt -- so the guard refused the one command it told you to run.
 *
 * Fixtures live outside the checkout: `findProjectRoot` walks up, so a fixture under the repo
 * resolves to the repo on any machine where `knowl init` has been run in it.
 */

const CLI = path.resolve(__dirname, '../../dist/index.js');

function run(args: string[], cwd: string, home: string) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, KNOWL_HOME: home },
  });
}

describe('a knowledge database that has gone missing', () => {
  let root = '';
  let repo = '';
  let home = '';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-missing-db-'));
    repo = path.join(root, 'repo');
    home = path.join(root, 'home');
    await fs.mkdir(repo, { recursive: true });
    run(['init'], repo, home);
    run(['decide', 'Irreplaceable', 'the one fact this repository holds'], repo, home);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  async function removeDatabase() {
    const dir = path.join(repo, '.knowl');
    for (const suffix of ['', '-shm', '-wal']) {
      await fs.rm(path.join(dir, `knowl.db${suffix}`), { force: true });
    }
  }

  it('is not silently recreated by the command that diagnoses it', async () => {
    await removeDatabase();

    const result = run(['doctor'], repo, home);

    expect(result.stdout + result.stderr).toMatch(/database is missing/i);
    expect(result.stdout).toContain('NOT READY');
    // The actual damage: a rebuilt file makes the loss permanent and undetectable.
    await expect(fs.access(path.join(repo, '.knowl', 'knowl.db'))).rejects.toThrow();
  });

  it('can be restored by the command the error message prescribes', async () => {
    const created = run(['snapshot', 'create'], repo, home);
    const snapshot = (created.stdout.match(/^Snapshot:\s*(.+)$/m) ?? [])[1]?.trim();
    expect(snapshot).toBeTruthy();

    await removeDatabase();

    const restored = run(['snapshot', 'restore', snapshot!, '--confirm'], repo, home);

    expect(restored.status).toBe(0);
    expect(restored.stdout).toContain('Snapshot restored.');
    expect(run(['status'], repo, home).stdout).toMatch(/Active:\s+1/);
  });
});
