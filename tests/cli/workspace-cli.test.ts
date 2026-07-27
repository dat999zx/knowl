import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

const HOME = path.resolve('./.knowl-cli-home');
const A = path.resolve('./.knowl-cli-a');
const CLI = path.resolve('./dist/index.js');

function knowl(cwd: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, KNOWL_HOME: HOME },
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

// Every assertion here spawns the real built CLI, which costs several seconds of node
// startup per invocation. The default 30s budget is not enough for a test that runs three.
describe('knowl workspace CLI', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(A, '.knowl'), { recursive: true });
    await saveConfig(A, { ...DEFAULT_CONFIG });
    await initDb(A);
    const projectId = (await repo.createProject(A, 'cli')).id;
    await storeKnowledgeItemDeduped(projectId, {
      category: 'decision', title: 'Wire format is protobuf',
      content: 'Server and client exchange protobuf, not JSON.',
    });
    await closeDb();
  });

  afterAll(async () => {
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('reports a useful empty state, then links the repo and shows it', () => {
    // Grouped into one test on purpose: each knowl() is a real process spawn costing
    // seconds, and this file is the heaviest addition to a run vitest.config.ts caps at
    // 4 workers precisely because these suites are spawn-dominated.
    const emptyList = knowl(A, 'workspace', 'list');
    expect(emptyList.status).toBe(0);
    expect(emptyList.stdout).toMatch(/No workspaces/i);

    expect(knowl(A, 'workspace', 'status').stdout).toMatch(/not linked/i);

    expect(knowl(A, 'workspace', 'init', 'duckprep').status).toBe(0);
    const added = knowl(A, 'workspace', 'add', 'duckprep', '--name', 'server');
    expect(added.status).toBe(0);
    expect(added.stdout).toMatch(/Linked this repo as "server"/);

    const status = knowl(A, 'workspace', 'status');
    expect(status.stdout).toContain('duckprep');
    expect(status.stdout).toContain('server');
  });

  it('refuses a second workspace with the same name', () => {
    const result = knowl(A, 'workspace', 'init', 'duckprep');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/already exists/i);
  });

  it('promote dry-runs by default and names what it would share', () => {
    const result = knowl(A, 'workspace', 'promote', '--category', 'decision');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Would promote 1 item/);
    expect(result.stdout).toContain('Wire format is protobuf');
    expect(result.stdout).toMatch(/Dry run/i);
  });

  it('refuses to remove a repo that still owns knowledge', () => {
    const result = knowl(A, 'workspace', 'remove', 'server');
    expect(result.status).toBe(1);
    // The name is retired on removal, so orphaning its items is not recoverable by
    // re-adding under the same name.
    expect(result.stderr).toMatch(/still owns 1 active item/);
  });

  // Applying a promote is covered exhaustively by tests/workspace/promote.test.ts without
  // a subprocess. Every spawn here costs seconds and this suite is already the heaviest
  // addition to a run that vitest.config.ts caps at 4 workers for exactly this reason.

  it('joins from a manifest copied off another machine, re-pointing paths locally', async () => {
    // The reason join exists: repo paths in a manifest are machine-local, so a copy names
    // repos that live somewhere else or not at all. Without this, a second developer or a
    // second machine could not use a workspace at all.
    const other = path.resolve('./.knowl-cli-machine2');
    await fs.rm(other, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(other, '.knowl'), { recursive: true });
    await saveConfig(other, { ...DEFAULT_CONFIG });

    const manifest = path.join(HOME, 'workspaces', 'duckprep', 'workspace.json');
    const joined = knowl(other, 'workspace', 'join', manifest, '--name', 'server');
    expect(joined.status).toBe(0);
    expect(joined.stdout).toMatch(/Joined workspace "duckprep" as "server"/);

    const written = JSON.parse(await fs.readFile(manifest, 'utf-8'));
    const entry = written.repos.find((repo: { name: string }) => repo.name === 'server');
    expect(path.resolve(entry.path)).toBe(other);

    await fs.rm(other, { recursive: true, force: true }).catch(() => {});
  });

  it('refuses a join when this checkout matches no repo in the manifest', () => {
    const manifest = path.join(HOME, 'workspaces', 'duckprep', 'workspace.json');
    const result = knowl(A, 'workspace', 'join', manifest, '--name', 'not-in-manifest');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/does not match any of them/);
  });

  it('removes the repo once the owner acknowledges the export', () => {
    const result = knowl(A, 'workspace', 'remove', 'server', '--export-first');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/retired/i);
    expect(knowl(A, 'workspace', 'status').stdout).toMatch(/not linked/i);
  });

  it('refuses to reuse the retired name', () => {
    const result = knowl(A, 'workspace', 'add', 'duckprep', '--name', 'server');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/retired/i);
  });
});
