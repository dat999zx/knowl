import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * K-16: a database file that is gone must not be silently rebuilt.
 * K-52: a hook that cannot resolve a project must not be an error.
 *
 * The two are the same question asked twice -- "what does a hook do when the store is not
 * where it expected" -- and they want opposite answers, which is why one mechanism could not
 * serve both. A directory that is not a Knowl repository is a normal, permanent state for a
 * globally installed hook: it fires in every directory the agent visits, so failing there is
 * noise nobody can turn off. A repository whose database has vanished is neither normal nor
 * permanent, and rebuilding an empty schema over it is exactly how a moved file or a restore
 * in progress reads to the user as "knowl forgot everything."
 */

const CLI_PATH = path.resolve('./dist/index.js');
const BASE = path.resolve('./.knowl-missing-db');
const REPO = path.join(BASE, 'repo');
const NOT_A_REPO = path.join(BASE, 'plain-directory');
const DB = path.join(REPO, '.knowl', 'knowl.db');

function hook(cwd: string) {
  return spawnSync(process.execPath, [CLI_PATH, 'agent-hook', 'claude', 'PostToolUse', '--json'], {
    input: JSON.stringify({
      session_id: 'missing-db-session',
      cwd,
      tool_name: 'Read',
      tool_input: { file_path: 'a.ts' },
    }),
    encoding: 'utf8',
    cwd,
  });
}

describe('a store that is not where it was expected', () => {
  beforeAll(async () => {
    await fs.rm(BASE, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(NOT_A_REPO, { recursive: true });
    await fs.mkdir(REPO, { recursive: true });
    const init = spawnSync(process.execPath, [CLI_PATH, 'init', '--yes'], { cwd: REPO, encoding: 'utf8' });
    expect(init.status, init.stderr).toBe(0);
    await expect(fs.access(DB)).resolves.toBeUndefined();
  });

  afterAll(async () => {
    await fs.rm(BASE, { recursive: true, force: true }).catch(() => {});
  });

  it('K-52: a hook fired outside any repository says nothing and does not fail', () => {
    const result = hook(NOT_A_REPO);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('K-16: a hook does not rebuild a database that has gone missing', async () => {
    const moved = `${DB}.moved`;
    await fs.rename(DB, moved);
    try {
      const result = hook(REPO);

      // The file is the point: a fresh empty schema here is indistinguishable from
      // amnesia, and it would overwrite the restore that was about to land.
      await expect(fs.access(DB)).rejects.toThrow();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/database/i);
      expect(result.stderr).toContain('knowl.db');
    } finally {
      await fs.rename(moved, DB).catch(() => {});
    }
  });

  it('K-16: an ordinary command refuses rather than reporting an empty store', async () => {
    const moved = `${DB}.moved`;
    await fs.rename(DB, moved);
    try {
      const result = spawnSync(process.execPath, [CLI_PATH, 'status'], { cwd: REPO, encoding: 'utf8' });

      await expect(fs.access(DB)).rejects.toThrow();
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/database/i);
      // "Active: 0" is the reading that sends someone looking for lost memory.
      expect(result.stdout).not.toContain('KNOWLEDGE ITEMS');
    } finally {
      await fs.rename(moved, DB).catch(() => {});
    }
  });

  it('K-16: a checkout this machine has never opened is not accused of losing anything', async () => {
    // `.knowl/config.json` can legitimately be committed -- `workspace add --force` exists
    // for repositories that track it -- so a fresh clone has config and no database, and
    // bootstrapping one there is the correct behaviour, not a loss.
    const clone = path.join(BASE, 'fresh-clone');
    await fs.mkdir(path.join(clone, '.knowl'), { recursive: true });
    await fs.copyFile(path.join(REPO, '.knowl', 'config.json'), path.join(clone, '.knowl', 'config.json'));

    const result = spawnSync(process.execPath, [CLI_PATH, 'status'], { cwd: clone, encoding: 'utf8' });

    expect(result.stderr).not.toMatch(/database is missing/i);
    await expect(fs.access(path.join(clone, '.knowl', 'knowl.db'))).resolves.toBeUndefined();
  });

  it('K-16: `knowl upgrade` is the way back, and says so', async () => {
    const moved = `${DB}.moved`;
    await fs.rename(DB, moved);
    try {
      const refused = spawnSync(process.execPath, [CLI_PATH, 'status'], { cwd: REPO, encoding: 'utf8' });
      expect(`${refused.stdout}${refused.stderr}`).toContain('knowl upgrade');

      const upgrade = spawnSync(process.execPath, [CLI_PATH, 'upgrade'], { cwd: REPO, encoding: 'utf8' });
      expect(upgrade.status, upgrade.stderr).toBe(0);
      await expect(fs.access(DB)).resolves.toBeUndefined();
    } finally {
      await fs.rm(DB, { force: true }).catch(() => {});
      await fs.rename(moved, DB).catch(() => {});
    }
  });
});
