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
});
