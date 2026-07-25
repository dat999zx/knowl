import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { loadForeignChanges, readCommitHead } from '../../src/store/change-watermark.js';
import * as repo from '../../src/store/repository.js';

const ROOT = path.resolve('.knowl-change-watermark-test');

describe('foreign change detection', () => {
  let projectId = '';

  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'Change watermark')).id;
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('reports nothing when the watermark is already at head', async () => {
    await repo.createKnowledgeCommit(projectId, 'Baseline', [
      { itemId: 'base', action: 'insert', after: { id: 'base', category: 'fact', title: 'Baseline item' } },
    ]);
    const head = await readCommitHead();

    expect(await loadForeignChanges(head)).toEqual({ count: 0, items: [] });
  });

  it('reports category, title and action for commits after the watermark', async () => {
    const seen = await readCommitHead();
    await repo.createKnowledgeCommit(projectId, 'Sibling insert', [
      { itemId: 'sib-1', action: 'insert', after: { id: 'sib-1', category: 'decision', title: 'Sibling decision' } },
    ]);
    await repo.createKnowledgeCommit(projectId, 'Sibling update', [
      { itemId: 'sib-2', action: 'update', after: { id: 'sib-2', category: 'fact', title: 'Sibling fact' } },
    ]);

    expect(await loadForeignChanges(seen)).toEqual({
      count: 2,
      items: [
        { itemId: 'sib-1', category: 'decision', title: 'Sibling decision', action: 'insert' },
        { itemId: 'sib-2', category: 'fact', title: 'Sibling fact', action: 'update' },
      ],
    });
  });

  it('falls back to before.title when after is absent', async () => {
    const seen = await readCommitHead();
    await repo.createKnowledgeCommit(projectId, 'Supersede', [
      { itemId: 'old-1', action: 'supersede', before: { id: 'old-1', category: 'fact', title: 'Retired fact' } },
    ]);

    expect(await loadForeignChanges(seen)).toEqual({
      count: 1,
      items: [{ itemId: 'old-1', category: 'fact', title: 'Retired fact', action: 'supersede' }],
    });
  });

  it('counts a change with no resolvable title but omits it from items', async () => {
    const seen = await readCommitHead();
    await repo.createKnowledgeCommit(projectId, 'Delete', [
      { itemId: 'gone-1', action: 'delete' },
    ]);

    expect(await loadForeignChanges(seen)).toEqual({ count: 1, items: [] });
  });

  it('collapses repeated changes to one entry carrying the latest action', async () => {
    const seen = await readCommitHead();
    await repo.createKnowledgeCommit(projectId, 'Insert then update', [
      { itemId: 'dup-1', action: 'insert', after: { id: 'dup-1', category: 'fact', title: 'First title' } },
    ]);
    await repo.createKnowledgeCommit(projectId, 'Later update', [
      { itemId: 'dup-1', action: 'update', after: { id: 'dup-1', category: 'fact', title: 'Second title' } },
    ]);

    expect(await loadForeignChanges(seen)).toEqual({
      count: 1,
      items: [{ itemId: 'dup-1', category: 'fact', title: 'Second title', action: 'update' }],
    });
  });

  it('excludes the callers own writes by id and by title', async () => {
    const seen = await readCommitHead();
    await repo.createKnowledgeCommit(projectId, 'My write', [
      { itemId: 'mine-1', action: 'update', after: { id: 'mine-1', category: 'fact', title: 'My own item' } },
    ]);
    await repo.createKnowledgeCommit(projectId, 'Their write', [
      { itemId: 'theirs-1', action: 'insert', after: { id: 'theirs-1', category: 'fact', title: 'Their item' } },
    ]);

    const byId = await loadForeignChanges(seen, { ids: ['mine-1'], titles: [] });
    expect(byId.items.map(item => item.itemId)).toEqual(['theirs-1']);
    expect(byId.count).toBe(1);

    const byTitle = await loadForeignChanges(seen, { ids: [], titles: ['My own item'] });
    expect(byTitle.items.map(item => item.itemId)).toEqual(['theirs-1']);
  });

  it('still reports a sibling commit when the callers own write produced none', async () => {
    const seen = await readCommitHead();
    // Mirrors an all-duplicate knowl_ingest_atoms call: the caller committed nothing,
    // so the single new commit belongs to a sibling and must not be swallowed.
    await repo.createKnowledgeCommit(projectId, 'Sibling only', [
      { itemId: 'sib-only', action: 'insert', after: { id: 'sib-only', category: 'fact', title: 'Sibling only item' } },
    ]);

    const summary = await loadForeignChanges(seen, { ids: [], titles: ['Atom that deduped'] });
    expect(summary.count).toBe(1);
    expect(summary.items[0].itemId).toBe('sib-only');
  });
});
