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
import { resetWriteOwnershipCache } from '../../src/store/write-ownership.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

const HOME = path.resolve('./.knowl-write-owner-home');
const LINKED = path.resolve('./.knowl-write-owner-linked');
const SOLO = path.resolve('./.knowl-write-owner-solo');

async function makeRepo(root: string) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
}

async function ownerOf(root: string, title: string): Promise<string | null> {
  await initDb(root);
  try {
    const rows = await getClient().execute({
      sql: 'SELECT origin_repo FROM knowledge_items WHERE title = ?',
      args: [title],
    });
    const value = rows.rows[0]?.origin_repo;
    return value === null || value === undefined ? null : String(value);
  } finally {
    await closeDb();
  }
}

describe('ownership is stamped when knowledge is written', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    for (const dir of [HOME, LINKED, SOLO]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await makeRepo(LINKED);
    await makeRepo(SOLO);
    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));
    await joinWorkspace({ projectRoot: LINKED, workspaceName: 'ws', repoName: 'alpha' });
    resetWriteOwnershipCache();
  });

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    for (const dir of [HOME, LINKED, SOLO]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('stamps the owning repo on a write made after joining', async () => {
    // The gap this closes: joining backfilled existing items, but nothing stamped new
    // ones, so everything written afterwards stayed unowned. In a shared database that is
    // fatal -- ownership decides who may edit, collect or export an item.
    await initDb(LINKED);
    const projectId = (await repo.createProject(LINKED, 'alpha')).id;
    await storeKnowledgeItemDeduped(projectId, {
      category: 'decision', title: 'Written after joining',
      content: 'This decision was recorded once the repo was already linked.',
    });
    await closeDb();

    expect(await ownerOf(LINKED, 'Written after joining')).toBe('alpha');
  });

  it('leaves ownership null in a repo with no workspace', async () => {
    await initDb(SOLO);
    const projectId = (await repo.createProject(SOLO, 'solo')).id;
    await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Written without a workspace',
      content: 'An unlinked project must behave exactly as it did before.',
    });
    await closeDb();

    expect(await ownerOf(SOLO, 'Written without a workspace')).toBeNull();
  });

  it('stamps a direct repository write, not just the deduped writer', async () => {
    // Synthesis, promotion and the extraction pipeline all create items without going
    // through knowledge-writer, so the stamp has to live in the shared funnel.
    await initDb(LINKED);
    await repo.createProject(LINKED, 'alpha');
    await repo.createKnowledgeItem('local', {
      category: 'architecture', title: 'Created directly',
      content: 'Written through the repository layer rather than the deduped writer.',
    });
    await closeDb();

    expect(await ownerOf(LINKED, 'Created directly')).toBe('alpha');
  });
});
