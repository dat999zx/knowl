import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { createManifest, readManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { joinWorkspace } from '../../src/workspace/membership.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

const HOME = path.resolve('./.knowl-backfill-home');
const REPO = path.resolve('./.knowl-backfill-repo');

/**
 * Open, read, close. Asserting while the database is open leaves a handle behind when the
 * assertion throws, and Windows then refuses to remove the directory in afterEach.
 */
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

describe('origin_repo backfill on join', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await fs.rm(HOME, { recursive: true, force: true });
    await fs.rm(REPO, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(REPO, '.knowl'), { recursive: true });
    await saveConfig(REPO, { ...DEFAULT_CONFIG });
    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));

    await initDb(REPO);
    const projectId = (await repo.createProject(REPO, 'backfill')).id;
    await storeKnowledgeItemDeduped(projectId, {
      category: 'decision', title: 'Wire format is protobuf',
      content: 'The server and client exchange protobuf, not JSON.',
    });
    await closeDb();
  });
  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
    await fs.rm(REPO, { recursive: true, force: true }).catch(() => {});
  });

  it('claims every pre-existing item for the joining repo', async () => {
    await joinWorkspace({ projectRoot: REPO, workspaceName: 'ws', repoName: 'server' });
    const rows = await readRows('SELECT origin_repo, visibility FROM knowledge_items');

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(row => row.origin_repo === 'server')).toBe(true);
    // Backfill claims ownership; it does not publish. Sharing is an explicit promote.
    expect(rows.every(row => row.visibility === 'repo')).toBe(true);
  });

  it('records the workspace embedding identity when the first repo joins', async () => {
    await joinWorkspace({ projectRoot: REPO, workspaceName: 'ws', repoName: 'server' });
    const manifest = await readManifest(workspaceManifestPath('ws'));
    expect(manifest.embedding).toEqual({ provider: 'local', model: 'Xenova/all-MiniLM-L6-v2', dtype: 'q8' });
  });

  it('refuses a repo whose embedding identity differs from the workspace', async () => {
    const manifest = createManifest('ws', { provider: 'local', model: 'Xenova/bge-small-en', dtype: 'q8' });
    manifest.repos.push({ name: 'other', path: path.resolve('./.knowl-backfill-elsewhere') });
    await writeManifest(workspaceManifestPath('ws'), manifest);
    // Vector search filters on provider and model, so a mismatched repo's items would be
    // invisible -- and a filtered-out embedding looks exactly like no embedding.
    await expect(joinWorkspace({ projectRoot: REPO, workspaceName: 'ws', repoName: 'server' }))
      .rejects.toThrow(/embed/i);
  });

  it('does not half-join when the embedding check refuses', async () => {
    const manifest = createManifest('ws', { provider: 'local', model: 'Xenova/bge-small-en', dtype: 'q8' });
    manifest.repos.push({ name: 'other', path: path.resolve('./.knowl-backfill-elsewhere') });
    await writeManifest(workspaceManifestPath('ws'), manifest);
    await joinWorkspace({ projectRoot: REPO, workspaceName: 'ws', repoName: 'server' }).catch(() => {});

    const after = await readManifest(workspaceManifestPath('ws'));
    expect(after.repos.map(entry => entry.name)).toEqual(['other']);
  });

  it('leaves an already-owned item alone', async () => {
    await execute("UPDATE knowledge_items SET origin_repo = 'legacy-name'");
    await joinWorkspace({ projectRoot: REPO, workspaceName: 'ws', repoName: 'server' });
    const rows = await readRows('SELECT origin_repo FROM knowledge_items');

    // Backfill claims only unowned rows; overwriting an existing owner would be a silent
    // ownership transfer.
    expect(rows.every(row => row.origin_repo === 'legacy-name')).toBe(true);
  });
});
