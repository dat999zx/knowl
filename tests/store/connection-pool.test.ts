import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  failNextBootstrap: false,
  createdClients: [] as any[],
}));

// Wraps every real client's close() in a spy so failure tests can assert it was
// (or wasn't) called, without faking SQLite behavior itself.
vi.mock('@libsql/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@libsql/client')>();
  return {
    ...actual,
    createClient: (config: Parameters<typeof actual.createClient>[0]) => {
      const client = actual.createClient(config);
      const originalClose = client.close.bind(client);
      (client as any).close = vi.fn(originalClose);
      mockState.createdClients.push(client);
      return client;
    },
  };
});

vi.mock('../../src/store/bootstrap.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/store/bootstrap.js')>();
  return {
    ...actual,
    bootstrapSchema: async (client: any) => {
      if (mockState.failNextBootstrap) {
        mockState.failNextBootstrap = false;
        throw new Error('SQLITE_BUSY: simulated bootstrap failure');
      }
      return actual.bootstrapSchema(client);
    },
  };
});

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

  it('refuses a write attempted on a read-only client, at the engine level', async () => {
    // Today "read-only" just means this code path happens not to call a write
    // function. Nothing stops a future bug from handing this client to a write path
    // and silently mutating a peer repo's database. query_only makes SQLite itself
    // reject it instead.
    await releaseAll();
    const target = path.join(ROOT, 'query-only.db');
    const writer = await acquireClient(target);
    await writer.execute(
      "INSERT INTO knowledge_items (id, category, status, title, content, confidence, version, created_at, updated_at) " +
      "VALUES ('q1', 'fact', 'active', 't', 'c', 1.0, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')"
    );
    await releaseAll();

    const reader = await acquireClient(target, { readOnly: true });
    await expect(reader.execute("DELETE FROM knowledge_items WHERE id = 'q1'")).rejects.toThrow(/readonly/i);
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

  it('closes the client instead of leaking it when bootstrap fails', async () => {
    await releaseAll();
    mockState.createdClients.length = 0;
    mockState.failNextBootstrap = true;
    const target = path.join(ROOT, 'bootstrap-fail.db');

    await expect(acquireClient(target)).rejects.toThrow('simulated bootstrap failure');

    // A leaked, un-closed client keeps whatever lock its partial bootstrap took,
    // wedging every later acquire on this path for the rest of the process.
    expect(mockState.createdClients).toHaveLength(1);
    expect(mockState.createdClients[0].close).toHaveBeenCalledTimes(1);
    expect(poolSize()).toBe(0);
  });
});
