import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { listAssertions, replaceCurrentAssertion } from '../../src/store/assertions.js';
import { recordKnowledgeAccess } from '../../src/store/access-feedback.js';
import { applyKnowledgeGc, previewKnowledgeGc } from '../../src/store/gc.js';
import { listTombstones } from '../../src/store/tombstones.js';
import { resetWriteOwnershipCache } from '../../src/store/write-ownership.js';

/**
 * The guards that stop collection destroying something, pinned individually.
 *
 * Found by mutation testing `src/store/gc.ts` (`scripts/mutation/probe.mjs`): every mutation
 * below left the whole 1,725-test suite green, and `purge` is the one GC action with no undo.
 * The existing GC suites prove the happy paths -- a duplicate is collected, a stale state item
 * is archived, a hot one is spared -- and each of those is asserted with values comfortably
 * inside the boundary, so the boundary itself and several of the protections were unheld.
 */

let counter = 0;
let ROOT = '';
const NOW = new Date();
const NOW_ISO = NOW.toISOString();
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

async function setUpdatedAt(itemId: string, iso: string) {
  await getClient().execute({ sql: 'UPDATE knowledge_items SET updated_at = ? WHERE id = ?', args: [iso, itemId] });
}
async function setStatus(itemId: string, status: string) {
  await getClient().execute({ sql: 'UPDATE knowledge_items SET status = ? WHERE id = ?', args: [status, itemId] });
}

describe('GC protections', () => {
  let projectId = '';
  beforeEach(async () => {
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    counter += 1;
    ROOT = path.resolve(`./.knowl-gc-protections${counter}`);
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'gc-protections')).id;
  });
  afterEach(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  /**
   * `PROTECTED_CATEGORIES` was declared and never held: emptying the set left every test green,
   * so a decision, a constraint, an architecture note and a skill were all one identical twin
   * away from being hard deleted.
   */
  it('never purges a protected category, however redundant the copy', async () => {
    const protectedIds: string[] = [];
    for (const category of ['decision', 'constraint', 'architecture', 'skill'] as const) {
      const first = await repo.createKnowledgeItem(projectId, {
        category, title: `${category} twin`, content: `Identical ${category} content.`,
      });
      const second = await repo.createKnowledgeItem(projectId, {
        category, title: `${category} twin`, content: `Identical ${category} content.`,
      });
      await setUpdatedAt(first.id, daysAgo(5));
      await setUpdatedAt(second.id, daysAgo(1));
      protectedIds.push(first.id, second.id);
    }
    // A plain fact twin, to prove collection is on at all and the protection is category-shaped.
    const factOld = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'fact twin', content: 'Identical fact content.',
    });
    await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'fact twin', content: 'Identical fact content.',
    });
    await setUpdatedAt(factOld.id, daysAgo(5));

    const preview = await previewKnowledgeGc(projectId, { now: NOW_ISO });
    const purged = preview.candidates.filter(c => c.action === 'purge').map(c => c.itemId);

    expect(purged).toContain(factOld.id);
    for (const id of protectedIds) expect(purged).not.toContain(id);

    await applyKnowledgeGc(projectId, { now: NOW_ISO });
    for (const id of protectedIds) expect(await repo.getKnowledgeItem(id)).not.toBeNull();
  });

  /**
   * `subsumes` ends with an assertion-count comparison, and dropping it -- `return true` --
   * changed no test. The assertion trail is the item's history; a purge cascades it away.
   */
  it('never purges the twin carrying more assertions', async () => {
    const asserted = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Cache layer', content: 'Reads are cached for 60 seconds.',
    });
    // A write opens an assertion already, so the trail is grown by replacing it: the closed row
    // stays, and this copy now carries two assertions to the other copy's one.
    await replaceCurrentAssertion({
      knowledgeItemId: asserted.id, content: 'Reads are cached for 60 seconds, measured.', confidence: 1,
    });
    expect(await listAssertions(asserted.id)).toHaveLength(2);
    const bare = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Cache layer', content: 'Reads are cached for 60 seconds.',
    });
    // The bare copy is newer, so recency alone would elect it and purge the asserted one.
    await setUpdatedAt(asserted.id, daysAgo(5));
    await setUpdatedAt(bare.id, daysAgo(1));

    const preview = await previewKnowledgeGc(projectId, { now: NOW_ISO });
    const purged = preview.candidates.filter(c => c.action === 'purge').map(c => c.itemId);

    expect(purged).not.toContain(asserted.id);
    await applyKnowledgeGc(projectId, { now: NOW_ISO });
    expect(await repo.getKnowledgeItem(asserted.id)).not.toBeNull();
  });

  /**
   * Only ACTIVE items form duplicate buckets. Relaxing that filter lets an archived or
   * superseded row -- deliberately retired, still queryable -- become the "survivor" that an
   * active item is purged as a duplicate of.
   */
  it('does not purge an active item as a duplicate of a retired one', async () => {
    const retired = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Queue driver', content: 'Background jobs run on Redis.',
    });
    const active = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Queue driver', content: 'Background jobs run on Redis.',
    });
    await setStatus(retired.id, 'archived');
    await setUpdatedAt(retired.id, daysAgo(1));
    await setUpdatedAt(active.id, daysAgo(5));

    const preview = await previewKnowledgeGc(projectId, { now: NOW_ISO });
    expect(preview.candidates.filter(c => c.action === 'purge')).toHaveLength(0);

    await applyKnowledgeGc(projectId, { now: NOW_ISO });
    expect(await repo.getKnowledgeItem(active.id)).not.toBeNull();
  });

  /**
   * Compression is destructive and once is enough. The `startsWith('Compressed summary:')` guard
   * is what makes it idempotent; without it every collection pass compresses the previous
   * summary again, and the item shrinks toward nothing one run at a time.
   */
  it('compresses a cold archived item once and never again', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Ingest pipeline',
      content: `The ingest pipeline reads the transcript, chunks it, embeds each chunk and writes
        the atoms in one transaction. ${'Detail. '.repeat(40)}`,
    });
    await setStatus(item.id, 'archived');
    await setUpdatedAt(item.id, daysAgo(120));

    // `minCompressBytes` is set below the length of a summary on purpose. At the default of 180
    // the size check alone already stops the second pass, so a test run at the default proves
    // the size check and says nothing about the guard -- it passes with the guard deleted.
    const options = { now: NOW_ISO, minCompressBytes: 60 };
    const first = await applyKnowledgeGc(projectId, options);
    expect(first.summary.compress).toBe(1);
    const compressed = (await repo.getKnowledgeItem(item.id))!.content;
    expect(compressed.startsWith('Compressed summary:')).toBe(true);
    expect(Buffer.byteLength(compressed, 'utf8')).toBeGreaterThan(options.minCompressBytes);

    await setUpdatedAt(item.id, daysAgo(120));
    const second = await applyKnowledgeGc(projectId, options);
    expect(second.summary.compress).toBe(0);
    expect((await repo.getKnowledgeItem(item.id))!.content).toBe(compressed);
  });

  /**
   * Hot protection, at the boundary rather than comfortably inside it.
   *
   * `gc-access.test.ts` retrieves its hot item four times against a threshold of three and
   * records the access "now" against a 21-day window, so both comparisons could be tightened by
   * one and stay green. An item retrieved exactly the threshold number of times is hot, and one
   * last retrieved exactly at the edge of the window is hot: that is what "protected from decay"
   * has to mean, or the number in the constant is not the number in effect.
   */
  it('protects an item retrieved exactly the hot-count threshold of times', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'state', title: 'Boundary count', content: 'Retrieved exactly three times.',
    });
    await setUpdatedAt(item.id, daysAgo(120));
    for (let index = 0; index < 3; index++) {
      // Older than the recency window, so only the count can protect it.
      await recordKnowledgeAccess({ itemId: item.id, surface: 'agent_query', rank: 1, retrievedAt: daysAgo(60) });
    }

    const preview = await previewKnowledgeGc(projectId, { now: NOW_ISO });
    expect(preview.candidates.filter(c => c.action === 'archive').map(c => c.itemId)).not.toContain(item.id);
  });

  it('protects an item last retrieved exactly at the edge of the hot-recency window', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'state', title: 'Boundary recency', content: 'Retrieved once, 21 days ago.',
    });
    await setUpdatedAt(item.id, daysAgo(120));
    // A single retrieval, so only recency can protect it.
    await recordKnowledgeAccess({ itemId: item.id, surface: 'agent_query', rank: 1, retrievedAt: daysAgo(21) });

    const preview = await previewKnowledgeGc(projectId, { now: NOW_ISO });
    expect(preview.candidates.filter(c => c.action === 'archive').map(c => c.itemId)).not.toContain(item.id);
  });

  /**
   * Tombstone retention has a default, and the default is not zero.
   *
   * A tombstone is how an import knows a deletion happened; pruning one that a peer has not seen
   * yet resurrects the item on the next round trip. Collapsing `?? 90` to `?? 0` pruned every
   * delete record on the very run that created it, and nothing failed.
   */
  it('keeps a fresh tombstone through a collection that was not asked to prune', async () => {
    const older = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Retry policy', content: 'Failed jobs retry three times.',
    });
    await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Retry policy', content: 'Failed jobs retry three times.',
    });
    await setUpdatedAt(older.id, daysAgo(5));

    const result = await applyKnowledgeGc(projectId, { now: NOW_ISO });
    expect(result.summary.purge).toBeGreaterThanOrEqual(1);
    expect(result.prunedTombstones).toBe(0);
    expect((await listTombstones()).map(tombstone => tombstone.id)).toContain(older.id);
  });
});
