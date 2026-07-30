import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { resetWriteOwnershipCache } from '../../src/store/write-ownership.js';
import { DEFAULT_FRESHNESS, hashKnowledgeLifecycle } from '../../src/store/freshness.js';
import { createManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';

const HOME = path.resolve('./.knowl-write-visibility-home');
const ROOT = path.resolve('./.knowl-write-visibility-repo');

async function link(defaultVisibility?: 'workspace') {
  const manifest = createManifest('vis', null);
  manifest.repos.push({ name: 'notes', path: ROOT, defaultVisibility });
  await writeManifest(workspaceManifestPath('vis'), manifest);
  await saveConfig(ROOT, { ...DEFAULT_CONFIG, workspace: { workspace: 'vis', repo: 'notes' } });
  resetWriteOwnershipCache();
}

async function rowFor(id: string) {
  const result = await getClient().execute({
    sql: 'SELECT visibility, lifecycle_hash, origin_repo FROM knowledge_items WHERE id = ?',
    args: [id],
  });
  return result.rows[0] as any;
}

describe('default write visibility', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, ROOT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
  });

  afterAll(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    for (const dir of [HOME, ROOT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('stamps workspace visibility and a lifecycle hash that agrees with the row', async () => {
    await link('workspace');
    await initDb(ROOT);
    const project = await repo.createProject(ROOT, 'notes');
    const item = await repo.createKnowledgeItem(project.id, {
      category: 'fact', title: 'Shared by default', content: 'Everything here is cross-cutting.',
    });

    const row = await rowFor(item.id);
    expect(row.visibility).toBe('workspace');
    expect(row.origin_repo).toBe('notes');
    // The load-bearing assertion. The row and the hash are stamped at two different sites in
    // createKnowledgeItem; a hash computed over 'repo' beside a row saying 'workspace' is a
    // permanent divergence that change-watermark and import-policy would never reconcile.
    expect(row.lifecycle_hash).toBe(hashKnowledgeLifecycle({
      status: 'active', freshness: DEFAULT_FRESHNESS, supersededById: null,
      originRepo: 'notes', visibility: 'workspace',
    }));
    await closeDb();
  });

  it('stays private when the manifest does not say otherwise', async () => {
    await link(undefined);
    await initDb(ROOT);
    const project = await repo.getProjectByRootPath(ROOT);
    const item = await repo.createKnowledgeItem(project!.id, {
      category: 'fact', title: 'Private by default', content: 'Absent means repo.',
    });

    const row = await rowFor(item.id);
    expect(row.visibility).toBe('repo');
    expect(row.lifecycle_hash).toBe(hashKnowledgeLifecycle({
      status: 'active', freshness: DEFAULT_FRESHNESS, supersededById: null,
      originRepo: 'notes', visibility: 'repo',
    }));
    await closeDb();
  });
});
