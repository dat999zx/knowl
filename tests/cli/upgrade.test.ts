import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { createManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { joinWorkspace } from '../../src/workspace/membership.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';
import { resetWriteOwnershipCache } from '../../src/store/write-ownership.js';
import { listKnownRepos } from '../../src/core/repo-registry.js';
import { upgradeExistingRepository } from '../../src/cli/upgrade.js';

const HOME = path.resolve('./.knowl-upgrade-home');
const REPO = path.resolve('./.knowl-upgrade-repo');

/** Open, read, close: an assertion thrown while the database is open strands a handle. */
async function readRows(sql: string): Promise<Array<Record<string, unknown>>> {
  await initDb(REPO);
  try {
    return (await getClient().execute(sql)).rows as unknown as Array<Record<string, unknown>>;
  } finally {
    await closeDb();
  }
}

async function execute(sql: string): Promise<void> {
  await initDb(REPO);
  try {
    await getClient().execute(sql);
  } finally {
    await closeDb();
  }
}

describe('upgrade', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    // The writing repo is cached per config root for the life of the process, so a fixture
    // that joins a workspace would otherwise stamp ownership on the next fixture's writes.
    resetWriteOwnershipCache();
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
    await fs.rm(REPO, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(REPO, '.knowl'), { recursive: true });
    await saveConfig(REPO, { ...DEFAULT_CONFIG });
    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));

    await initDb(REPO);
    // Wipe rather than trust the directory removal: on Windows libSQL can hold the database
    // file, the rm is silently refused, and the previous fixture's already-owned row then
    // dedups the seed away -- failing the next assertion for the wrong reason.
    await getClient().execute('DELETE FROM knowledge_commits');
    await getClient().execute('DELETE FROM knowledge_items');
    const projectId = (await repo.createProject(REPO, 'upgrade')).id;
    await storeKnowledgeItemDeduped(projectId, {
      category: 'decision', title: 'Wire format is protobuf',
      content: 'The server and client exchange protobuf, not JSON.',
    });
    await closeDb();
  });

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
    await fs.rm(REPO, { recursive: true, force: true }).catch(() => {});
  });

  it('claims items an older version left unowned', async () => {
    // The join-time backfill only ever ran once. Writes between joining and the release that
    // started stamping ownership stayed NULL, and nothing since revisits them -- so the count
    // that guards `workspace remove` against orphaning knowledge undercounts them forever.
    await joinWorkspace({ projectRoot: REPO, workspaceName: 'ws', repoName: 'server' });
    await execute('UPDATE knowledge_items SET origin_repo = NULL');

    const result = await upgradeExistingRepository(REPO, 'upgrade');

    expect(result.claimedItems).toBe(1);
    const rows = await readRows('SELECT origin_repo, visibility FROM knowledge_items');
    expect(rows.every(row => row.origin_repo === 'server')).toBe(true);
    // Claiming is not publishing: sharing stays an explicit promote.
    expect(rows.every(row => row.visibility === 'repo')).toBe(true);
  });

  it('claims ownership without publishing, even where new writes default to workspace', async () => {
    // The sharper form of the check above. A repo whose default visibility is `workspace`
    // shares everything it writes from now on -- but the sweep is an ownership repair, and
    // ownership says who wrote an item, never who may read it. Sweeping old private rows into
    // visibility would be a bulk publish nobody asked for, and promotion has no reverse.
    await joinWorkspace({
      projectRoot: REPO, workspaceName: 'ws', repoName: 'server',
      settings: { defaultVisibility: 'workspace' },
    });
    await execute('UPDATE knowledge_items SET origin_repo = NULL');

    const result = await upgradeExistingRepository(REPO, 'upgrade');

    expect(result.claimedItems).toBe(1);
    const rows = await readRows('SELECT origin_repo, visibility FROM knowledge_items');
    expect(rows.every(row => row.origin_repo === 'server')).toBe(true);
    expect(rows.every(row => row.visibility === 'repo')).toBe(true);
  });

  it('leaves ownership alone outside a workspace, where NULL is correct', async () => {
    const result = await upgradeExistingRepository(REPO, 'upgrade');

    expect(result.claimedItems).toBe(0);
    const rows = await readRows('SELECT origin_repo FROM knowledge_items');
    expect(rows.every(row => row.origin_repo === null)).toBe(true);
  });

  it('records the repo so a machine-wide sweep can find it later', async () => {
    // An unlinked repo appears in no workspace manifest, so without this the only way to
    // find it again is to walk the filesystem hoping to recognise it.
    expect(await listKnownRepos()).toEqual([]);

    await upgradeExistingRepository(REPO, 'upgrade');

    expect(await listKnownRepos()).toEqual([REPO]);
  });

  it('never reassigns an item another repo owns', async () => {
    await joinWorkspace({ projectRoot: REPO, workspaceName: 'ws', repoName: 'server' });
    await execute("UPDATE knowledge_items SET origin_repo = 'web'");

    const result = await upgradeExistingRepository(REPO, 'upgrade');

    expect(result.claimedItems).toBe(0);
    const rows = await readRows('SELECT origin_repo FROM knowledge_items');
    expect(rows.every(row => row.origin_repo === 'web')).toBe(true);
  });
});
