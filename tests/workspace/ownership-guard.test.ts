import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { bootstrapSchema } from '../../src/store/bootstrap.js';
import { KNOWL_SCHEMA_VERSION } from '../../src/store/schema-version.js';
import { assertOwnedItem, ForeignItemError, UnverifiedOwnerError } from '../../src/workspace/ownership.js';
import { resolveWorkspace } from '../../src/workspace/resolve.js';
import { createManifest, normalizeRepoEntry, readManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { joinWorkspace } from '../../src/workspace/membership.js';
import { resolveStorage } from '../../src/store/storage-roles.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

const HOME = path.resolve('./.knowl-owner-guard-home');
const A = path.resolve('./.knowl-owner-guard-a');
/** Listed in the manifest, never checked out here. Partial checkout is a supported state. */
const NEVER_CLONED = path.resolve('./.knowl-owner-guard-not-here');
/** Checked out, but no database has ever been written into it. */
const C = path.resolve('./.knowl-owner-guard-c');

/**
 * A fresh peer directory per test.
 *
 * One test deliberately writes a peer database this build cannot open. Windows keeps a handle
 * on a closed SQLite file long enough that the teardown removal is best-effort everywhere in
 * this suite, so a shared peer path leaks that database into the tests that follow it.
 */
let peerIndex = 0;
let B = '';

let localItemId = '';
const FOREIGN_ITEM_ID = 'item-owned-by-b';

async function addPeer(name: string, root: string) {
  const manifest = await readManifest(workspaceManifestPath('ws'));
  manifest.repos.push(normalizeRepoEntry({ name, path: root, addedAt: new Date().toISOString() }));
  await writeManifest(workspaceManifestPath('ws'), manifest);
}

async function guard(ids: string | Array<string | null | undefined>) {
  await initDb(A);
  try {
    return await assertOwnedItem(ids, (await resolveWorkspace(A))!);
  } finally {
    await closeDb();
  }
}

describe('the ownership guard', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    B = path.resolve(`./.knowl-owner-guard-b${peerIndex += 1}`);
    for (const dir of [HOME, A, B, C, NEVER_CLONED]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});

    await fs.mkdir(path.join(A, '.knowl'), { recursive: true });
    await saveConfig(A, { ...DEFAULT_CONFIG });
    await initDb(A);
    const projectId = (await repo.createProject(A, 'a')).id;
    const stored = await storeKnowledgeItemDeduped(projectId, {
      category: 'decision', title: 'Local auth note', content: 'Auth tokens expire locally.',
    });
    localItemId = stored.item.id;
    // A row this repo holds but does not own. Reachable through import, and through any
    // future shared database -- which is the case ownership exists for.
    // OR REPLACE because Windows sometimes keeps a handle on the database file after close,
    // so the afterEach directory removal is best-effort in every suite here.
    await getClient().execute({
      sql: `INSERT OR REPLACE INTO knowledge_items (id, category, status, title, content, confidence, version,
              created_at, updated_at, origin_repo, visibility)
            VALUES (?, 'decision', 'active', 'Peer policy', 'Written by b.', 1.0, 1, ?, ?, 'b', 'workspace')`,
      args: [FOREIGN_ITEM_ID, new Date().toISOString(), new Date().toISOString()],
    });
    await closeDb();

    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));
    await joinWorkspace({ projectRoot: A, workspaceName: 'ws', repoName: 'a' });
  });

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B, C, NEVER_CLONED]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  describe('checks every id an operation touches, not just the first (K-07)', () => {
    it('refuses when the second id is foreign, even though the first is ours', async () => {
      // knowl_update checks `id` and then supersedes `supersedeId` unchecked; knowl_store,
      // knowl_ingest_atoms and knowl_decide have the same gap on `supersedes`. Retiring
      // another repo's item is precisely what a single owner per item exists to prevent.
      await expect(guard([localItemId, FOREIGN_ITEM_ID])).rejects.toThrow(ForeignItemError);
      await expect(guard([localItemId, FOREIGN_ITEM_ID])).rejects.toThrow(/belongs to repo "b"/);
    });

    it('passes when every id given is ours', async () => {
      await expect(guard([localItemId, localItemId])).resolves.toBeUndefined();
    });

    it('ignores absent ids, so an optional second id costs nothing', async () => {
      await expect(guard([localItemId, undefined, null, ''])).resolves.toBeUndefined();
    });

    it('still takes a bare id', async () => {
      await expect(guard(FOREIGN_ITEM_ID)).rejects.toThrow(ForeignItemError);
    });
  });

  describe('does not conclude "local" from "could not check" (K-08)', () => {
    it('refuses an unknown id while a peer is not checked out here', async () => {
      await addPeer('b', NEVER_CLONED);

      // The peer that is not on this machine is exactly the one that could own it. Passing
      // here hands the id to a local-only handler, which answers from the wrong database:
      // knowl_timeline reports no history, knowl_evidence_list reports no evidence, and
      // knowl_feedback writes telemetry rows keyed to an item this repo does not have.
      await expect(guard('an-id-that-might-be-bs')).rejects.toThrow(UnverifiedOwnerError);
      await expect(guard('an-id-that-might-be-bs')).rejects.toThrow(/"b"/);
    });

    it('refuses an unknown id while a member repo has no checkout on this machine at all', async () => {
      // A manifest copied off another machine lists every member; only the ones joined here
      // carry a path. `resolveWorkspace` drops the pathless ones before it computes `present`,
      // so they are not even in `peers` -- the literal "2 of 5 repos on a laptop" case.
      const manifest = await readManifest(workspaceManifestPath('ws'));
      manifest.repos.push({ name: 'elsewhere' } as never);
      await writeManifest(workspaceManifestPath('ws'), manifest);

      await expect(guard('an-id-that-might-be-bs')).rejects.toThrow(UnverifiedOwnerError);
      await expect(guard('an-id-that-might-be-bs')).rejects.toThrow(/"elsewhere"/);
    });

    it('refuses an unknown id while a peer database cannot be read', async () => {
      await fs.mkdir(path.join(B, '.knowl'), { recursive: true });
      const client = createClient({ url: `file:${resolveStorage(B).knowledge}` });
      await bootstrapSchema(client);
      await client.execute(`PRAGMA user_version = ${KNOWL_SCHEMA_VERSION + 3}`);
      client.close();
      await addPeer('b', B);

      await expect(guard('an-id-that-might-be-bs')).rejects.toThrow(UnverifiedOwnerError);
    });

    it('leaves the not-found path alone when every peer answered', async () => {
      // A checked-out, readable peer that simply does not hold the id is an answer. So is a
      // peer with no database at all -- a repo with no database holds no items. Refusing
      // here would replace the handler's accurate "no such item" with a worse message.
      await fs.mkdir(path.join(B, '.knowl'), { recursive: true });
      await initDb(B);
      await repo.createProject(B, 'b');
      await closeDb();
      await addPeer('b', B);
      // Checked out, no database of its own: a repo with no database holds no items.
      await fs.mkdir(path.join(C, '.knowl'), { recursive: true });
      await addPeer('c', C);

      await expect(guard('an-id-nobody-has')).resolves.toBeUndefined();
    });

    it('names the owning repo rather than the unreadable one when a peer does claim it', async () => {
      await fs.mkdir(path.join(B, '.knowl'), { recursive: true });
      await initDb(B);
      const projectId = (await repo.createProject(B, 'b')).id;
      const stored = await storeKnowledgeItemDeduped(projectId, {
        category: 'fact', title: 'Held only by b', content: 'This row lives in the peer.',
      });
      await closeDb();
      await addPeer('b', B);
      await addPeer('gone', NEVER_CLONED);

      await expect(guard(stored.item.id)).rejects.toThrow(ForeignItemError);
      await expect(guard(stored.item.id)).rejects.toThrow(/belongs to repo "b"/);
    });
  });

  it('is inert outside a workspace, where every id is local', async () => {
    await initDb(A);
    try {
      await expect(assertOwnedItem([localItemId, FOREIGN_ITEM_ID], null)).resolves.toBeUndefined();
    } finally {
      await closeDb();
    }
  });
});
