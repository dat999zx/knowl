import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { exportKnowledge, importKnowledge } from '../../src/store/portability.js';
import { listTombstones, recordTombstone } from '../../src/store/tombstones.js';
import { resetWriteOwnershipCache } from '../../src/store/write-ownership.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

let counter = 0;
let SOURCE = '';
let TARGET = '';
let DUMP = '';

const EARLY = '2026-01-01T00:00:00.000Z';
const LATE = '2026-06-01T00:00:00.000Z';

async function makeRepo(root: string) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
}

/** See the note in export-ownership.test.ts: one open/close per step, not per operation. */
async function session<T>(root: string, run: () => Promise<T>): Promise<T> {
  await initDb(root);
  try {
    return await run();
  } finally {
    await closeDb();
  }
}

async function write(root: string, title: string, content: string): Promise<string> {
  const projectId = (await repo.createProject(root, 'p')).id;
  const result = await storeKnowledgeItemDeduped(projectId, { category: 'fact', title, content });
  return result.item.id;
}

async function titleExists(title: string): Promise<boolean> {
  const rows = await getClient().execute({
    sql: 'SELECT COUNT(*) AS n FROM knowledge_items WHERE title = ?', args: [title],
  });
  return Number(rows.rows[0].n) > 0;
}

async function backdate(id: string, updatedAt: string) {
  await getClient().execute({
    sql: 'UPDATE knowledge_items SET updated_at = ? WHERE id = ?', args: [updatedAt, id],
  });
}

describe('deletes only move forward', () => {
  beforeEach(async () => {
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    counter += 1;
    SOURCE = path.resolve(`./.knowl-tomb-src${counter}`);
    TARGET = path.resolve(`./.knowl-tomb-dst${counter}`);
    DUMP = path.resolve(`./.knowl-tomb-dump${counter}.jsonl`);
    for (const dir of [SOURCE, TARGET]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(DUMP, { force: true }).catch(() => {});
    await makeRepo(SOURCE);
    await makeRepo(TARGET);
  });

  afterEach(async () => {
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    for (const dir of [SOURCE, TARGET]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(DUMP, { force: true }).catch(() => {});
  });

  it('does not let an older tombstone rewind a newer one', async () => {
    // recordTombstone overwrote deleted_at unconditionally, so replaying an old delete moved
    // the recorded time backwards -- and that timestamp is the only thing deciding whether a
    // local edit or a remote delete wins.
    const tombstones = await session(SOURCE, async () => {
      await recordTombstone('item-1', LATE, 'gc purge');
      await recordTombstone('item-1', EARLY, 'stale replay');
      return listTombstones();
    });

    expect(tombstones).toEqual([{ id: 'item-1', deletedAt: LATE, reason: 'gc purge' }]);
  });

  it('still moves a tombstone forward', async () => {
    const tombstones = await session(SOURCE, async () => {
      await recordTombstone('item-1', EARLY, 'first');
      await recordTombstone('item-1', LATE, 'later');
      return listTombstones();
    });

    expect(tombstones).toEqual([{ id: 'item-1', deletedAt: LATE, reason: 'later' }]);
  });

  it('treats an equal timestamp as a no-op rather than an error', async () => {
    const tombstones = await session(SOURCE, async () => {
      await recordTombstone('item-1', LATE, 'first');
      await expect(recordTombstone('item-1', LATE, 'second')).resolves.toBeUndefined();
      return listTombstones();
    });

    expect(tombstones[0].reason).toBe('first');
  });

  it('leaves an unrelated tombstone untouched when one is replayed', async () => {
    const tombstones = await session(SOURCE, async () => {
      await recordTombstone('a', EARLY, 'a');
      await recordTombstone('b', LATE, 'b');
      await recordTombstone('a', EARLY, 'a again');
      return listTombstones();
    });

    expect(tombstones).toEqual([
      { id: 'a', deletedAt: EARLY, reason: 'a' },
      { id: 'b', deletedAt: LATE, reason: 'b' },
    ]);
  });

  it('does not let an import rewind a newer local tombstone', async () => {
    await session(TARGET, () => recordTombstone('shared-id', LATE, 'deleted here later'));

    await session(SOURCE, async () => {
      // An unrelated item keeps the export a valid stream with something in it.
      await write(SOURCE, 'Something else', 'Unrelated content that keeps the export valid.');
      await recordTombstone('shared-id', EARLY, 'deleted there earlier');
      await exportKnowledge('local', DUMP, SOURCE);
    });

    const tombstones = await session(TARGET, async () => {
      await importKnowledge(DUMP, { projectRoot: TARGET });
      return listTombstones();
    });

    expect(tombstones.find(entry => entry.id === 'shared-id')?.deletedAt).toBe(LATE);
  });

  it('does not resurrect an item deleted after the export was taken', async () => {
    // Import planned an insert without consulting local tombstones, so a stale export
    // reinstated knowledge that had since been deliberately removed.
    const id = await session(SOURCE, async () => {
      const written = await write(SOURCE, 'Legacy endpoint is live', 'The v1 endpoint still serves traffic.');
      // Stale by construction: the item was last touched before the delete.
      await backdate(written, EARLY);
      await exportKnowledge('local', DUMP, SOURCE);
      return written;
    });

    const { result, exists } = await session(TARGET, async () => {
      await recordTombstone(id, LATE, 'retired the endpoint');
      const imported = await importKnowledge(DUMP, { projectRoot: TARGET });
      return { result: imported, exists: await titleExists('Legacy endpoint is live') };
    });

    expect(exists).toBe(false);
    expect(result.inserted).toBe(0);
    expect(result.blockedByTombstone).toBe(1);
  });

  it('still inserts an item whose export is newer than the tombstone', async () => {
    // The mirror case: knowledge deleted and then legitimately re-recorded must land, or a
    // tombstone would block its own subject forever.
    const id = await session(SOURCE, async () => {
      const written = await write(SOURCE, 'Endpoint is back', 'The endpoint was reinstated deliberately.');
      await backdate(written, LATE);
      await exportKnowledge('local', DUMP, SOURCE);
      return written;
    });

    const { result, exists } = await session(TARGET, async () => {
      await recordTombstone(id, EARLY, 'deleted before it came back');
      const imported = await importKnowledge(DUMP, { projectRoot: TARGET });
      return { result: imported, exists: await titleExists('Endpoint is back') };
    });

    expect(result.inserted).toBe(1);
    expect(exists).toBe(true);
  });

  it('keeps an unrelated item in a partly blocked import, rather than rolling the whole file back', async () => {
    // The blocked item's assertions and evidence links carry a foreign key to knowledge_items.
    // Letting those through while skipping the item fails the constraint and rolls back every
    // other item in the same import.
    const blocked = await session(SOURCE, async () => {
      const stale = await write(SOURCE, 'Stale and deleted', 'This export predates the delete.');
      await backdate(stale, EARLY);
      await write(SOURCE, 'Fresh and unrelated', 'Nothing has ever deleted this one.');
      await exportKnowledge('local', DUMP, SOURCE);
      return stale;
    });

    const { result, staleExists, freshExists } = await session(TARGET, async () => {
      await recordTombstone(blocked, LATE, 'gone');
      const imported = await importKnowledge(DUMP, { projectRoot: TARGET });
      return {
        result: imported,
        staleExists: await titleExists('Stale and deleted'),
        freshExists: await titleExists('Fresh and unrelated'),
      };
    });

    expect(result.applied).toBe(true);
    expect(result.inserted).toBe(1);
    expect(result.blockedByTombstone).toBe(1);
    expect(staleExists).toBe(false);
    expect(freshExists).toBe(true);
  });

  it('reports the block on a dry run, rather than reading as already having it', async () => {
    const id = await session(SOURCE, async () => {
      const written = await write(SOURCE, 'Blocked by tombstone', 'This export predates the delete.');
      await backdate(written, EARLY);
      await exportKnowledge('local', DUMP, SOURCE);
      return written;
    });

    const result = await session(TARGET, async () => {
      await recordTombstone(id, LATE, 'gone');
      return importKnowledge(DUMP, { projectRoot: TARGET, dryRun: true });
    });

    expect(result.wouldApply?.inserted).toBe(0);
    expect(result.blockedByTombstone).toBe(1);
  });
});
