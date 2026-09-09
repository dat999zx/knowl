import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { applyKnowledgeGc, previewKnowledgeGc } from '../../src/store/gc.js';
import { resetWriteOwnershipCache } from '../../src/store/write-ownership.js';

/**
 * Collection acts on the set the preview named.
 *
 * `applyKnowledgeGc` recomputed its candidates from scratch and the MCP tool took no arguments,
 * so a preview reporting `purge: 0`, a write landing, and an apply were enough to hard-delete
 * an item nobody had ever seen listed. Purge is the one action with no undo.
 */
let counter = 0;
let ROOT = '';
const NOW = new Date().toISOString();
const OLDER = new Date(Date.now() - 5 * 86_400_000).toISOString();
const NEWER = new Date(Date.now() - 1 * 86_400_000).toISOString();
const ANCIENT = new Date(Date.now() - 400 * 86_400_000).toISOString();

async function setUpdatedAt(itemId: string, iso: string) {
  await getClient().execute({ sql: 'UPDATE knowledge_items SET updated_at = ? WHERE id = ?', args: [iso, itemId] });
}

const TWIN = { category: 'fact' as const, title: 'Rate limit', content: 'The API allows 100 requests per minute.' };

describe('GC purges only what a preview named', () => {
  let projectId = '';
  beforeEach(async () => {
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    counter += 1;
    ROOT = path.resolve(`./.knowl-gc-approved${counter}`);
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'gc-approved')).id;
  });
  afterEach(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('destroys nothing an empty preview could not have named', async () => {
    const first = await repo.createKnowledgeItem(projectId, TWIN);
    const preview = await previewKnowledgeGc(projectId, { now: NOW });
    expect(preview.summary.purge).toBe(0);

    // The write that lands between the preview and the apply. It is the whole defect: the
    // preview named nothing, and an argument-less apply used to delete one of these two.
    const second = await repo.createKnowledgeItem(projectId, TWIN);
    await setUpdatedAt(first.id, OLDER);
    await setUpdatedAt(second.id, NEWER);

    const result = await applyKnowledgeGc(projectId, { now: NOW });
    expect(result.summary.purge).toBe(0);
    expect(await repo.getKnowledgeItem(first.id)).not.toBeNull();
    expect(await repo.getKnowledgeItem(second.id)).not.toBeNull();
    // Declined, not hidden: the caller has to be able to see what it did not do.
    expect(result.unapprovedPurges).toHaveLength(1);
    expect([first.id, second.id]).toContain(result.unapprovedPurges![0].itemId);
  });

  it('purges exactly the id a preview named and a caller approved', async () => {
    const older = await repo.createKnowledgeItem(projectId, TWIN);
    const newer = await repo.createKnowledgeItem(projectId, TWIN);
    await setUpdatedAt(older.id, OLDER);
    await setUpdatedAt(newer.id, NEWER);

    const preview = await previewKnowledgeGc(projectId, { now: NOW });
    const named = preview.candidates.filter(entry => entry.action === 'purge').map(entry => entry.itemId);
    expect(named).toHaveLength(1);
    const survivor = named[0] === newer.id ? older.id : newer.id;

    const result = await applyKnowledgeGc(projectId, { now: NOW, approvedPurgeIds: named });
    expect(result.summary.purge).toBe(1);
    expect(result.unapprovedPurges).toBeUndefined();
    expect(await repo.getKnowledgeItem(named[0])).toBeNull();
    expect(await repo.getKnowledgeItem(survivor)).not.toBeNull();
  });

  it('does not delete an approved id that is no longer a candidate', async () => {
    const survivor = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Unique claim', content: 'Nothing else says this.',
    });

    // An id carried over from an older preview, when this item had a twin that has since gone.
    const result = await applyKnowledgeGc(projectId, { now: NOW, approvedPurgeIds: [survivor.id] });
    expect(result.summary.purge).toBe(0);
    expect(await repo.getKnowledgeItem(survivor.id)).not.toBeNull();
  });

  it('still archives without any approval, because archiving is recoverable', async () => {
    const stale = await repo.createKnowledgeItem(projectId, {
      category: 'state', title: 'Working on the parser', content: 'Mid-refactor.',
    });
    await setUpdatedAt(stale.id, ANCIENT);

    const result = await applyKnowledgeGc(projectId, { now: NOW });
    expect(result.summary.archive).toBe(1);
    expect((await repo.getKnowledgeItem(stale.id))!.status).toBe('archived');
  });
});
