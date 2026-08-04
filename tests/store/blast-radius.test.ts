import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getClient, getDb, initDb } from '../../src/store/database.js';
import { flagCorrectionSiblings, MAX_BLAST_RADIUS } from '../../src/store/blast-radius.js';
import { updateKnowledgeItemWithCommit } from '../../src/store/knowledge-actions.js';
import { storeKnowledgeAtomsDeduped, storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import * as repo from '../../src/store/repository.js';

const ROOT = path.resolve('.knowl-blast-radius-test');

const freshnessOf = async (id: string): Promise<string> => {
  const row = (await getClient().execute({
    sql: 'SELECT freshness FROM knowledge_items WHERE id = ?',
    args: [id],
  })).rows[0];
  return String(row.freshness);
};

describe('correction blast radius', () => {
  let projectId = '';

  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'Blast radius test')).id;
  });

  beforeEach(async () => {
    const db = getDb() as any;
    await db.run(sql`DELETE FROM knowledge_evidence`);
    await db.run(sql`DELETE FROM evidence`);
    await db.run(sql`DELETE FROM knowledge_commits`);
    await db.run(sql`DELETE FROM knowledge_items`);
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('flags batch siblings when one member is demoted', async () => {
    const batch = await storeKnowledgeAtomsDeduped(projectId, [
      { category: 'fact', title: 'Extracted fact alpha', content: 'From ingest batch one, page 3.' },
      { category: 'fact', title: 'Extracted fact beta', content: 'From ingest batch one, page 7.' },
      { category: 'fact', title: 'Extracted fact gamma', content: 'From ingest batch one, page 9.' },
    ]);
    const [alpha, beta, gamma] = batch.itemIds;

    await updateKnowledgeItemWithCommit(projectId, alpha, { status: 'rejected' }, { projectRoot: ROOT });

    expect(await freshnessOf(beta)).toBe('needs_review');
    expect(await freshnessOf(gamma)).toBe('needs_review');
  });

  it('does not flag the replacement that performed the correction', async () => {
    const wrong = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Cache TTL', content: 'The cache TTL is 60 seconds.',
    });
    const correction = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Cache TTL corrected', content: 'The cache TTL is 300 seconds.',
      supersedes: wrong.item.id,
    });

    const result = await flagCorrectionSiblings(projectId, wrong.item.id, 'test');
    expect(result.flaggedIds).not.toContain(correction.item.id);
    expect(await freshnessOf(correction.item.id)).toBe('fresh');
  });

  it('flags same-source and shared-evidence siblings, skipping ineligible ones', async () => {
    const corrected = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Corrected claim', content: 'Wrong reading of the spec.', source: 'spec-ingest-7',
    });
    const sourceSibling = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Source sibling', content: 'Another reading of the spec.', source: 'spec-ingest-7',
    });
    const alreadyFlagged = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Already under review', content: 'Same source, already flagged.',
      source: 'spec-ingest-7', freshness: 'needs_review',
    });
    const unrelated = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Unrelated', content: 'Different source entirely.', source: 'other-source',
    });

    const evidenceSibling = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Evidence sibling', content: 'Cites the same test run.',
    });
    const { attachEvidenceToKnowledge } = await import('../../src/store/evidence-repository.js');
    const shared = { type: 'test' as const, locator: 'test://spec-suite#run-42', observedAt: new Date().toISOString() };
    await attachEvidenceToKnowledge(corrected.id, [shared]);
    await attachEvidenceToKnowledge(evidenceSibling.id, [shared]);

    const result = await flagCorrectionSiblings(projectId, corrected.id, '"Corrected claim" (rejected)');

    expect(result.flaggedIds.sort()).toEqual([sourceSibling.id, evidenceSibling.id].sort());
    expect(await freshnessOf(sourceSibling.id)).toBe('needs_review');
    expect(await freshnessOf(evidenceSibling.id)).toBe('needs_review');
    expect(await freshnessOf(unrelated.id)).toBe('fresh');
    // Already-flagged stays flagged without being re-counted.
    expect(await freshnessOf(alreadyFlagged.id)).toBe('needs_review');
  });

  it('records the flips as one knowledge commit naming the correction', async () => {
    const batch = await storeKnowledgeAtomsDeduped(projectId, [
      { category: 'fact', title: 'Commit trail one', content: 'First of the batch.' },
      { category: 'fact', title: 'Commit trail two', content: 'Second of the batch.' },
    ]);
    await flagCorrectionSiblings(projectId, batch.itemIds[0], '"Commit trail one" (rejected)');

    const commits = (await getClient().execute(
      "SELECT message FROM knowledge_commits WHERE message LIKE 'Correction blast radius%'",
    )).rows;
    expect(commits).toHaveLength(1);
    expect(String(commits[0].message)).toContain('"Commit trail one" (rejected)');
  });

  it('flags at most MAX_BLAST_RADIUS siblings and reports the overflow', async () => {
    const corrected = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Corrected member', content: 'The wrong one.', source: 'wide-batch',
    });
    const siblings = [];
    for (let i = 0; i < MAX_BLAST_RADIUS + 5; i++) {
      siblings.push(await repo.createKnowledgeItem(projectId, {
        category: 'fact', title: `Wide batch member ${i}`, content: `Member number ${i}.`,
        source: 'wide-batch',
      }));
    }

    const result = await flagCorrectionSiblings(projectId, corrected.id, 'test');

    expect(result.flaggedIds).toHaveLength(MAX_BLAST_RADIUS);
    expect(result.capped).toBe(true);
    const flagged = new Set(result.flaggedIds);
    for (const sibling of siblings) {
      expect(await freshnessOf(sibling.id)).toBe(flagged.has(sibling.id) ? 'needs_review' : 'fresh');
    }
    // The correction's own subject is never part of its own blast radius.
    expect(flagged.has(corrected.id)).toBe(false);
  });

  it('leaves capped false when every sibling fits', async () => {
    const corrected = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Small batch member', content: 'The wrong one.', source: 'small-batch',
    });
    await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'The only sibling', content: 'The other one.', source: 'small-batch',
    });

    const result = await flagCorrectionSiblings(projectId, corrected.id, 'test');
    expect(result.flaggedIds).toHaveLength(1);
    expect(result.capped).toBe(false);
  });

  it('a routine supersede flags nothing', async () => {
    const batch = await storeKnowledgeAtomsDeduped(projectId, [
      { category: 'state', title: 'Sprint status', content: 'Sprint one is underway.' },
      { category: 'state', title: 'Deploy status', content: 'Deploy pipeline is green.' },
    ]);
    await updateKnowledgeItemWithCommit(projectId, batch.itemIds[0], { status: 'superseded' }, { projectRoot: ROOT });

    expect(await freshnessOf(batch.itemIds[1])).toBe('fresh');
  });
});

/**
 * K-48's second half, which the ledger closed as unfixable and never tested.
 *
 * The claim was: `changes LIKE '%<id>%'` has a leading wildcard, SQLite cannot index that,
 * therefore the only lever is shrinking what is scanned. The first half is true. The second
 * does not follow -- "no index serves this query as written" is not "this query cannot be
 * made fast", and which items a commit touched is known at write time rather than something
 * that has to be recovered from a JSON blob by substring match.
 *
 * Measured on a copy of a real store before writing any of this (643 commits, 3.20 MB of
 * changes JSON, one month old):
 *
 *   today, uncompacted            643 rows / 3.20 MB   6.49 ms mean
 *   after payload compaction      643 rows / 0.04 MB   0.13 ms mean
 *   compacted, grown to  20,000 rows / 0.99 MB         2.54 ms mean
 *   compacted, grown to 100,000 rows / 4.91 MB        30.55 ms mean
 *
 * That store writes 21.5 commits a day, so 20,000 rows is 2.6 years away and 100,000 is 12.8.
 * Compaction is a 50x improvement now and gives the cost back within three years, because it
 * shrinks the bytes and not the row count. The scan is O(commits) and commits are never
 * deleted -- deliberately, they are the audit trail.
 *
 * So the pairs are written down when they are already known. The JSON stays the source of
 * truth: the index only chooses which commits to parse, and every sibling still comes out of
 * `changes` exactly as before.
 */
const INDEX_ROOT = path.resolve('.knowl-blast-radius-index-test');

describe('K-48: finding the insert commit without scanning the table', () => {
  let projectId = '';

  beforeAll(async () => {
    await fs.rm(INDEX_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(INDEX_ROOT, '.knowl'), { recursive: true });
    await initDb(INDEX_ROOT);
    projectId = (await repo.createProject(INDEX_ROOT, 'Commit index test')).id;
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(INDEX_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    const db = getDb() as any;
    await db.run(sql`DELETE FROM knowledge_commits`);
    await db.run(sql`DELETE FROM knowledge_commit_items`);
    await db.run(sql`DELETE FROM knowledge_items`);
  });

  it('records which items a commit touched, at the moment it is known', async () => {
    const batch = await storeKnowledgeAtomsDeduped(projectId, [
      { category: 'fact', title: 'Indexed alpha', content: 'The first of an ingest batch.' },
      { category: 'fact', title: 'Indexed beta', content: 'The second of an ingest batch.' },
    ]);

    const rows = (await getClient().execute({
      sql: 'SELECT item_id, action FROM knowledge_commit_items WHERE item_id IN (?, ?)',
      args: batch.itemIds,
    })).rows;

    expect(rows.map(row => String(row.item_id)).sort()).toEqual([...batch.itemIds].sort());
    expect(rows.every(row => String(row.action) === 'insert')).toBe(true);
  });

  it('looks the insert commit up by index rather than scanning every commit', async () => {
    // The mechanical assertion, not a stopwatch: a plan that still says SCAN over
    // knowledge_commits is the defect, whatever the wall clock says on a small fixture.
    const batch = await storeKnowledgeAtomsDeduped(projectId, [
      { category: 'fact', title: 'Planned alpha', content: 'One of a batch.' },
      { category: 'fact', title: 'Planned beta', content: 'Another of a batch.' },
    ]);

    const plan = (await getClient().execute({
      sql: `EXPLAIN QUERY PLAN
            SELECT commits.changes FROM knowledge_commits commits
            JOIN knowledge_commit_items entry ON entry.commit_id = commits.id
            WHERE entry.item_id = ? AND entry.action = 'insert'`,
      args: [batch.itemIds[0]],
    })).rows.map(row => String(row.detail)).join(' | ');

    expect(plan).toMatch(/SEARCH .*knowledge_commit_items.* USING (COVERING )?INDEX/i);
    expect(plan).not.toMatch(/SCAN .*knowledge_commits\b/i);
  });

  it('still reads every sibling out of the commit JSON', async () => {
    // The index chooses which commits to open. It does not answer the question -- if it did,
    // it would be a second source of truth that could disagree with the audit trail.
    const batch = await storeKnowledgeAtomsDeduped(projectId, [
      { category: 'fact', title: 'Truth alpha', content: 'Born in one insert commit.' },
      { category: 'fact', title: 'Truth beta', content: 'Born in the same insert commit.' },
    ]);
    // The index says this commit is interesting; the JSON says who else was in it. Blanking
    // the JSON must therefore cost the sibling, not silently fall back to the index.
    await getClient().execute({ sql: 'UPDATE knowledge_commits SET changes = ?', args: ['[]'] });

    const result = await flagCorrectionSiblings(projectId, batch.itemIds[0], 'a correction');

    expect(result.flaggedIds).toEqual([]);
  });

  it('finds the same siblings the scan found', async () => {
    const batch = await storeKnowledgeAtomsDeduped(projectId, [
      { category: 'fact', title: 'Parity alpha', content: 'From ingest batch parity, page 1.' },
      { category: 'fact', title: 'Parity beta', content: 'From ingest batch parity, page 2.' },
      { category: 'fact', title: 'Parity gamma', content: 'From ingest batch parity, page 3.' },
    ]);

    const result = await flagCorrectionSiblings(projectId, batch.itemIds[0], 'a correction');

    expect(result.flaggedIds.sort()).toEqual(batch.itemIds.slice(1).sort());
  });

  it('falls back to the scan for a commit the index never saw', async () => {
    // Defence in depth for a database that reached this build without the backfill: a
    // missing index row must cost speed, never a sibling.
    const batch = await storeKnowledgeAtomsDeduped(projectId, [
      { category: 'fact', title: 'Unindexed alpha', content: 'From a commit written long ago.' },
      { category: 'fact', title: 'Unindexed beta', content: 'From the same old commit.' },
    ]);
    await getClient().execute('DELETE FROM knowledge_commit_items');

    const result = await flagCorrectionSiblings(projectId, batch.itemIds[0], 'a correction');

    expect(result.flaggedIds).toEqual([batch.itemIds[1]]);
  });

  it('leaves no index rows behind when its commit is gone', async () => {
    const batch = await storeKnowledgeAtomsDeduped(projectId, [
      { category: 'fact', title: 'Cascade alpha', content: 'A commit that will be deleted.' },
    ]);
    expect((await getClient().execute('SELECT COUNT(*) c FROM knowledge_commit_items')).rows[0].c).not.toBe(0);

    await getClient().execute('DELETE FROM knowledge_commits');

    // An index of rows that are not there is the shape corruption reads as.
    const left = (await getClient().execute('SELECT COUNT(*) c FROM knowledge_commit_items')).rows[0].c;
    expect(Number(left)).toBe(0);
    void batch;
  });
});
