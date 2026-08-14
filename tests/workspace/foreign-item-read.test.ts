import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { createManifest } from '../../src/workspace/manifest.js';
import { findForeignItem } from '../../src/workspace/ownership.js';
import { resolveStorage } from '../../src/store/storage-roles.js';
import type { ActiveWorkspace } from '../../src/workspace/resolve.js';

/**
 * Reading an atom a linked repo owns.
 *
 * The id-fetch refusal this serves was a *not-found*, not a guard: `getKnowledgeItem` reads the
 * local store, so a sibling's id was simply absent and the message explained the absence in
 * ownership terms. These tests pin the four ways the answer can be "no" -- no workspace, no peer
 * holds it, the peer is not checked out, the peer's database is missing -- because only the
 * first two mean the item does not exist, and an unreadable peer must never be reported as one
 * that said no.
 */

const ROOT = path.resolve('.knowl-foreign-read');
const PEER = path.join(ROOT, 'peer');
const SELF = path.join(ROOT, 'self');

let peerItemId = '';
let peerDatabasePath = '';

function workspaceWith(options: { present: boolean; databasePath: string }): ActiveWorkspace {
  const manifest = createManifest('sandbox', null);
  manifest.repos = [{ name: 'self', path: SELF }, { name: 'peer', path: PEER }];
  return {
    name: 'sandbox',
    repo: 'self',
    manifest,
    peers: [{ name: 'peer', root: PEER, databasePath: options.databasePath, present: options.present }],
    cloud: null,
  };
}

describe('findForeignItem', () => {
  beforeAll(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(PEER, '.knowl'), { recursive: true });
    await fs.mkdir(path.join(SELF, '.knowl'), { recursive: true });

    await initDb(PEER);
    const peerProject = (await repo.createProject(PEER, 'peer')).id;
    const item = await repo.createKnowledgeItem(peerProject, {
      category: 'fact',
      title: 'Peer owned fact',
      content: 'The body of a fact that lives in the peer repo.',
      reasoning: 'REASONING-SENTINEL: recorded where the work happened.',
      affectedPaths: ['src/peer-only.ts'],
    });
    peerItemId = item.id;
    peerDatabasePath = resolveStorage(PEER).knowledge;
    await closeDb();

    // The caller's own store, open as it would be in a real session.
    await initDb(SELF);
  });

  afterAll(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('returns the owning repo and the whole row', async () => {
    const found = await findForeignItem(peerItemId, workspaceWith({ present: true, databasePath: peerDatabasePath }));
    expect(found?.repo).toBe('peer');
    expect(found?.item.title).toBe('Peer owned fact');
    expect(found?.item.content).toContain('lives in the peer repo');
    // The fields a search result drops travel too, or this is not a whole-record read.
    expect(found?.item.reasoning).toContain('REASONING-SENTINEL');
  });

  it('returns null outside a workspace', async () => {
    expect(await findForeignItem(peerItemId, null)).toBeNull();
  });

  it('returns null for an id no peer holds', async () => {
    const absent = workspaceWith({ present: true, databasePath: peerDatabasePath });
    expect(await findForeignItem('no-such-item-000', absent)).toBeNull();
  });

  it('returns null rather than throwing when the peer is not checked out here', async () => {
    expect(await findForeignItem(peerItemId, workspaceWith({ present: false, databasePath: peerDatabasePath }))).toBeNull();
  });

  it('returns null rather than throwing when the peer database is missing', async () => {
    const missing = path.join(PEER, '.knowl', 'does-not-exist.db');
    expect(await findForeignItem(peerItemId, workspaceWith({ present: true, databasePath: missing }))).toBeNull();
  });
});
