import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { flattenGroups, queryFederated } from '../../src/workspace/federated-query.js';
import { resolveWorkspace } from '../../src/workspace/resolve.js';
import { createManifest, readManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { joinWorkspace } from '../../src/workspace/membership.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';
import { releaseAll } from '../../src/store/connection-pool.js';

// Numbered per test rather than wiped between tests: the wipe fails EBUSY on Windows and the
// shared pattern in this directory swallows it, so state accumulates. See federated-grouping.
let fixture = 0;
let HOME = '';
let A = '';
let B = '';

type Seed = { title: string; content: string; visibility: string };

async function seed(root: string, name: string, items: Seed[]) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
  await initDb(root);
  const projectId = (await repo.createProject(root, name)).id;
  for (const item of items) {
    const stored = await storeKnowledgeItemDeduped(projectId, {
      category: 'decision', title: item.title, content: item.content,
    });
    await getClient().execute({
      sql: 'UPDATE knowledge_items SET visibility = ?, origin_repo = ? WHERE id = ?',
      args: [item.visibility, name, stored.item.id],
    });
  }
  await closeDb();
}

async function federate(query: string, limit: number, extra: {
  repos?: string[];
  scope?: 'local' | 'workspace';
} = {}) {
  await initDb(A);
  try {
    const active = (await resolveWorkspace(A))!;
    return await queryFederated({ workspace: active, query, limit, ...extra });
  } finally {
    await closeDb();
  }
}

describe('federated scope', () => {
  beforeEach(async () => {
    fixture += 1;
    HOME = path.resolve(`./.knowl-scope-${fixture}-home`);
    A = path.resolve(`./.knowl-scope-${fixture}-a`);
    B = path.resolve(`./.knowl-scope-${fixture}-b`);
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
    await joinWorkspace({ projectRoot: A, workspaceName: 'ws', repoName: 'a' });
    await joinWorkspace({ projectRoot: B, workspaceName: 'ws', repoName: 'b' });
  });

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
  });

  afterAll(async () => {
    for (let index = 1; index <= fixture; index += 1) {
      for (const suffix of ['home', 'a', 'b']) {
        await fs.rm(path.resolve(`./.knowl-scope-${index}-${suffix}`), { recursive: true, force: true })
          .catch(() => {});
      }
    }
  });

  it('searches only this repo under scope local', async () => {
    const result = await federate('deployment tag push', 5, { scope: 'local' });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].repo).toBe('a');
    expect(flattenGroups(result)).toEqual([]);
  });

  it('does not reach a peer at all under scope local', async () => {
    // Observable proof rather than a spy: an absent peer is normally reported as skipped, and a
    // peer that is never considered produces no entry. Repointing `b` at a path that was never
    // checked out makes "reached and found missing" and "not reached" distinguishable.
    const manifest = await readManifest(workspaceManifestPath('ws'));
    manifest.repos = manifest.repos.map(entry =>
      entry.name === 'b' ? { ...entry, path: path.resolve('./.knowl-scope-never-cloned') } : entry);
    await writeManifest(workspaceManifestPath('ws'), manifest);

    expect((await federate('auth', 5)).skipped).toEqual([{ repo: 'b', reason: 'absent' }]);
    expect((await federate('auth', 5, { scope: 'local' })).skipped).toEqual([]);
  });

  it('is flat under scope local even when nothing is found', async () => {
    const result = await federate('deployment tag push', 5, { scope: 'local' });

    expect(result.shape).toBe('flat');
  });

  it('is grouped under scope workspace even when only local answers', async () => {
    // An explicit scope fixes the shape. A caller who asked for a partitioned view gets one
    // whether or not the partition turned out interesting -- a shape that changed under them
    // based on what was found would be worse than a one-key object.
    const result = await federate('auth tokens expire', 5, { scope: 'workspace' });

    expect(result.shape).toBe('grouped');
    expect(result.groups[0].repo).toBe('a');
  });

  it('is grouped when repos names a single repo', async () => {
    const result = await federate('deployment', 5, { repos: ['b'] });

    expect(result.shape).toBe('grouped');
  });

  it('lets repos win when both are passed', async () => {
    // More specific of the two. Refusing a benign combination would cost a caller their answer
    // over a preference.
    const result = await federate('deployment tag push', 5, { repos: ['b'], scope: 'local' });

    expect(flattenGroups(result).some(item => item.repo === 'b')).toBe(true);
  });
});
