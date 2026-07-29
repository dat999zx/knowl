import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import {
  loadForeignPeerChanges,
  mergeChangeSummaries,
  readPeerCommitHeads,
} from '../../src/store/change-watermark.js';
import { resolveStorage } from '../../src/store/storage-roles.js';
import type { PeerRepo } from '../../src/workspace/resolve.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';

const PEER_ROOT = path.resolve('./.knowl-peer-watermark-peer');
const GONE_ROOT = path.resolve('./.knowl-peer-watermark-gone');

const peer = (): PeerRepo => ({
  name: 'server',
  root: PEER_ROOT,
  databasePath: resolveStorage(PEER_ROOT).knowledge,
  present: true,
});

/** Everything runs against the peer's own database, opened as the peer's own writer. */
async function inPeer<T>(fn: () => Promise<T>): Promise<T> {
  await initDb(PEER_ROOT);
  try {
    return await fn();
  } finally {
    await closeDb();
  }
}

describe('peer change detection', () => {
  let shared = '';
  let priv = '';

  beforeAll(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(PEER_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(PEER_ROOT, '.knowl'), { recursive: true });

    await inPeer(async () => {
      await getClient().execute('DELETE FROM knowledge_commits');
      await getClient().execute('DELETE FROM knowledge_items');
      const projectId = (await repo.createProject(PEER_ROOT, 'peer')).id;

      const promoted = await storeKnowledgeItemDeduped(projectId, {
        category: 'decision', title: 'Auth token TTL is fifteen minutes',
        content: 'Access tokens expire after fifteen minutes.',
      });
      const secret = await storeKnowledgeItemDeduped(projectId, {
        category: 'fact', title: 'Peer internal scratch note',
        content: 'A repo-private note that must never reach another repo.',
      });
      shared = promoted.item.id;
      priv = secret.item.id;
      await getClient().execute(
        `UPDATE knowledge_items SET visibility = 'workspace' WHERE id = '${shared}'`,
      );
    });
  });

  afterAll(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(PEER_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.rm(GONE_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('reads a peer head without opening its database for writing', async () => {
    const heads = await readPeerCommitHeads([peer()]);
    expect(heads.server).toBeGreaterThan(0);
  });

  it('omits an absent peer rather than failing the whole read', async () => {
    const heads = await readPeerCommitHeads([
      peer(),
      { name: 'gone', root: GONE_ROOT, databasePath: resolveStorage(GONE_ROOT).knowledge, present: false },
    ]);
    expect(Object.keys(heads)).toEqual(['server']);
  });

  it('reports a workspace-visible peer change, tagged with the repo it came from', async () => {
    const seen = (await readPeerCommitHeads([peer()])).server;
    await inPeer(async () => {
      await repo.createKnowledgeCommit('local', 'Peer update', [
        { itemId: shared, action: 'update', after: { id: shared, category: 'decision', title: 'Auth token TTL is five minutes' } },
      ]);
    });

    const summary = await loadForeignPeerChanges(peer(), seen);
    expect(summary.count).toBe(1);
    expect(summary.items[0]).toEqual({
      itemId: shared,
      category: 'decision',
      title: 'Auth token TTL is five minutes',
      action: 'update',
      repo: 'server',
    });
  });

  it('never reports a repo-private peer item, not even its title', async () => {
    const seen = (await readPeerCommitHeads([peer()])).server;
    await inPeer(async () => {
      await repo.createKnowledgeCommit('local', 'Private update', [
        { itemId: priv, action: 'update', after: { id: priv, category: 'fact', title: 'Peer internal scratch note' } },
      ]);
    });

    const summary = await loadForeignPeerChanges(peer(), seen);
    expect(summary.count).toBe(0);
    expect(JSON.stringify(summary)).not.toContain('scratch');
  });

  it('drops a hard-deleted item, because nothing is left to prove it was shared', async () => {
    const seen = (await readPeerCommitHeads([peer()])).server;
    await inPeer(async () => {
      await repo.createKnowledgeCommit('local', 'Peer delete', [
        { itemId: 'vanished-item', action: 'delete', before: { id: 'vanished-item', category: 'fact', title: 'Deleted peer item' } },
      ]);
    });

    expect(await loadForeignPeerChanges(peer(), seen)).toEqual({ count: 0, items: [] });
  });

  it('bounds the window at `until`, so a caller can exclude concurrent commits', async () => {
    const seen = (await readPeerCommitHeads([peer()])).server;
    await inPeer(async () => {
      await repo.createKnowledgeCommit('local', 'First', [
        { itemId: shared, action: 'update', after: { id: shared, category: 'decision', title: 'First change' } },
      ]);
    });
    const midpoint = (await readPeerCommitHeads([peer()])).server;
    await inPeer(async () => {
      await repo.createKnowledgeCommit('local', 'Second', [
        { itemId: shared, action: 'update', after: { id: shared, category: 'decision', title: 'Second change' } },
      ]);
    });

    const bounded = await loadForeignPeerChanges(peer(), seen, midpoint);
    expect(bounded.items.map(item => item.title)).toEqual(['First change']);
  });
});

describe('mergeChangeSummaries', () => {
  it('returns undefined when every summary is empty', () => {
    expect(mergeChangeSummaries([{ count: 0, items: [] }, { count: 0, items: [] }])).toBeUndefined();
  });

  it('sums counts and keeps local changes ahead of peer changes', () => {
    const merged = mergeChangeSummaries([
      { count: 1, items: [{ itemId: 'a', category: 'fact', title: 'Local', action: 'insert' }] },
      { count: 1, items: [{ itemId: 'b', category: 'fact', title: 'Peer', action: 'update', repo: 'server' }] },
    ]);
    expect(merged?.count).toBe(2);
    expect(merged?.items.map(item => item.title)).toEqual(['Local', 'Peer']);
  });
});
