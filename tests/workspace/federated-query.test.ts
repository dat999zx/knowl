import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { queryKnowledgeForAgent } from '../../src/store/agent-query.js';
import { queryFederated } from '../../src/workspace/federated-query.js';
import { resolveWorkspace } from '../../src/workspace/resolve.js';
import { createManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { joinWorkspace } from '../../src/workspace/membership.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';
import { releaseAll } from '../../src/store/connection-pool.js';

const HOME = path.resolve('./.knowl-fed-home');
const A = path.resolve('./.knowl-fed-a');
const B = path.resolve('./.knowl-fed-b');

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

/** Local candidates the way the MCP handler produces them, then the federated fuse. */
async function federate(query: string, limit: number, repos?: string[]) {
  await initDb(A);
  try {
    const local = await queryKnowledgeForAgent('local', { query, limit: 10, surface: 'test' });
    const active = (await resolveWorkspace(A))!;
    return await queryFederated({ workspace: active, localItems: local, query, limit, repos });
  } finally {
    await closeDb();
  }
}

describe('federated read', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));
    await seed(A, 'a', [{ title: 'Local auth note', content: 'Auth tokens expire locally.', visibility: 'repo' }]);
    await seed(B, 'b', [
      { title: 'Auth token TTL is fifteen minutes', content: 'Auth tokens expire after fifteen minutes.', visibility: 'workspace' },
      { title: 'Auth scratch note', content: 'Auth debugging scratch, not for sharing.', visibility: 'repo' },
    ]);
    await joinWorkspace({ projectRoot: A, workspaceName: 'ws', repoName: 'a' });
    await joinWorkspace({ projectRoot: B, workspaceName: 'ws', repoName: 'b' });
  });
  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('returns a peer workspace-visible item, labelled with its repo', async () => {
    const result = await federate('auth', 5);
    const fromB = result.items.find(item => item.repo === 'b');
    expect(fromB).toBeDefined();
    expect(fromB!.title).toBe('Auth token TTL is fifteen minutes');
  });

  it('never returns a peer repo-private item', async () => {
    const result = await federate('auth', 5);
    expect(result.items.some(item => item.title === 'Auth scratch note')).toBe(false);
  });

  it('returns local repo-private items, which only stay out of OTHER repos', async () => {
    const result = await federate('auth', 5);
    expect(result.items.some(item => item.title === 'Local auth note' && item.repo === 'a')).toBe(true);
  });

  it('filters hard on origin repo, not on where an item might apply', async () => {
    const result = await federate('auth', 5, ['b']);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.every(item => item.repo === 'b')).toBe(true);
  });

  it('reports an absent peer instead of swallowing it', async () => {
    // Repoint the peer at a path that was never checked out here.
    const { readManifest } = await import('../../src/workspace/manifest.js');
    const manifest = await readManifest(workspaceManifestPath('ws'));
    manifest.repos = manifest.repos.map(entry =>
      entry.name === 'b' ? { ...entry, path: path.resolve('./.knowl-fed-never-cloned') } : entry);
    await writeManifest(workspaceManifestPath('ws'), manifest);

    const result = await federate('auth', 5);
    // "absent" and "empty" must not look the same -- that ambiguity is the support question
    // this feature would otherwise generate most.
    expect(result.skipped).toEqual([{ repo: 'b', reason: 'absent' }]);
  });

  it('never returns more than the limit, however many repos are linked', async () => {
    const result = await federate('auth', 1);
    expect(result.items.length).toBe(1);
  });

  it('leaves the peer database byte-identical', async () => {
    const peerDb = path.join(B, '.knowl', 'knowl.db');
    const before = await fs.readFile(peerDb);
    await federate('auth', 5);
    await releaseAll();
    expect((await fs.readFile(peerDb)).equals(before)).toBe(true);
  });
});
