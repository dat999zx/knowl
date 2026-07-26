import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acquireClient, poolSize, releaseAll } from '../../src/store/connection-pool.js';

const ROOT = path.resolve('./.knowl-pool-test');
const DB = path.join(ROOT, 'a.db');
const OTHER = path.join(ROOT, 'b.db');

describe('connection pool', () => {
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(ROOT, { recursive: true });
  });
  afterAll(async () => { await releaseAll(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('returns the same client for the same path', async () => {
    await releaseAll();
    const first = await acquireClient(DB);
    const second = await acquireClient(DB);
    expect(second).toBe(first);
    expect(poolSize()).toBe(1);
  });

  it('keys on the resolved path, so two paths are two clients', async () => {
    await releaseAll();
    await acquireClient(DB);
    await acquireClient(OTHER);
    expect(poolSize()).toBe(2);
  });

  it('bootstraps a writable open, so the schema exists', async () => {
    await releaseAll();
    const client = await acquireClient(DB);
    const result = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_items'");
    expect(result.rows.length).toBe(1);
  });

  it('does not bootstrap a read-only open', async () => {
    await releaseAll();
    const fresh = path.join(ROOT, 'read-only.db');
    const client = await acquireClient(fresh, { readOnly: true });
    const result = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_items'");
    expect(result.rows.length).toBe(0);
  });

  it('does not hand a writable client to a read-only caller, or the reverse', async () => {
    await releaseAll();
    const shared = path.join(ROOT, 'mode.db');
    const writable = await acquireClient(shared);
    const readOnly = await acquireClient(shared, { readOnly: true });
    expect(readOnly).not.toBe(writable);
    expect(poolSize()).toBe(2);
  });

  it('leaves a peer database byte-identical when only read', async () => {
    await releaseAll();
    // The point of the read-only mode: bootstrapSchema includes
    // migrateLegacyProjectSchema, so opening a database to read it used to migrate it.
    const peer = path.join(ROOT, 'peer.db');
    const writer = await acquireClient(peer);
    await writer.execute("INSERT INTO knowledge_items (id, category, status, title, content, confidence, version, created_at, updated_at) VALUES ('x', 'fact', 'active', 't', 'c', 1.0, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')");
    await releaseAll();

    const before = await fs.readFile(peer);
    const reader = await acquireClient(peer, { readOnly: true });
    await reader.execute('SELECT id FROM knowledge_items');
    await releaseAll();
    const after = await fs.readFile(peer);

    expect(after.equals(before)).toBe(true);
  });

  it('releaseAll empties the pool', async () => {
    await acquireClient(DB);
    await releaseAll();
    expect(poolSize()).toBe(0);
  });
});
