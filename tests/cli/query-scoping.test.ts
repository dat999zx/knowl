import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { runCliQuery } from '../../src/cli/query-command.js';
import { createManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { joinWorkspace } from '../../src/workspace/membership.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

// Numbered per test: the convention global-teardown.ts describes for suites needing genuine
// per-test isolation. The wipe fails EBUSY on Windows and is swallowed on purpose, so nothing is
// removed mid-run and state would otherwise accumulate. See federated-grouping for the measurement.
let fixture = 0;
let HOME = '';
let A = '';
let B = '';
let SOLO = '';

async function seed(root: string, name: string, items: Array<{ title: string; content: string; visibility: string }>) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
  await initDb(root);
  const projectId = (await repo.createProject(root, name)).id;
  for (const item of items) {
    const stored = await storeKnowledgeItemDeduped(projectId, { category: 'decision', title: item.title, content: item.content });
    await getClient().execute({
      sql: 'UPDATE knowledge_items SET visibility = ?, origin_repo = ? WHERE id = ?',
      args: [item.visibility, name, stored.item.id],
    });
  }
  await closeDb();
}

async function query(root: string, args: { query?: string; limit?: number; asOf?: string } = {}) {
  await initDb(root);
  try {
    return await runCliQuery({ projectRoot: root, projectId: 'local', ...args });
  } finally {
    await closeDb();
  }
}

/**
 * `knowl query` gets the same partition the MCP tool does, for the same reason: a human reading
 * a flat list cannot see which repo answered either.
 */
describe('knowl query scoping', () => {
  beforeEach(async () => {
    fixture += 1;
    HOME = path.resolve(`./.knowl-cliscope-${fixture}-home`);
    A = path.resolve(`./.knowl-cliscope-${fixture}-a`);
    B = path.resolve(`./.knowl-cliscope-${fixture}-b`);
    SOLO = path.resolve(`./.knowl-cliscope-${fixture}-solo`);
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));
    await seed(A, 'a', [
      { title: 'Local auth note', content: 'Auth tokens expire locally.', visibility: 'repo' },
    ]);
    await seed(B, 'b', [
      { title: 'Deploy runs on tag push', content: 'Deployment is triggered by pushing a tag.', visibility: 'workspace' },
    ]);
    await seed(SOLO, 'solo', [
      { title: 'Solo note', content: 'Deployment is manual in the solo repo.', visibility: 'repo' },
    ]);
    await joinWorkspace({ projectRoot: A, workspaceName: 'ws', repoName: 'a' });
    await joinWorkspace({ projectRoot: B, workspaceName: 'ws', repoName: 'b' });
  }, 120_000);

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
  }, 120_000);

  afterAll(async () => {
    for (let index = 1; index <= fixture; index += 1) {
      for (const suffix of ['home', 'a', 'b', 'solo']) {
        await fs.rm(path.resolve(`./.knowl-cliscope-${index}-${suffix}`), { recursive: true, force: true }).catch(() => {});
      }
    }
  }, 120_000);

  it('groups by repo when a linked repo answers', async () => {
    const result = await query(A, { query: 'deployment tag push' });

    expect(result.shape).toBe('grouped');
    expect(result.groups[0].repo).toBe('a');
    expect(result.groups[0].items).toEqual([]);
    expect(result.groups[1].repo).toBe('b');
  }, 120_000);

  it('stays flat when every row is this repo\'s', async () => {
    const result = await query(A, { query: 'auth tokens expire' });

    expect(result.shape).toBe('flat');
    expect(result.groups).toHaveLength(1);
  }, 120_000);

  it('keeps items as the flattened view, so ranking assertions still read it', async () => {
    const result = await query(A, { query: 'deployment tag push' });

    expect(result.items.map(item => item.repo)).toEqual(['b']);
  }, 120_000);

  it('stays flat for an unlinked repo, which never reaches federation', async () => {
    const result = await query(SOLO, { query: 'deployment' });

    expect(result.shape).toBe('flat');
    expect(result.groups).toHaveLength(1);
    expect(result.items.length).toBeGreaterThan(0);
  }, 120_000);

  it('keeps --as-of flat, since it does not run through the ranker at all', async () => {
    const result = await query(A, { query: 'auth', asOf: new Date().toISOString() });

    expect(result.shape).toBe('flat');
    expect(result.groups).toHaveLength(1);
  }, 120_000);
});
