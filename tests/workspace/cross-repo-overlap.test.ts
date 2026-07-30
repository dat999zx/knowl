import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeAtomsDeduped, storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { createManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { joinWorkspace } from '../../src/workspace/membership.js';
import { promoteItems } from '../../src/workspace/promote.js';
import { resolveWorkspace } from '../../src/workspace/resolve.js';
import { findCrossRepoOverlap } from '../../src/workspace/cross-repo-overlap.js';
import { resetWriteOwnershipCache } from '../../src/store/write-ownership.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

// Fresh directories per test. Removal is best-effort because Windows can hold libSQL's WAL
// sidecars briefly after close, and a surviving API database made the batch test's write a
// verbatim no-op of the previous test's -- which reports no overlap, because nothing was
// written. The failure looked like the batch path being unwired.
let counter = 0;
let HOME = '';
let API = '';
let WEB = '';

const REDIS = {
  category: 'decision' as const,
  title: 'Session store is redis',
  content: 'Sessions live in redis and expire after thirty minutes.',
};

async function makeRepo(root: string) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
}

describe('cross-repo overlap', () => {
  beforeEach(async () => {
    counter += 1;
    HOME = path.resolve(`./.knowl-overlap-home${counter}`);
    API = path.resolve(`./.knowl-overlap-api${counter}`);
    WEB = path.resolve(`./.knowl-overlap-web${counter}`);
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    for (const dir of [HOME, API, WEB]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await makeRepo(API);
    await makeRepo(WEB);
    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));
    await joinWorkspace({ projectRoot: WEB, workspaceName: 'ws', repoName: 'web' });
    await joinWorkspace({ projectRoot: API, workspaceName: 'ws', repoName: 'api' });
    resetWriteOwnershipCache();

    // web records and shares a fact that api is about to record differently.
    await initDb(WEB);
    const webProject = (await repo.createProject(WEB, 'web')).id;
    const stored = await storeKnowledgeItemDeduped(webProject, {
      category: 'decision',
      title: 'Session store is redis',
      content: 'Sessions are kept in redis with a thirty minute expiry.',
    });
    await closeDb();
    await promoteItems({ projectRoot: WEB, repoName: 'web', ids: [stored.item.id], apply: true });
    resetWriteOwnershipCache();
  });

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    for (const dir of [HOME, API, WEB]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('reports a shared peer item covering the same subject', async () => {
    await initDb(API);
    try {
      const workspace = (await resolveWorkspace(API))!;
      const overlap = await findCrossRepoOverlap({ workspace, item: REDIS });

      expect(overlap).toHaveLength(1);
      expect(overlap[0]).toMatchObject({ repo: 'web', title: 'Session store is redis', kind: 'duplicate' });
    } finally {
      await closeDb();
    }
  });

  it('does not report a peer item the other repo kept private', async () => {
    await initDb(WEB);
    await getClient().execute("UPDATE knowledge_items SET visibility = 'repo'");
    await closeDb();

    await initDb(API);
    try {
      const workspace = (await resolveWorkspace(API))!;
      expect(await findCrossRepoOverlap({ workspace, item: REDIS })).toEqual([]);
    } finally {
      await closeDb();
    }
  });

  it('reports an exclusive conflict key held by another repo', async () => {
    await initDb(WEB);
    await getClient().execute(
      "UPDATE knowledge_items SET conflict_key = 'session.store', conflict_exclusive = 1, visibility = 'workspace'",
    );
    await closeDb();

    await initDb(API);
    try {
      const workspace = (await resolveWorkspace(API))!;
      const overlap = await findCrossRepoOverlap({
        workspace,
        item: {
          category: 'decision',
          title: 'Session store is memcached',
          content: 'Sessions are kept in memcached.',
          conflictKey: 'session.store',
          conflictExclusive: true,
        },
      });

      expect(overlap.some(entry => entry.kind === 'conflict' && entry.repo === 'web')).toBe(true);
    } finally {
      await closeDb();
    }
  });

  it('does not report an exclusive conflict the other repo kept private', async () => {
    // The privacy rule applies to the conflict path as well as the search path, and it has
    // to be a SQL predicate: reading a private row and then discarding it still means a
    // repo's unshared knowledge entered another repo's process.
    await initDb(WEB);
    await getClient().execute(
      "UPDATE knowledge_items SET conflict_key = 'session.store', conflict_exclusive = 1, visibility = 'repo'",
    );
    await closeDb();

    await initDb(API);
    try {
      const workspace = (await resolveWorkspace(API))!;
      const overlap = await findCrossRepoOverlap({
        workspace,
        item: {
          category: 'decision',
          title: 'Session store is memcached',
          content: 'Sessions are kept in memcached.',
          conflictKey: 'session.store',
          conflictExclusive: true,
        },
      });

      expect(overlap).toEqual([]);
    } finally {
      await closeDb();
    }
  });

  it('returns nothing and costs nothing outside a workspace', async () => {
    await initDb(API);
    try {
      expect(await findCrossRepoOverlap({ workspace: null, item: REDIS })).toEqual([]);
    } finally {
      await closeDb();
    }
  });

  it('never throws when a peer is unreadable', async () => {
    await initDb(API);
    try {
      const workspace = (await resolveWorkspace(API))!;
      const broken = {
        ...workspace,
        peers: workspace.peers.map(peer => ({ ...peer, databasePath: path.resolve('./.knowl-overlap-nope/none.db') })),
      };
      await expect(findCrossRepoOverlap({ workspace: broken, item: REDIS })).resolves.toEqual([]);
    } finally {
      await closeDb();
    }
  });

  it('attaches the report to a single-atom write', async () => {
    await initDb(API);
    try {
      const projectId = (await repo.createProject(API, 'api')).id;
      const result = await storeKnowledgeItemDeduped(projectId, REDIS);
      expect(result.crossRepo).toHaveLength(1);
      expect(result.crossRepo![0]).toMatchObject({ repo: 'web', kind: 'duplicate' });
    } finally {
      await closeDb();
    }
  });

  it('attaches an overlap to the right atom in a batch', async () => {
    // The batch path is the one agents use when they have several findings at once. Wiring
    // only the single-atom writer would leave the feature off where it is used most.
    await initDb(API);
    try {
      const projectId = (await repo.createProject(API, 'api')).id;
      const batch = await storeKnowledgeAtomsDeduped(projectId, [
        { category: 'fact', title: 'Unrelated to anything', content: 'Nothing else mentions this subject.' },
        REDIS,
      ]);

      const [unrelated, overlapping] = batch.outcomes;
      expect(unrelated.crossRepo).toBeUndefined();
      expect(overlapping.crossRepo).toHaveLength(1);
      expect(overlapping.crossRepo![0]).toMatchObject({ repo: 'web', kind: 'duplicate' });
    } finally {
      await closeDb();
    }
  });

  it('leaves the peer database byte-identical', async () => {
    const peerDb = path.join(WEB, '.knowl', 'knowl.db');
    const before = await fs.readFile(peerDb);
    await initDb(API);
    try {
      const workspace = (await resolveWorkspace(API))!;
      await findCrossRepoOverlap({ workspace, item: REDIS });
    } finally {
      await closeDb();
      await releaseAll();
    }
    expect((await fs.readFile(peerDb)).equals(before)).toBe(true);
  });
});
