import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getClient, getDb, initDb } from '../../src/store/database.js';
import { bootstrapSchema } from '../../src/store/bootstrap.js';
import * as repo from '../../src/store/repository.js';
import { recordKnowledgeAccess } from '../../src/store/access-feedback.js';
import { applyKnowledgeGc } from '../../src/store/gc.js';
import { listForgetLog, pruneForgetLog } from '../../src/store/forget-log.js';
import { listTombstones, pruneTombstones } from '../../src/store/tombstones.js';
import { exportKnowledge } from '../../src/store/portability.js';
import { MAX_PREVIEW_CHARS } from '../../src/core/token-budget.js';

const ROOT = path.resolve('./.knowl-forget-log-test');

/** Two items GC will call exact duplicates: same category, title and content. */
async function seedDuplicatePair(projectId: string, title: string, content: string) {
  const first = await repo.createKnowledgeItem(projectId, { category: 'fact', title, content });
  const second = await repo.createKnowledgeItem(projectId, { category: 'fact', title, content });
  return { first, second };
}

describe('forget log', () => {
  let projectId = '';

  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'forget-log')).id;
  });

  beforeEach(async () => {
    const db = getDb() as any;
    await db.run(sql`DELETE FROM knowledge_forget_log`);
    await db.run(sql`DELETE FROM knowledge_tombstones`);
    await db.run(sql`DELETE FROM knowledge_access`);
    await db.run(sql`DELETE FROM knowledge_items`);
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('records the deciding reason and the retrieval evidence a purge overruled', async () => {
    const { first, second } = await seedDuplicatePair(projectId, 'Repeated fact', 'The same claim twice.');
    // The doomed copy was being retrieved right up to the moment it was collected. Before the
    // forget log that fact was unrecoverable: the tombstone said only 'purged'.
    for (let hit = 0; hit < 2; hit++) {
      await recordKnowledgeAccess({ itemId: second.id, query: `q${hit}`, surface: 'mcp', rank: 0 });
    }

    const result = await applyKnowledgeGc(projectId);
    expect(result.summary.purge).toBeGreaterThan(0);

    const log = await listForgetLog();
    expect(log).toHaveLength(1);
    const [entry] = log;
    expect(entry.policy).toBe('gc:purge');
    expect(entry.reason).toMatch(/^Duplicate of /);
    expect(entry.reason).not.toBe('purged');
    expect(entry.title).toBe('Repeated fact');
    expect(entry.category).toBe('fact');
    expect(entry.tier).toBe('asserted');
    expect(entry.bytes).toBeGreaterThan(0);
    expect(entry.ageDays).toBe(0);

    // Whichever copy GC kept, the log describes the one it destroyed, and carries the
    // retrievals that copy had accumulated.
    expect([first.id, second.id]).toContain(entry.itemId);
    expect(entry.retrievalCount).toBe(entry.itemId === second.id ? 2 : 0);
    if (entry.itemId === second.id) expect(entry.lastRetrievedAt).toBeTruthy();
  });

  // The whole point of a separate table. Tombstones prune at 90 days on every GC run because a
  // tombstone older than an export round has no job left; a forget-log row's job is to still be
  // there months later when somebody asks whether a threshold was ever right.
  /**
   * The three fields Lethe's `forget_log.py` (MIT) carries and a first pass built from its README
   * did not: a groupable code, the survivor as a column, and a snapshot of what went. None of the
   * three is visible in that README.
   */
  it('names the rule in a code and the survivor in a column, not only in a sentence', async () => {
    const { first, second } = await seedDuplicatePair(projectId, 'Absorbed fact', 'Collapsed into its twin.');
    await applyKnowledgeGc(projectId);

    const [entry] = await listForgetLog();
    const survivor = entry.itemId === first.id ? second.id : first.id;

    // Groupable without parsing English.
    expect(entry.reasonCode).toBe('gc:duplicate');
    // Followable without parsing English.
    expect(entry.mergedIntoId).toBe(survivor);
    expect(entry.reason).toContain(survivor);
  });

  it('keeps a snapshot of what was destroyed, since the item itself is gone', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Vanished', content: 'The body nobody can read back afterwards.',
    });
    await repo.deleteKnowledgeItem(item.id);

    const [entry] = await listForgetLog();
    expect(entry.contentPreview).toBe('The body nobody can read back afterwards.');
    expect(await repo.getKnowledgeItem(item.id)).toBeNull();
  });

  it('bounds that snapshot so the audit trail cannot undo the reclamation', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Enormous', content: 'x'.repeat(5000),
    });
    await repo.deleteKnowledgeItem(item.id);

    const [entry] = await listForgetLog();
    expect(entry.contentPreview!.length).toBeLessThanOrEqual(MAX_PREVIEW_CHARS);
    // The real size is still recorded, so bounding the preview loses no information about cost.
    expect(entry.bytes).toBe(5000);
  });

  it('defaults the code rather than leaving a delete uncategorised', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Uncoded', content: 'Deleted with no context at all.',
    });
    await repo.deleteKnowledgeItem(item.id);

    expect((await listForgetLog())[0].reasonCode).toBe('delete:unspecified');
  });

  /**
   * The upgrade path, which is the whole reason this is level 7 rather than an amendment of 6.
   * A store created at level 6 already has the table, so `CREATE TABLE IF NOT EXISTS` does
   * nothing for it — without the ALTER pass the columns exist only on databases created after
   * this change, and every older store fails its next delete inside the single transaction
   * `applyKnowledgeGc` runs, taking the whole collection run with it.
   */
  it('adds its columns to a store that already had the level-6 table', async () => {
    const db = getDb() as any;
    // Reproduce a level-6 store: the table as it shipped, without the detail columns.
    await db.run(sql`DROP TABLE knowledge_forget_log`);
    await db.run(sql`CREATE TABLE knowledge_forget_log (
      id TEXT PRIMARY KEY, knowledge_item_id TEXT NOT NULL, title TEXT NOT NULL,
      category TEXT NOT NULL, tier TEXT, status TEXT, origin_repo TEXT,
      deleted_at TEXT NOT NULL, policy TEXT NOT NULL, reason TEXT NOT NULL,
      retrieval_count INTEGER NOT NULL DEFAULT 0, last_retrieved_at TEXT,
      age_days INTEGER, bytes INTEGER
    )`);
    // Rewind the gate too, or none of this runs: `bootstrapSchema` skips `SCHEMA_STATEMENTS` and
    // every ensure-pass when the stamp already reads current, which is the whole mechanism level 7
    // exists to trip. Without this the test passes a no-op and proves nothing.
    await db.run(sql`PRAGMA application_id = 6`);

    await bootstrapSchema(getClient());

    // A delete against the upgraded store succeeds and records the new detail.
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Post-upgrade', content: 'Deleted after the columns landed.',
    });
    await repo.deleteKnowledgeItem(item.id);

    const [entry] = await listForgetLog();
    expect(entry.reasonCode).toBe('delete:unspecified');
    expect(entry.contentPreview).toBe('Deleted after the columns landed.');
  });

  it('outlives the tombstone that pruning removes', async () => {
    await seedDuplicatePair(projectId, 'Prunable fact', 'Collected then forgotten about.');
    await applyKnowledgeGc(projectId);

    expect(await listTombstones()).toHaveLength(1);
    expect(await listForgetLog()).toHaveLength(1);

    // Prune everything a tombstone retention pass would reach.
    const pruned = await pruneTombstones(-1);
    expect(pruned).toBe(1);
    expect(await listTombstones()).toHaveLength(0);
    expect(await listForgetLog()).toHaveLength(1);

    // It is prunable on request, just not on the tombstone's schedule.
    expect(await pruneForgetLog(-1)).toBe(1);
    expect(await listForgetLog()).toHaveLength(0);
  });

  // The reason the numbers are not on the tombstone: tombstones ride in every export and merge
  // by upsert on import, so retrieval telemetry there would leave the machine and be
  // overwritable by a peer.
  it('never leaves the machine, unlike the tombstone', async () => {
    const { second } = await seedDuplicatePair(projectId, 'Private telemetry fact', 'Retrieved a lot, then collected.');
    for (let hit = 0; hit < 5; hit++) {
      await recordKnowledgeAccess({ itemId: second.id, query: `q${hit}`, surface: 'mcp', rank: 0 });
    }
    await applyKnowledgeGc(projectId);
    const [entry] = await listForgetLog();

    const out = path.join(os.tmpdir(), `knowl-forget-log-export-${process.pid}.jsonl`);
    try {
      await exportKnowledge(projectId, out, ROOT);
      const dumped = await fs.readFile(out, 'utf8');

      // The tombstone does travel — that is its job.
      expect(dumped).toContain('"type":"tombstone"');
      expect(dumped).toContain(entry.itemId);
      // The audit numbers do not.
      expect(dumped).not.toContain('forget_log');
      expect(dumped).not.toContain('retrieval_count');
      expect(dumped).not.toContain('retrievalCount');
      expect(dumped).not.toContain(entry.reason);
    } finally {
      await fs.rm(out, { force: true }).catch(() => {});
    }
  });

  it('logs a delete that arrived with no context rather than logging nothing', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Directly deleted', content: 'Removed without a policy.',
    });
    await repo.deleteKnowledgeItem(item.id);

    const [entry] = await listForgetLog();
    expect(entry.itemId).toBe(item.id);
    expect(entry.policy).toBe('delete');
    // States the absence instead of inventing a justification.
    expect(entry.reason).toBe('Deleted without a recorded reason');
    expect(entry.retrievalCount).toBe(0);
  });

  /**
   * Caught against a copy of a real store, not by the tests above: deleting the three
   * MOST-retrieved items produced three rows all reading `retrievals=0`, because the
   * no-context path defaulted the count instead of reading it. A log that states a false
   * number is worse than one that states none — it reads as evidence the item was dead.
   */
  it('reads the real retrieval count when the caller supplies no context', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Busy until the end', content: 'Retrieved right up to deletion.',
    });
    for (let hit = 0; hit < 4; hit++) {
      await recordKnowledgeAccess({ itemId: item.id, query: `q${hit}`, surface: 'mcp', rank: 0 });
    }
    // Feedback rows are not retrievals, the same exclusion the rest of the store applies.
    await recordKnowledgeAccess({ itemId: item.id, surface: 'feedback', rank: 0, useful: true });

    await repo.deleteKnowledgeItem(item.id);

    const [entry] = await listForgetLog();
    expect(entry.retrievalCount).toBe(4);
    expect(entry.lastRetrievedAt).toBeTruthy();
  });

  it('prefers the numbers the caller supplies, since GC already holds a whole-store summary', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Caller knows better', content: 'GC passes a whole-store summary.',
    });
    await recordKnowledgeAccess({ itemId: item.id, query: 'q', surface: 'mcp', rank: 0 });

    await repo.deleteKnowledgeItem(item.id, undefined, {
      policy: 'gc:purge', reason: 'Duplicate of somewhere-else', retrievalCount: 9,
    });

    const [entry] = await listForgetLog();
    expect(entry.retrievalCount).toBe(9);
    expect(entry.policy).toBe('gc:purge');
  });

  /**
   * Several repos share one database in workspace v2, so a log that cannot say whose item was
   * destroyed cannot answer the question it exists for. The owner is copied off the item, not
   * resolved from whoever ran the collection, and it has to be written at deletion — after it,
   * there is nothing left to attribute the row from.
   */
  it('carries the owning repo off the item, so a shared store can say whose knowledge went', async () => {
    const db = getDb() as any;
    const mine = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Owned by alpha', content: 'Alpha wrote this.',
    });
    const theirs = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Owned by beta', content: 'Beta wrote this.',
    });
    await db.run(sql`UPDATE knowledge_items SET origin_repo = 'alpha' WHERE id = ${mine.id}`);
    await db.run(sql`UPDATE knowledge_items SET origin_repo = 'beta' WHERE id = ${theirs.id}`);

    await repo.deleteKnowledgeItem(mine.id);
    await repo.deleteKnowledgeItem(theirs.id);

    const scoped = await listForgetLog({ originRepo: 'alpha' });
    expect(scoped.map(entry => entry.title)).toEqual(['Owned by alpha']);
    expect(scoped[0].originRepo).toBe('alpha');

    // Unfiltered by default: scoping silently to one repo would report "nothing was collected"
    // while a neighbour took the rest, which is the blind spot this table exists to close.
    expect(await listForgetLog()).toHaveLength(2);
  });

  it('leaves the owner null outside a workspace rather than inventing one', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Unowned', content: 'No workspace here.',
    });
    await repo.deleteKnowledgeItem(item.id);

    expect((await listForgetLog())[0].originRepo).toBeNull();
    expect(await listForgetLog({ originRepo: 'alpha' })).toHaveLength(0);
  });

  it('survives the item it describes — no cascade takes the only remaining copy', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Gone entirely', content: 'Nothing references this any more.',
    });
    await repo.deleteKnowledgeItem(item.id);

    expect(await repo.getKnowledgeItem(item.id)).toBeNull();
    expect((await listForgetLog())[0].title).toBe('Gone entirely');
  });

  it('reads newest first and honours the limit', async () => {
    for (let n = 0; n < 3; n++) {
      const item = await repo.createKnowledgeItem(projectId, {
        category: 'fact', title: `Ordered ${n}`, content: `Body ${n}.`,
      });
      await repo.deleteKnowledgeItem(item.id);
    }

    const all = await listForgetLog();
    expect(all.map(entry => entry.title)).toEqual(['Ordered 2', 'Ordered 1', 'Ordered 0']);
    expect(await listForgetLog({ limit: 1 })).toHaveLength(1);
    expect((await listForgetLog({ limit: 1 }))[0].title).toBe('Ordered 2');
  });
});
