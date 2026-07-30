import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { createKnowledgeItem, supersedeKnowledgeItem } from '../../src/store/repository.js';
import { checkKnowledgeConflict, normalizeConflictKey } from '../../src/store/conflicts.js';

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
});
