import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb, initDb } from '../../src/store/database.js';

const TEST_ROOT = path.resolve('./.knowl-session-schema-test');

describe('memory session schema', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('creates idempotent session tables with lifecycle indexes and cascading events', async () => {
    const db = getDb() as any;
    const tables = await db.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('memory_sessions', 'memory_session_events')`);
    expect(tables.map((row: any) => row.name)).toEqual(expect.arrayContaining(['memory_sessions', 'memory_session_events']));

    const indexes = await db.all(`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_memory_sessions_status_heartbeat', 'idx_memory_session_events_expiry')`);
    expect(indexes.map((row: any) => row.name)).toEqual(expect.arrayContaining(['idx_memory_sessions_status_heartbeat', 'idx_memory_session_events_expiry']));

    const foreignKeys = await db.all(`PRAGMA foreign_key_list(memory_session_events)`);
    expect(foreignKeys).toEqual(expect.arrayContaining([expect.objectContaining({ table: 'memory_sessions', on_delete: 'CASCADE' })]));
  });
});
