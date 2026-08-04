import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { queryFederated } from '../../src/workspace/federated-query.js';
import { assertOwnedItem } from '../../src/workspace/ownership.js';
import { findCrossRepoOverlap } from '../../src/workspace/cross-repo-overlap.js';
import { resolveWorkspace } from '../../src/workspace/resolve.js';
import { createManifest, normalizeRepoEntry, readManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { joinWorkspace } from '../../src/workspace/membership.js';
import { resolveStorage } from '../../src/store/storage-roles.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

const HOME = path.resolve('./.knowl-peer-create-home');
const A = path.resolve('./.knowl-peer-create-a');
const B = path.resolve('./.knowl-peer-create-b');

const peerDb = () => resolveStorage(B).knowledge;
const peerDatabaseExists = () => fs.access(peerDb()).then(() => true, () => false);

async function inLocalRepo<T>(run: (workspace: NonNullable<Awaited<ReturnType<typeof resolveWorkspace>>>) => Promise<T>): Promise<T> {
  await initDb(A);
  try {
    return await run((await resolveWorkspace(A))!);
  } finally {
    await closeDb();
  }
}

/**
 * A peer that is checked out but whose knowledge database is not there.
 *
 * Not a contrived state. `.knowl/` is gitignored, so a freshly cloned member repo has a root
 * and no database until someone runs knowl in it; deleting the database is a supported way to
 * reset a repo; and a restore-in-progress looks exactly like this for its whole duration.
 * `resolveWorkspace` calls such a peer `present`, because presence is a property of the
 * checkout, not of the database.
 */
describe('reading a peer never writes into the peer', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});

    await fs.mkdir(path.join(A, '.knowl'), { recursive: true });
    await saveConfig(A, { ...DEFAULT_CONFIG });
    await initDb(A);
    const projectId = (await repo.createProject(A, 'a')).id;
    await storeKnowledgeItemDeduped(projectId, {
      category: 'decision', title: 'Local auth note', content: 'Auth tokens expire locally.',
    });
    await closeDb();

    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));
    await joinWorkspace({ projectRoot: A, workspaceName: 'ws', repoName: 'a' });

    // Peer "b" is listed and checked out, and has never had a database written into it.
    await fs.mkdir(path.join(B, '.knowl'), { recursive: true });
    const manifest = await readManifest(workspaceManifestPath('ws'));
    manifest.repos.push(normalizeRepoEntry({ name: 'b', path: B, addedAt: new Date().toISOString() }));
    await writeManifest(workspaceManifestPath('ws'), manifest);
  });

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('does not create a database inside a peer that has none, on a federated query', async () => {
    expect(await peerDatabaseExists()).toBe(false);

    await inLocalRepo(workspace => queryFederated({ workspace, query: 'auth', limit: 5 }));
    await releaseAll();

    // `file:<path>` creates. A read that leaves a file behind in someone else's repo is not
    // a read -- the transcripts module refuses this for exactly this reason and says so.
    expect(await peerDatabaseExists()).toBe(false);
  });

  it('reports the peer as absent rather than as a repo that knows nothing', async () => {
    const result = await inLocalRepo(workspace => queryFederated({ workspace, query: 'auth', limit: 5 }));

    // Silence reads as "the peer has nothing on this", which is a different and far more
    // convincing claim than "the peer could not be read".
    expect(result.skipped).toEqual([{ repo: 'b', reason: 'absent' }]);
  });

  it('does not create a database inside a peer while checking item ownership', async () => {
    expect(await peerDatabaseExists()).toBe(false);

    // knowl_timeline / evidence_list / feedback / update all reach this with a bare id.
    await inLocalRepo(workspace => assertOwnedItem('an-id-nobody-has', workspace));
    await releaseAll();

    expect(await peerDatabaseExists()).toBe(false);
  });

  it('does not create a database inside a peer while checking cross-repo overlap', async () => {
    expect(await peerDatabaseExists()).toBe(false);

    await inLocalRepo(workspace => findCrossRepoOverlap({
      workspace,
      item: { category: 'decision', title: 'Auth token TTL', content: 'Auth tokens expire.' },
    }));
    await releaseAll();

    expect(await peerDatabaseExists()).toBe(false);
  });
});
