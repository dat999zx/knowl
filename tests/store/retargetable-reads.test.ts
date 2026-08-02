import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { searchKnowledgeItems } from '../../src/store/search.js';
import { queryKnowledgeBase } from '../../src/store/queries.js';
import { searchKnowledgeEmbeddings, upsertKnowledgeEmbedding } from '../../src/store/vector.js';
import { openPeerStore } from '../../src/store/store-handle.js';
import { resetWriteOwnershipCache } from '../../src/store/write-ownership.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

const MINE = path.resolve('./.knowl-retarget-mine');
const THEIRS = path.resolve('./.knowl-retarget-theirs');
const peerDb = () => path.join(THEIRS, '.knowl', 'knowl.db');

async function makeRepo(root: string) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
}

async function seed(root: string, title: string, content: string): Promise<string> {
  await initDb(root);
  const projectId = (await repo.createProject(root, 'p')).id;
  const stored = await storeKnowledgeItemDeduped(projectId, { category: 'decision', title, content });
  await closeDb();
  return stored.item.id;
}

describe('reads can target another database', () => {
  beforeEach(async () => {
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    for (const dir of [MINE, THEIRS]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await makeRepo(MINE);
    await makeRepo(THEIRS);
    await seed(MINE, 'Local uses postgres', 'This repository stores data in postgres.');
    await seed(THEIRS, 'Peer uses cassandra', 'That repository stores data in cassandra.');
  });

  afterEach(async () => {
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    for (const dir of [MINE, THEIRS]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('searches the ambient database when no handle is given', async () => {
    await initDb(MINE);
    try {
      const found = await searchKnowledgeItems('local', { query: 'postgres' });
      expect(found.map(item => item.title)).toEqual(['Local uses postgres']);
    } finally {
      await closeDb();
    }
  });

  it('searches the peer when its handle is given, without disturbing the ambient one', async () => {
    await initDb(MINE);
    try {
      const peer = await openPeerStore(peerDb());
      const theirs = await searchKnowledgeItems('local', { query: 'cassandra' }, peer);
      expect(theirs.map(item => item.title)).toEqual(['Peer uses cassandra']);

      // The caller's connection is untouched: the very next local read still works.
      const mine = await searchKnowledgeItems('local', { query: 'postgres' });
      expect(mine.map(item => item.title)).toEqual(['Local uses postgres']);
    } finally {
      await closeDb();
    }
  });

  it('runs queryKnowledgeBase against a peer', async () => {
    await initDb(MINE);
    try {
      const peer = await openPeerStore(peerDb());
      const found = await queryKnowledgeBase('local', { query: 'cassandra' }, peer);
      expect(found.map(item => item.title)).toEqual(['Peer uses cassandra']);
    } finally {
      await closeDb();
    }
  });

  it('hydrates peer rows from the peer, not from the local database', async () => {
    // The failure this catches: FTS returns ids, then getKnowledgeItem loads them. If that
    // load uses the ambient handle, a peer id is looked up locally, found nowhere, and
    // dropped -- an empty result that looks exactly like "the peer knows nothing".
    await initDb(MINE);
    try {
      const peer = await openPeerStore(peerDb());
      const found = await searchKnowledgeItems('local', { query: 'cassandra' }, peer);
      expect(found).toHaveLength(1);
      expect(found[0].content).toBe('That repository stores data in cassandra.');
    } finally {
      await closeDb();
    }
  });

  it('does not return a local item when a peer id collides with a local one', async () => {
    // The other half of the same bug, and the dangerous one: on an id collision the local
    // row is returned as though it came from the peer. Assert on content, never on count.
    await initDb(THEIRS);
    const peerId = String((await getClient().execute(
      "SELECT id FROM knowledge_items WHERE title = 'Peer uses cassandra'",
    )).rows[0].id);
    await closeDb();

    await initDb(MINE);
    try {
      // Force the collision by inserting a local row that carries the peer's id. Re-keying an
      // existing row is not an option: assertions hold a foreign key to it. The content is
      // deliberately unrelated to the query -- hydration does not filter, it just loads the
      // id it was handed, so an unrelated local row is exactly what would come back.
      await getClient().execute({
        sql: "INSERT INTO knowledge_items (id, category, status, title, content, confidence, version, created_at, updated_at) " +
          "VALUES (?, 'fact', 'active', 'Local row wearing the peer id', 'Local content that must never be attributed to the peer.', 1.0, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
        args: [peerId],
      });

      const peer = await openPeerStore(peerDb());
      const found = await searchKnowledgeItems('local', { query: 'cassandra' }, peer);
      expect(found.map(item => item.content)).toEqual(['That repository stores data in cassandra.']);
    } finally {
      await closeDb();
    }
  });

  it('hydrates peer rows from the peer on the vector path too', async () => {
    // Vector search hydrates through getKnowledgeItems, a different call site with the same
    // defect. One test per path, because fixing one does not fix the other.
    await initDb(THEIRS);
    const peerId = String((await getClient().execute(
      "SELECT id FROM knowledge_items WHERE title = 'Peer uses cassandra'",
    )).rows[0].id);
    // Written through the real writer rather than hand-rolled SQL: the table is
    // (knowledge_item_id, provider, model, dimensions, vector, updated_at), and `vector` is
    // whatever encodeVector produces, which has already changed representation once.
    await upsertKnowledgeEmbedding({
      knowledgeItemId: peerId, provider: 'local', model: 'test/model',
      profileFingerprint: 'test-fingerprint',
      dimensions: 3, vector: [0.1, 0.9, 0.2],
    });
    await closeDb();

    await initDb(MINE);
    try {
      const peer = await openPeerStore(peerDb());
      const results = await searchKnowledgeEmbeddings('local', {
        vector: [0.1, 0.9, 0.2], profileFingerprint: 'test-fingerprint', limit: 5,
      }, peer);
      expect(results.map(result => result.item.title)).toEqual(['Peer uses cassandra']);
    } finally {
      await closeDb();
    }
  });

  it('leaves the peer database unchanged after being read', async () => {
    await initDb(MINE);
    try {
      const before = await fs.readFile(peerDb());
      const peer = await openPeerStore(peerDb());
      await queryKnowledgeBase('local', { query: 'cassandra' }, peer);
      await searchKnowledgeItems('local', { query: 'cassandra' }, peer);
      expect((await fs.readFile(peerDb())).equals(before)).toBe(true);
    } finally {
      await closeDb();
    }
  });
});
