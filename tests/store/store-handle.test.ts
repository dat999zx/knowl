import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, getDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import { localStore, openPeerStore } from '../../src/store/store-handle.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

const ROOT = path.resolve('./.knowl-store-handle');
const PEER = path.resolve('./.knowl-store-handle-peer');
const peerDb = () => path.join(PEER, '.knowl', 'knowl.db');

const INSERT_ITEM =
  "INSERT INTO knowledge_items (id, category, status, title, content, confidence, version, created_at, updated_at) " +
  "VALUES (?, 'fact', 'active', ?, ?, 1.0, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')";

async function makeRepo(root: string) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
}

describe('store handle', () => {
  beforeEach(async () => {
    await closeDb();
    await releaseAll();
    for (const dir of [ROOT, PEER]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await makeRepo(ROOT);
    await makeRepo(PEER);
    // Give the peer a real database file with the full schema.
    await initDb(PEER);
    await closeDb();
  });

  afterEach(async () => {
    await closeDb();
    await releaseAll();
    for (const dir of [ROOT, PEER]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('hands back the ambient database and client', async () => {
    await initDb(ROOT);
    const store = localStore();
    expect(store.client).toBe(getClient());
    expect(store.db).toBe(getDb());
  });

  it('throws when nothing is open, like the functions it wraps', () => {
    expect(() => localStore()).toThrow(/not been initialized/i);
  });

  it('opens a peer read-only, so a write fails loudly instead of mutating it', async () => {
    await initDb(ROOT);
    const peer = await openPeerStore(peerDb());

    await expect(peer.client.execute({
      sql: INSERT_ITEM, args: ['x', 'Written by a reader', 'This must never land.'],
    })).rejects.toThrow();
  });

  it('reads the peer, not the ambient database', async () => {
    await initDb(PEER);
    await getClient().execute({
      sql: INSERT_ITEM, args: ['peer-1', 'Peer fact', 'Only in the peer.'],
    });
    await closeDb();

    await initDb(ROOT);
    const peer = await openPeerStore(peerDb());
    const mine = await getClient().execute('SELECT COUNT(*) AS n FROM knowledge_items');
    const theirs = await peer.client.execute('SELECT COUNT(*) AS n FROM knowledge_items');

    expect(Number(mine.rows[0].n)).toBe(0);
    expect(Number(theirs.rows[0].n)).toBe(1);
  });
});
