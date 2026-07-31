import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getClient, getDb, initDb } from '../../src/store/database.js';
import { flagCorrectionSiblings } from '../../src/store/blast-radius.js';
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

  it('a routine supersede flags nothing', async () => {
    const batch = await storeKnowledgeAtomsDeduped(projectId, [
      { category: 'state', title: 'Sprint status', content: 'Sprint one is underway.' },
      { category: 'state', title: 'Deploy status', content: 'Deploy pipeline is green.' },
    ]);
    await updateKnowledgeItemWithCommit(projectId, batch.itemIds[0], { status: 'superseded' }, { projectRoot: ROOT });

    expect(await freshnessOf(batch.itemIds[1])).toBe('fresh');
  });
});
