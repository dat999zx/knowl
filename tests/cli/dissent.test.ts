import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { createManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { joinWorkspace } from '../../src/workspace/membership.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

/**
 * The `knowl dissent` verbs, driven through the built CLI.
 *
 * Every verb is explicit -- `record`, not a bare `knowl dissent <id>` beside subcommands -- so
 * an item id can never be mistaken for a verb. The layer itself is thin on purpose: the rules
 * live in `workspace/dissents.ts`, and these assertions are that the CLI reaches them and shows
 * what came back.
 */

const HOME = path.resolve('./.knowl-dissent-cli-home');
const A = path.resolve('./.knowl-dissent-cli-a');
const B = path.resolve('./.knowl-dissent-cli-b');
const CLI = path.resolve('./dist/index.js');

function knowl(cwd: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, KNOWL_HOME: HOME },
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

async function seed(root: string, name: string, title: string, content: string): Promise<string> {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
  await initDb(root);
  const projectId = (await repo.createProject(root, name)).id;
  const stored = await storeKnowledgeItemDeduped(projectId, { category: 'decision', title, content });
  await getClient().execute({
    sql: 'UPDATE knowledge_items SET visibility = ?, origin_repo = ? WHERE id = ?',
    args: ['workspace', name, stored.item.id],
  });
  await closeDb();
  return stored.item.id;
}

// Each assertion spawns the real built CLI: several seconds of node start-up per invocation.
describe('knowl dissent CLI', { timeout: 180_000 }, () => {
  let ownedByB = '';
  let ownedByA = '';

  beforeAll(async () => {
    // The manifest and the membership rows are written in-process here but read by a spawned
    // CLI, and both sides resolve the workspace through `knowlHome()`. Without this the setup
    // would land in the real home directory and the CLI would correctly report no workspace.
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await writeManifest(workspaceManifestPath('cliws'), createManifest('cliws', null));
    ownedByA = await seed(A, 'clia', 'Local note', 'Something only this repo knows.');
    ownedByB = await seed(B, 'clib', 'Auth token TTL', 'Auth tokens expire after fifteen minutes.');
    await joinWorkspace({ projectRoot: A, workspaceName: 'cliws', repoName: 'clia' });
    await joinWorkspace({ projectRoot: B, workspaceName: 'cliws', repoName: 'clib' });
    await closeDb();
    await releaseAll();
  });

  it('records a dissent and says who now sees it', () => {
    const result = knowl(A, 'dissent', 'record', ownedByB, '--claim', 'The TTL is five minutes, not fifteen.');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('clib');
    // The reassurance that matters: contesting an item did not edit it.
    expect(result.stdout).toMatch(/only its owner can supersede or retire it/i);
  });

  it('the owning repo sees it as incoming, with the claim and what to do', () => {
    const result = knowl(B, 'dissent', 'list', '--incoming');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('INCOMING (1)');
    expect(result.stdout).toContain('Auth token TTL');
    expect(result.stdout).toContain('five minutes');
    expect(result.stdout).toMatch(/superseding the item/i);
  });

  it('the raising repo sees it as outgoing', () => {
    const result = knowl(A, 'dissent', 'list', '--outgoing');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('OUTGOING (1)');
    expect(result.stdout).toContain('clib');
    expect(result.stdout).toContain('[open]');
  });

  it('refuses to dissent against this repo\'s own item, and says what to do instead', () => {
    const result = knowl(A, 'dissent', 'record', ownedByA, '--claim', 'Wrong.');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/yours to change/i);
  });

  it('refuses an id no repo holds', () => {
    const result = knowl(A, 'dissent', 'record', 'no-such-item-000', '--claim', 'Wrong.');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/No knowledge item/i);
  });

  it('rejecting clears the dispute and says the other repo keeps its own record', () => {
    const listed = knowl(B, 'dissent', 'list', '--incoming');
    const dissentId = /\s{2}([0-9a-f]{16})\s{2}/.exec(listed.stdout)?.[1] ?? '';
    expect(dissentId).toMatch(/^[0-9a-f]{16}$/);

    const rejected = knowl(B, 'dissent', 'reject', dissentId, '--target', ownedByB, '--reason', 'Measured at fifteen.');
    expect(rejected.status, rejected.stderr).toBe(0);
    expect(rejected.stdout).toMatch(/stands as written/i);
    expect(rejected.stdout).toMatch(/keeps its own record/i);

    expect(knowl(B, 'dissent', 'list', '--incoming').stdout).toContain('INCOMING (0)');

    // A rejection is a judgement on partial information -- the other repo is the one that saw
    // the problem -- so reconsidering has to stay possible. `promote` shipped without its
    // inverse and the cost has been paid ever since.
    const reopened = knowl(B, 'dissent', 'reopen', dissentId);
    expect(reopened.status, reopened.stderr).toBe(0);
    expect(knowl(B, 'dissent', 'list', '--incoming').stdout).toContain('INCOMING (1)');

    // Left rejected, so the withdraw case below reads a settled fixture.
    knowl(B, 'dissent', 'reject', dissentId, '--target', ownedByB, '--reason', 'Measured at fifteen.');
  });

  it('withdrawing refuses an id this repo does not hold', () => {
    const result = knowl(B, 'dissent', 'withdraw', 'not-a-dissent-x');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/No dissent/i);
  });

  it('the raising repo can withdraw its own', () => {
    const outgoing = knowl(A, 'dissent', 'list', '--outgoing');
    const dissentId = /\s{2}([0-9a-f]{16})\s{2}/.exec(outgoing.stdout)?.[1] ?? '';
    const result = knowl(A, 'dissent', 'withdraw', dissentId);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/no longer marks the item/i);
  });
});
