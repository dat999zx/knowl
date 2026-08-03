import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { auditKnowledgeStore } from '../../src/store/integrity.js';
import { createKnowledgeItem, getKnowledgeItem, supersedeKnowledgeItem, updateKnowledgeItem } from '../../src/store/repository.js';
import { checkKnowledgeConflict, isNormalizedConflictKey, normalizeConflictKey } from '../../src/store/conflicts.js';

const ROOT = path.resolve('./.knowl-conflicts-test');

describe('knowledge conflict keys', () => {
  beforeAll(async () => { await fs.rm(ROOT, { recursive: true, force: true }); await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true }); await initDb(ROOT); });
  afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('detects only active exclusive values in the same normalized key and scope', async () => {
    const first = await createKnowledgeItem('local', { category: 'decision', title: 'Production database', content: 'PostgreSQL.', conflictKey: 'Database Production Engine', conflictScope: { environment: 'production' }, conflictExclusive: true } as any);
    expect(normalizeConflictKey('Database Production Engine')).toBe('database.production.engine');
    await expect(checkKnowledgeConflict({ conflictKey: 'database.production.engine', conflictScope: { environment: 'production' }, conflictExclusive: true })).resolves.toEqual([expect.objectContaining({ id: first.id })]);
    await expect(checkKnowledgeConflict({ conflictKey: 'database.production.engine', conflictScope: { environment: 'staging' }, conflictExclusive: true })).resolves.toEqual([]);
    await expect(checkKnowledgeConflict({ conflictKey: 'database.production.engine', conflictScope: { environment: 'production' }, conflictExclusive: false })).resolves.toEqual([]);
    await expect(createKnowledgeItem('local', { category: 'decision', title: 'Production database duplicate', content: 'SQLite.', conflictKey: 'database.production.engine', conflictScope: { environment: 'production' }, conflictExclusive: true } as any)).rejects.toMatchObject({ code: 'KNOWLEDGE_CONFLICT', conflicts: [{ id: first.id, title: first.title }] });
    const replacement = await createKnowledgeItem('local', { category: 'decision', title: 'Production database replacement', content: 'SQLite.', conflictKey: 'database.production.engine', conflictScope: { environment: 'production' }, conflictExclusive: false } as any);
    await expect(supersedeKnowledgeItem(first.id, replacement.id)).resolves.toMatchObject({ status: 'superseded', supersededById: replacement.id });
  });

  it('detects an exclusive conflict that carries no scope', async () => {
    // Every case above supplies a scope, which is why this went unnoticed: `eq(column, null)`
    // renders `conflict_scope = NULL`, and nothing equals NULL in SQL. A scopeless exclusive
    // key -- the simplest way to declare "only one active answer to this" -- therefore
    // matched nothing and guarded nothing.
    const only = await createKnowledgeItem('local', {
      category: 'decision', title: 'Session store engine', content: 'Redis.',
      conflictKey: 'session.store.engine', conflictExclusive: true,
    } as any);

    await expect(checkKnowledgeConflict({ conflictKey: 'session.store.engine', conflictExclusive: true }))
      .resolves.toEqual([expect.objectContaining({ id: only.id })]);

    // And the guard it exists for now fires.
    await expect(createKnowledgeItem('local', {
      category: 'decision', title: 'Session store engine duplicate', content: 'Memcached.',
      conflictKey: 'session.store.engine', conflictExclusive: true,
    } as any)).rejects.toMatchObject({ code: 'KNOWLEDGE_CONFLICT' });
  });

  describe('conflict key normalization on update', () => {
    it('normalizes a key written through UPDATE, not only through create', async () => {
      const item = await createKnowledgeItem('local', {
        category: 'fact', title: 'Cache backend', content: 'Redis holds the cache.',
      } as any);

      await updateKnowledgeItem(item.id, { conflictKey: '  Mixed CASE  Key  ' } as any);

      const stored = await getKnowledgeItem(item.id);
      expect(stored?.conflictKey).toBe(normalizeConflictKey('  Mixed CASE  Key  '));
    });

    it('leaves identity alone when an update does not mention it', async () => {
      const item = await createKnowledgeItem('local', {
        category: 'fact', title: 'Queue backend', content: 'SQS carries the queue.',
        conflictKey: 'queue.backend',
      } as any);

      await updateKnowledgeItem(item.id, { title: 'Queue backend, revised' } as any);

      const stored = await getKnowledgeItem(item.id);
      expect(stored?.conflictKey).toBe('queue.backend');
    });

    it('repairs keys already stored raw, and settles the duplicates that exposes', async () => {
      // Two rows that are the same identity but were stored differently -- which is exactly
      // what the unnormalized update path used to produce, and why they never collided.
      const first = await createKnowledgeItem('local', {
        category: 'decision', title: 'Search engine', content: 'Meilisearch.',
        conflictKey: 'search.engine.choice', conflictExclusive: true,
      } as any);
      const second = await createKnowledgeItem('local', {
        category: 'decision', title: 'Search engine, revised', content: 'Typesense.',
        conflictKey: 'placeholder.until.rewritten', conflictExclusive: true,
      } as any);
      await getClient().execute({
        sql: 'UPDATE knowledge_items SET conflict_key = ? WHERE id = ?',
        args: ['  Search ENGINE  Choice  ', second.id],
      });

      const report = await auditKnowledgeStore(undefined, { repair: true });

      expect(report.findings.some(finding => finding.code === 'raw-conflict-key' && finding.repaired)).toBe(true);
      expect(report.findings.some(finding => finding.code === 'duplicate-conflict-identity' && finding.repaired)).toBe(true);

      const rows = (await getClient().execute(
        "SELECT id, conflict_key, status FROM knowledge_items WHERE conflict_key = 'search.engine.choice'",
      )).rows;
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(isNormalizedConflictKey(String(row.conflict_key))).toBe(true);

      const stillActive = rows.filter(row => row.status === 'active');
      expect(stillActive).toHaveLength(1);
      // Newest wins; the older row is superseded into it rather than left active beside it.
      expect(String(stillActive[0].id)).toBe(second.id);
      expect((await getKnowledgeItem(first.id))?.supersededById).toBe(second.id);
    });
  });
});
