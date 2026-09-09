import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

/**
 * An update and its commit record are one transaction.
 *
 * They used to be two, on two connections. When `createKnowledgeCommit` threw, the caller was
 * told the update failed while the row had already changed -- an item left `superseded` with
 * `supersededById` set and nothing logging it. Everything that reads the change LOG rather
 * than the row then misses the retirement: the workspace change notice, blast radius, and
 * `readCommitHead`, which is `MAX(rowid)` of `knowledge_commits`.
 *
 * The failure is injected at the commit writer because that is the half that has to be able to
 * fail for the invariant to mean anything -- a disk error, a lock, a constraint. Mocking the
 * whole repository module and spreading the real one keeps every other caller genuine.
 */
vi.mock('../../src/store/repository.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/store/repository.js')>();
  return { ...actual, createKnowledgeCommit: vi.fn(actual.createKnowledgeCommit) };
});

import { closeDb, getDb, initDb } from '../../src/store/database.js';
import { createKnowledgeCommit, createKnowledgeItem, getKnowledgeItem } from '../../src/store/repository.js';
import { updateKnowledgeItemWithCommit } from '../../src/store/knowledge-actions.js';

const ROOT = path.resolve('./.knowl-update-commit-atomic-test');

async function commitRowsFor(itemId: string): Promise<number> {
  const db = getDb() as any;
  const rows = await db.all(sql`SELECT commit_id FROM knowledge_commit_items WHERE item_id = ${itemId}`);
  return rows.length;
}

describe('an update and its commit', () => {
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('leaves the row untouched when the commit record cannot be written', async () => {
    const item = await createKnowledgeItem('local', {
      category: 'fact', title: 'Retired by a failing commit', content: 'Still current.',
    });
    const replacement = await createKnowledgeItem('local', {
      category: 'fact', title: 'The replacement', content: 'Supersedes the other.',
    });
    const before = await commitRowsFor(item.id);

    vi.mocked(createKnowledgeCommit).mockRejectedValueOnce(new Error('commit log unavailable'));
    await expect(updateKnowledgeItemWithCommit('local', item.id, {
      status: 'superseded', supersededById: replacement.id,
    })).rejects.toThrow(/commit log unavailable/);

    // The caller was told it failed, so the retirement must not have happened.
    const after = (await getKnowledgeItem(item.id))!;
    expect(after.status).toBe('active');
    expect(after.supersededById ?? null).toBeNull();
    expect(after.version).toBe(item.version);
    expect(await commitRowsFor(item.id)).toBe(before);
  });

  it('writes both halves when the commit record succeeds', async () => {
    const item = await createKnowledgeItem('local', {
      category: 'fact', title: 'Retired cleanly', content: 'Still current.',
    });
    const replacement = await createKnowledgeItem('local', {
      category: 'fact', title: 'The clean replacement', content: 'Supersedes the other.',
    });
    const before = await commitRowsFor(item.id);

    await updateKnowledgeItemWithCommit('local', item.id, {
      status: 'superseded', supersededById: replacement.id,
    });

    const after = (await getKnowledgeItem(item.id))!;
    expect(after.status).toBe('superseded');
    expect(after.supersededById).toBe(replacement.id);
    expect(await commitRowsFor(item.id)).toBe(before + 1);
  });
});
