import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { auditKnowledgeStore } from '../../src/store/integrity.js';
import { createSnapshot, restoreSnapshot } from '../../src/store/snapshots.js';

const TEST_ROOT = path.resolve('./.knowl-integrity-test');

describe('knowledge store integrity', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
  });

  beforeEach(async () => {
    const db = getDb() as any;
    await db.run(sql`DELETE FROM knowledge_commits`);
    await db.run(sql`DELETE FROM knowledge_embeddings`);
    await db.run(sql`DELETE FROM skill_steps`);
    await db.run(sql`DELETE FROM skill_metadata`);
    await db.run(sql`DELETE FROM knowledge_items`);
    await fs.rm(path.join(TEST_ROOT, '.knowl', 'snapshots'), { recursive: true, force: true });
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('reports clean stores without errors', async () => {
    const project = await repo.createProject(TEST_ROOT, 'Integrity test');
    await repo.createKnowledgeItem(project.id, {
      category: 'fact', title: 'Clean item', content: 'Safe durable knowledge.',
    });

    expect(await auditKnowledgeStore()).toEqual({ findings: [] });
  });

  it('reports secret, invalid JSON, invalid status, missing FTS, dangling skill, and dangling embedding findings', async () => {
    const project = await repo.createProject(TEST_ROOT, 'Integrity test');
    const item = await repo.createKnowledgeItem(project.id, {
      category: 'fact', title: 'Corrupt item', content: 'Safe durable knowledge.',
    });
    const db = getDb() as any;
    await db.run(sql`UPDATE knowledge_items SET content = ${'sk-test-123456789012345678901234567890'}, alternatives = ${'bad-json'}, status = ${'broken'} WHERE id = ${item.id}`);
    await db.run(sql`DELETE FROM knowledge_items_fts WHERE item_id = ${item.id}`);
    await db.run(sql`PRAGMA foreign_keys = OFF`);
    await db.run(sql`INSERT INTO skill_steps (id, knowledge_item_id, step_order, instruction, created_at) VALUES ('dangling-step', 'missing-item', 1, 'x', '2026-01-01T00:00:00.000Z')`);
    await db.run(sql`INSERT INTO knowledge_embeddings (knowledge_item_id, provider, model, dimensions, vector, updated_at) VALUES ('missing-item', 'local', 'test', 1, '[0]', '2026-01-01T00:00:00.000Z')`);
    await db.run(sql`PRAGMA foreign_keys = ON`);

    const findings = (await auditKnowledgeStore()).findings;
    expect(findings.map(finding => finding.code)).toEqual(expect.arrayContaining([
      'secret', 'invalid-json', 'invalid-status', 'missing-index-row', 'dangling-reference',
    ]));
    expect(JSON.stringify(findings)).not.toContain('sk-test-123456789012345678901234567890');
  });

  it('creates a verified snapshot and restores it only with confirmation', async () => {
    const project = await repo.createProject(TEST_ROOT, 'Integrity test');
    await repo.createKnowledgeItem(project.id, {
      category: 'fact', title: 'Snapshot item', content: 'Present before snapshot.',
    });

    const snapshot = await createSnapshot(TEST_ROOT);
    expect(snapshot.manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(fs.access(snapshot.path)).resolves.toBeUndefined();
    await expect(restoreSnapshot(TEST_ROOT, path.join(TEST_ROOT, 'missing.db'), { confirm: true })).rejects.toThrow(/not found/i);
    await expect(restoreSnapshot(TEST_ROOT, path.join(TEST_ROOT, '.knowl', 'knowl.db'), { confirm: true })).rejects.toThrow(/live database/i);
    await expect(restoreSnapshot(TEST_ROOT, snapshot.path)).rejects.toThrow(/confirm/i);

    await repo.createKnowledgeItem(project.id, {
      category: 'fact', title: 'After snapshot', content: 'Must be removed by restore.',
    });
    await restoreSnapshot(TEST_ROOT, snapshot.path, { confirm: true });

    const titles = (await repo.listKnowledgeItems(project.id)).map(item => item.title);
    expect(titles).toContain('Snapshot item');
    expect(titles).not.toContain('After snapshot');
  });
});
