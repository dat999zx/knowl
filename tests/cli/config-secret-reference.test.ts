import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../../src/core/config.js';

/**
 * K-10: an `${ENV_VAR}` API key reference must survive a config round trip.
 *
 * `loadConfig` resolves the reference to the real key in memory, which is what every
 * consumer wants. The object it returns then looks like an ordinary config, so any caller
 * that reads it, adds a field and saves it back writes the resolved secret to
 * `.knowl/config.json` -- a file that lives in the repository and that people do commit.
 * `workspace add`, `workspace join` and `workspace remove` all do exactly that.
 *
 * The fix is at the boundary rather than at the three call sites, because "the object
 * loadConfig returns is unsafe to save" is a rule every future caller has to be told.
 */

const HOME = path.resolve('./.knowl-secret-home');
const REPO = path.resolve('./.knowl-secret-repo');
const CLI = path.resolve('./dist/index.js');
const ENV_NAME = 'KNOWL_LANE7_TEST_KEY';
const SECRET = 'sk-live-do-not-write-this-to-disk';

function knowl(...args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO,
    encoding: 'utf-8',
    env: { ...process.env, KNOWL_HOME: HOME, [ENV_NAME]: SECRET },
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

async function rawConfig(): Promise<any> {
  return JSON.parse(await fs.readFile(path.join(REPO, '.knowl', 'config.json'), 'utf8'));
}

describe('an ${ENV_VAR} secret reference in config.json', { timeout: 120_000 }, () => {
  beforeEach(async () => {
    process.env[ENV_NAME] = SECRET;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, REPO]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(REPO, '.knowl'), { recursive: true });
    await saveConfig(REPO, {
      ...DEFAULT_CONFIG,
      ai: { provider: 'anthropic', model: 'claude-sonnet-4', apiKey: `\${${ENV_NAME}}` },
    } as any);
    await initDb(REPO);
    await repo.createProject(REPO, 'secret-fixture');
    await closeDb();
    await releaseAll();
  });

  afterEach(async () => {
    delete process.env[ENV_NAME];
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, REPO]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('survives any load-modify-save round trip', async () => {
    const loaded = await loadConfig(REPO);
    // The resolved value is what a consumer needs, and is why the round trip is dangerous.
    expect(loaded.ai?.apiKey).toBe(SECRET);

    await saveConfig(REPO, { ...loaded, workspace: { workspace: 'ws', repo: 'r' } } as any);

    const onDisk = await rawConfig();
    expect(onDisk.ai.apiKey).toBe(`\${${ENV_NAME}}`);
    expect(JSON.stringify(onDisk)).not.toContain(SECRET);
  });

  it('survives `knowl workspace add`, which is where it was found', async () => {
    expect(knowl('workspace', 'init', 'lane7-ws').status).toBe(0);
    const added = knowl('workspace', 'add', 'lane7-ws', '--name', 'secret-repo', '--force');
    expect(added.status, added.stderr).toBe(0);

    const onDisk = await rawConfig();
    expect(JSON.stringify(onDisk)).not.toContain(SECRET);
    expect(onDisk.ai.apiKey).toBe(`\${${ENV_NAME}}`);
    // The round trip must still have done its job.
    expect(onDisk.workspace).toEqual({ workspace: 'lane7-ws', repo: 'secret-repo' });
  });

  it('still lets someone set a literal key on purpose', async () => {
    const set = knowl('config', 'set', 'ai.apiKey', 'sk-literal-chosen-by-hand');
    expect(set.status, set.stderr).toBe(0);
    expect((await rawConfig()).ai.apiKey).toBe('sk-literal-chosen-by-hand');
  });
});
