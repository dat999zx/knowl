import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Same reason as tests/store/portability.test.ts: the indexer is imported as a named binding,
// which a namespace spy cannot intercept, and the real function is already a no-op with no
// embedding model on disk.
vi.mock('../../src/store/write-embedding.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/store/write-embedding.js')>();
  return { ...actual, indexKnowledgeItemsBestEffort: vi.fn(async () => {}) };
});

import { closeDb, initDb } from '../../src/store/database.js';
import { createKnowledgeItem, listKnowledgeItems, updateKnowledgeItem } from '../../src/store/repository.js';
import * as portability from '../../src/store/portability.js';

/**
 * An import cannot land a second active exclusive value.
 *
 * `conflictExclusive` means exactly one active item may claim a key within a scope. A direct
 * second write is refused with `KNOWLEDGE_CONFLICT`; import wrote raw SQL, called no guard,
 * and reported `conflicts: 0` while landing the second row.
 */
const SOURCE = path.resolve('./.knowl-import-exclusive-source');
const TARGET = path.resolve('./.knowl-import-exclusive-target');
const KEY = 'database.production.engine';
const SCOPE = { environment: 'production' };

async function useStore(root: string) {
  await closeDb();
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await initDb(root);
}

describe('import and the exclusive-conflict guard', () => {
  let exportPath = '';
  let incomingId = '';

  beforeAll(async () => {
    await fs.rm(SOURCE, { recursive: true, force: true });
    await fs.rm(TARGET, { recursive: true, force: true });
    await fs.mkdir(path.join(SOURCE, '.knowl'), { recursive: true });
    await initDb(SOURCE);
    const item = await createKnowledgeItem('local', {
      category: 'decision',
      title: 'Postgres in production',
      content: 'Production runs Postgres 16.',
      conflictKey: KEY,
      conflictScope: SCOPE,
      conflictExclusive: true,
    });
    incomingId = item.id;
    exportPath = path.join(SOURCE, 'peer.jsonl');
    await portability.exportKnowledge('local', exportPath, SOURCE, [item.id]);
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(SOURCE, { recursive: true, force: true }).catch(() => {});
    await fs.rm(TARGET, { recursive: true, force: true }).catch(() => {});
  });

  it('refuses an export whose item claims an identity a local active item already holds', async () => {
    await useStore(path.join(TARGET, 'held'));
    const local = await createKnowledgeItem('local', {
      category: 'decision',
      title: 'MySQL in production',
      content: 'Production runs MySQL 8.',
      conflictKey: KEY,
      conflictScope: SCOPE,
      conflictExclusive: true,
    });

    const result = await (portability as any).importKnowledge(exportPath);
    expect(result).toMatchObject({ applied: false, conflicts: 1, inserted: 0 });
    expect(result.exclusiveConflicts).toEqual([
      { id: incomingId, title: 'Postgres in production', heldBy: local.id },
    ]);
    // Nothing landed, so the invariant still holds.
    expect((await listKnowledgeItems()).map(entry => entry.id)).toEqual([local.id]);
  });

  it('reports the collision on a dry run, before anyone applies it', async () => {
    await useStore(path.join(TARGET, 'dry'));
    const local = await createKnowledgeItem('local', {
      category: 'decision',
      title: 'MySQL in production',
      content: 'Production runs MySQL 8.',
      conflictKey: KEY,
      conflictScope: SCOPE,
      conflictExclusive: true,
    });

    const result = await (portability as any).importKnowledge(exportPath, { dryRun: true });
    expect(result.conflicts).toBe(1);
    expect(result.exclusiveConflicts).toEqual([
      { id: incomingId, title: 'Postgres in production', heldBy: local.id },
    ]);
  });

  it('still imports when the local holder is not active', async () => {
    await useStore(path.join(TARGET, 'retired'));
    const local = await createKnowledgeItem('local', {
      category: 'decision',
      title: 'MySQL in production',
      content: 'Production runs MySQL 8.',
      conflictKey: KEY,
      conflictScope: SCOPE,
      conflictExclusive: true,
    });
    await updateKnowledgeItem(local.id, { status: 'superseded' });

    const result = await (portability as any).importKnowledge(exportPath);
    expect(result).toMatchObject({ applied: true, conflicts: 0, inserted: 1 });
    expect((await listKnowledgeItems()).map(entry => entry.id)).toContain(incomingId);
  });

  it('does not treat an item colliding with its own local copy as a conflict', async () => {
    await useStore(path.join(TARGET, 'same-id'));
    await (portability as any).importKnowledge(exportPath);
    // Second round: the identity is now held by the very row the file describes.
    const result = await (portability as any).importKnowledge(exportPath);
    expect(result).toMatchObject({ applied: true, conflicts: 0, identical: 1 });
    expect(result.exclusiveConflicts).toBeUndefined();
  });

  it('leaves a non-exclusive key alone', async () => {
    await useStore(path.join(TARGET, 'shared-key'));
    const local = await createKnowledgeItem('local', {
      category: 'decision',
      title: 'MySQL in production',
      content: 'Production runs MySQL 8.',
      conflictKey: KEY,
      conflictScope: SCOPE,
      conflictExclusive: false,
    });

    const result = await (portability as any).importKnowledge(exportPath);
    expect(result).toMatchObject({ applied: true, conflicts: 0, inserted: 1 });
    expect((await listKnowledgeItems()).map(entry => entry.id).sort())
      .toEqual([local.id, incomingId].sort());
  });
});
