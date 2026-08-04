import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeAtomsDeduped, storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { resetWriteOwnershipCache } from '../../src/store/write-ownership.js';

let counter = 0;
let ROOT = '';

async function orphanedAssertions(): Promise<number> {
  const result = await getClient().execute(
    'SELECT COUNT(*) AS n FROM knowledge_assertions a LEFT JOIN knowledge_items i ON i.id = a.knowledge_item_id WHERE i.id IS NULL',
  );
  return Number(result.rows[0].n);
}

describe('batch ingest lands whole or not at all', () => {
  let projectId = '';
  beforeEach(async () => {
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    counter += 1;
    ROOT = path.resolve(`./.knowl-batch-integrity${counter}`);
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'batch-integrity')).id;
  });
  afterEach(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('leaves nothing behind when a later atom is refused', async () => {
    // The commit record was written once, after the loop, so a throw skipped it while the
    // atoms already written stayed. The caller was told the call failed and four rows
    // disagreed -- and with no commit naming them, blast-radius can never implicate them
    // when one of them turns out to be wrong.
    await expect(storeKnowledgeAtomsDeduped(projectId, [
      { category: 'fact', title: 'First atom of the batch', content: 'Short enough to pass.' },
      { category: 'fact', title: 'Second atom of the batch', content: 'x'.repeat(400) },
      { category: 'fact', title: 'Third atom of the batch', content: 'Never reached.' },
    ], 'Partial batch', { maxFieldLength: 60 })).rejects.toThrow();

    const items = await repo.listKnowledgeItems();
    expect(items.map(item => item.title)).not.toContain('First atom of the batch');
    expect(items).toHaveLength(0);
    expect(await orphanedAssertions()).toBe(0);

    const commits = await repo.getKnowledgeCommits(projectId);
    expect(commits.some(commit => commit.message === 'Partial batch')).toBe(false);
  });

  it('does not retire a predecessor for a batch that then fails', async () => {
    // The supersede is a write too. Retiring the old answer and then losing the new one
    // leaves the store with no active answer at all.
    const seed = await storeKnowledgeItemDeduped(projectId, {
      category: 'state', title: 'Session outcome', content: 'Finished the retrieval refactor.',
    });

    await expect(storeKnowledgeAtomsDeduped(projectId, [
      { category: 'state', title: 'Session outcome', content: 'Finished the retrieval refactor and the viewer rewrite.' },
      { category: 'fact', title: 'Oversized atom', content: 'y'.repeat(400) },
    ], 'Finalize memory session', { maxFieldLength: 80 })).rejects.toThrow();

    expect((await repo.getKnowledgeItem(seed.item.id))!.status).toBe('active');
  });

  it('commits every atom of a batch that succeeds', async () => {
    const result = await storeKnowledgeAtomsDeduped(projectId, [
      { category: 'fact', title: 'Search backend', content: 'Full-text search runs on SQLite FTS5.' },
      { category: 'fact', title: 'Queue driver', content: 'Background jobs run on Redis.' },
    ], 'Whole batch');

    expect(result.insertedCount).toBe(2);
    const commits = await repo.getKnowledgeCommits(projectId);
    const commit = commits.find(entry => entry.message === 'Whole batch');
    expect(commit).toBeTruthy();
    expect(commit!.changes.map(change => change.itemId).sort()).toEqual([...result.itemIds].sort());
  });

  it('enforces an exclusive conflict key declared by a batch atom', async () => {
    // The batch writer dropped conflictKey, conflictScope and conflictExclusive on the floor
    // while the comment on the input type claimed both store paths forwarded them, so
    // exclusivity was simply off for anything ingested as an atom.
    await storeKnowledgeItemDeduped(projectId, {
      category: 'decision', title: 'Session store engine', content: 'Sessions live in Redis.',
      conflictKey: 'session.store.engine', conflictExclusive: true,
    });

    await expect(storeKnowledgeAtomsDeduped(projectId, [{
      category: 'decision', title: 'Session store engine reconsidered', content: 'Sessions live in Memcached.',
      conflictKey: 'session.store.engine', conflictExclusive: true,
    }], 'Conflicting batch')).rejects.toMatchObject({ code: 'KNOWLEDGE_CONFLICT' });

    expect(await repo.listKnowledgeItems()).toHaveLength(1);
  });

  it('stores the normalized conflict identity a batch atom declared', async () => {
    const result = await storeKnowledgeAtomsDeduped(projectId, [{
      category: 'decision', title: 'Cache eviction policy', content: 'The product cache evicts least-recently-used entries.',
      conflictKey: 'Cache Eviction Policy', conflictScope: { service: 'api' }, conflictExclusive: true,
    }], 'Keyed batch');

    const stored = await repo.getKnowledgeItem(result.itemIds[0]);
    expect(stored!.conflictKey).toBe('cache.eviction.policy');
    expect(stored!.conflictExclusive).toBe(true);
    expect(stored!.conflictScope).toEqual({ service: 'api' });
  });
});
