import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { createKnowledgeItem, getKnowledgeItem, supersedeKnowledgeItem, updateKnowledgeItem } from '../../src/store/repository.js';
import { checkKnowledgeConflict, normalizeConflictKey, repairUnnormalizedConflictKeys } from '../../src/store/conflicts.js';

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

  it('normalizes a key written through UPDATE, not only through create', async () => {
    // The regression. `createKnowledgeItem` normalized; `updateKnowledgeItem` spread its
    // `updates` object into the row verbatim. Every lookup runs on the normalized form, so a
    // key stored raw matched nothing ever again: the row went invisible to the exclusivity
    // check meant to keep it unique AND to the reader meant to retire it — which is how six
    // spent session handoffs stayed active and kept re-injecting.
    const item = await createKnowledgeItem('local', {
      category: 'state', title: 'Handoff under test', content: 'first',
      conflictKey: 'pending-session-handoff:claude', conflictExclusive: true,
    } as any);
    expect(item.conflictKey).toBe('pending.session.handoff.claude');

    await updateKnowledgeItem(item.id, {
      content: 'second', conflictKey: 'pending-session-handoff:claude', conflictExclusive: true,
    } as any);

    expect((await getKnowledgeItem(item.id))!.conflictKey).toBe('pending.session.handoff.claude');
    await expect(checkKnowledgeConflict({ conflictKey: 'pending-session-handoff:claude', conflictExclusive: true }))
      .resolves.toEqual([expect.objectContaining({ id: item.id })]);
  });

  it('leaves identity alone when an update does not mention it', async () => {
    const item = await createKnowledgeItem('local', {
      category: 'fact', title: 'Untouched identity', content: 'first',
      conflictKey: 'some.identity', conflictScope: { env: 'prod' }, conflictExclusive: true,
    } as any);
    await updateKnowledgeItem(item.id, { content: 'second' } as any);
    const reread = await getKnowledgeItem(item.id);
    expect(reread!.conflictKey).toBe('some.identity');
    expect(reread!.conflictScope).toEqual({ env: 'prod' });
  });

  it('repairs keys already stored raw, and settles the duplicates that exposes', async () => {
    // Rows written raw by the old code were invisible to the exclusivity check, so the same
    // identity could be claimed twice. Normalizing makes that collision visible for the first
    // time, so the repair has to settle it or leave the store asserting two active answers.
    const older = await createKnowledgeItem('local', {
      category: 'state', title: 'Raw handoff older', content: 'older',
      conflictKey: 'legacy.raw.identity', conflictExclusive: true,
    } as any);
    const newer = await createKnowledgeItem('local', {
      category: 'state', title: 'Raw handoff newer', content: 'newer',
      conflictKey: 'unrelated.identity', conflictExclusive: true,
    } as any);

    // Reproduce the corruption the old update path produced: both rows raw, same identity.
    for (const [id, when] of [[older.id, '2026-07-23T10:14:44.000Z'], [newer.id, '2026-07-26T10:26:56.000Z']] as const) {
      await getClient().execute({
        sql: 'UPDATE knowledge_items SET conflict_key = ?, updated_at = ? WHERE id = ?',
        args: ['legacy-raw:identity', when, id],
      });
    }

    const result = await repairUnnormalizedConflictKeys();
    expect(result.repaired).toBe(2);
    expect(result.archived).toBe(1);

    expect((await getKnowledgeItem(older.id))!.conflictKey).toBe('legacy.raw.identity');
    expect((await getKnowledgeItem(newer.id))!.conflictKey).toBe('legacy.raw.identity');
    // Newest wins; the older duplicate is retired rather than left contradicting it.
    expect((await getKnowledgeItem(newer.id))!.status).toBe('active');
    expect((await getKnowledgeItem(older.id))!.status).toBe('archived');
  });
});
