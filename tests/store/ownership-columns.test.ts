import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { queryKnowledgeForAgent } from '../../src/store/agent-query.js';

const ROOT = path.resolve('./.knowl-ownership-test');

describe('ownership and visibility columns', () => {
  let projectId = '';
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'ownership')).id;
  });
  afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('adds both columns to knowledge_items', async () => {
    const result = await getClient().execute('PRAGMA table_info(knowledge_items)');
    const columns = result.rows.map(row => String(row.name));
    expect(columns).toContain('origin_repo');
    expect(columns).toContain('visibility');
  });

  it('leaves a write unowned and repo-visible outside a workspace', async () => {
    const stored = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Bootstrap runs on every open',
      content: 'bootstrapSchema is invoked by initDbPath for each connection.',
    });
    const row = (await getClient().execute({
      sql: 'SELECT origin_repo, visibility FROM knowledge_items WHERE id = ?',
      args: [stored.item.id],
    })).rows[0];
    expect(row.origin_repo).toBeNull();
    expect(row.visibility).toBe('repo');
  });

  it('is idempotent across repeated bootstraps', async () => {
    await closeDb();
    await initDb(ROOT);
    const result = await getClient().execute('PRAGMA table_info(knowledge_items)');
    expect(result.rows.filter(row => String(row.name) === 'visibility').length).toBe(1);
    expect(result.rows.filter(row => String(row.name) === 'origin_repo').length).toBe(1);
  });

  it('leaves no row with a null or empty visibility', async () => {
    const row = (await getClient().execute(
      "SELECT COUNT(*) AS n FROM knowledge_items WHERE visibility IS NULL OR visibility = ''",
    )).rows[0];
    expect(Number(row.n)).toBe(0);
  });

  it('returns the same results it would have before the columns existed', async () => {
    await storeKnowledgeItemDeduped(projectId, {
      category: 'decision', title: 'Connections are pooled by resolved path',
      content: 'Clients are cached per resolved path and open mode.',
    });
    const items = await queryKnowledgeForAgent('local', { query: 'connections pooled', limit: 3, surface: 'test' });
    expect(items.length).toBeGreaterThan(0);
    // The columns exist but nothing reads them yet, so no ownership leaks into results.
    expect(items.every(item => (item as Record<string, unknown>).origin_repo === undefined)).toBe(true);
  });

  it('backfills visibility on rows written before the column existed', async () => {
    const legacyRoot = path.resolve('./.knowl-ownership-legacy-test');
    await fs.rm(legacyRoot, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(legacyRoot, '.knowl'), { recursive: true });

    const { createClient } = await import('@libsql/client');
    const { bootstrapSchema } = await import('../../src/store/bootstrap.js');
    const dbPath = path.join(legacyRoot, '.knowl', 'knowl.db');
    const client = createClient({ url: `file:${dbPath}` });
    try {
      // The 2.3-era table: everything the current schema has except the two new columns.
      // A NOT NULL default does not apply retroactively, so the backfill is what keeps
      // visibility non-null for a row that predates it.
      await client.execute(`CREATE TABLE knowledge_items (
        id TEXT PRIMARY KEY, category TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
        title TEXT NOT NULL, content TEXT NOT NULL, reasoning TEXT, alternatives TEXT,
        tags TEXT, source TEXT, source_commit TEXT, affected_paths TEXT, content_hash TEXT,
        freshness TEXT NOT NULL DEFAULT 'fresh', confidence REAL NOT NULL DEFAULT 1.0,
        conflict_key TEXT, conflict_scope TEXT, conflict_exclusive INTEGER NOT NULL DEFAULT 0,
        superseded_by_id TEXT, version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );`);
      await client.execute(`INSERT INTO knowledge_items (id, category, title, content, created_at, updated_at)
        VALUES ('legacy1', 'fact', 'Old row', 'Written before the column existed.',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');`);

      await bootstrapSchema(client);

      const row = (await client.execute("SELECT origin_repo, visibility FROM knowledge_items WHERE id = 'legacy1'")).rows[0];
      expect(row.visibility).toBe('repo');
      expect(row.origin_repo).toBeNull();
    } finally {
      client.close();
      await fs.rm(legacyRoot, { recursive: true, force: true }).catch(() => {});
    }
  });
});
