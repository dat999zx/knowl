import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { queryKnowledgeForAgent } from '../../src/store/agent-query.js';
import {
  getKnowledgeAccessReport,
  listKnowledgeAccess,
  recordKnowledgeAccess,
  recordKnowledgeFeedback,
} from '../../src/store/access-feedback.js';

const TEST_ROOT = path.resolve('./.knowl-access-feedback-test');

describe('access feedback', () => {
  let projectId: string;

  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
    projectId = (await repo.createProject(TEST_ROOT, 'Access feedback test')).id;
  });

  beforeEach(async () => {
    const db = getDb() as any;
    await db.run(sql`DELETE FROM knowledge_access`);
    await db.run(sql`DELETE FROM knowledge_items`);
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('records hashed query access and append-only feedback', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Access target', content: 'Access events are private.',
    });
    const query = 'private retrieval query';
    await recordKnowledgeAccess({ itemId: item.id, query, surface: 'mcp', rank: 1 });
    await recordKnowledgeFeedback({ itemId: item.id, used: true, useful: true, causedCorrection: false });

    const rows = await listKnowledgeAccess(item.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(expect.objectContaining({
      itemId: item.id,
      queryFingerprint: crypto.createHash('sha256').update(query).digest('hex'),
      surface: 'mcp', rank: 1,
    }));
    expect(JSON.stringify(rows)).not.toContain(query);
    expect(rows[1]).toEqual(expect.objectContaining({ useful: true, used: true, causedCorrection: false }));
  });

  it('keeps append order when two events share a timestamp', async () => {
    // The real tie, forced. `retrieved_at` is millisecond ISO text, so an access and the
    // feedback that follows it routinely land in the same millisecond on a fast machine --
    // and the tiebreak used to be the random hex `id`, making the order a coin flip. It
    // passed locally for months and failed in CI on the release tag.
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Tied events', content: 'Both written in one millisecond.',
    });
    await recordKnowledgeAccess({ itemId: item.id, query: 'tied', surface: 'mcp', rank: 1 });
    await recordKnowledgeFeedback({ itemId: item.id, used: true, useful: true, causedCorrection: false });

    const db = getDb() as any;
    await db.run(sql`UPDATE knowledge_access SET retrieved_at = '2026-08-02T00:00:00.000Z'
                     WHERE knowledge_item_id = ${item.id}`);

    const rows = await listKnowledgeAccess(item.id);
    expect(rows).toHaveLength(2);
    expect(rows[0].surface).toBe('mcp');
    expect(rows[1].surface).toBe('feedback');
  });

  it('reports high-value, stale-frequent, and corrected knowledge', async () => {
    const valuable = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Valuable', content: 'Frequently useful.',
    });
    const stale = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Stale', content: 'Needs review.', freshness: 'stale',
    });
    for (let rank = 1; rank <= 3; rank++) {
      await recordKnowledgeAccess({ itemId: valuable.id, query: 'value', surface: 'mcp', rank });
      await recordKnowledgeFeedback({ itemId: valuable.id, useful: true });
      await recordKnowledgeAccess({ itemId: stale.id, query: 'stale', surface: 'mcp', rank });
    }
    await recordKnowledgeFeedback({ itemId: stale.id, causedCorrection: true });
    await recordKnowledgeFeedback({ itemId: stale.id, causedCorrection: true });

    const report = await getKnowledgeAccessReport();
    expect(report.highValue.map(item => item.itemId)).toContain(valuable.id);
    expect(report.staleFrequentlyRetrieved.map(item => item.itemId)).toContain(stale.id);
    expect(report.repeatedlyCorrected).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: stale.id, causedCorrectionCount: 2 }),
    ]));
  });

  it('records only returned agent-query results without blocking retrieval', async () => {
    const first = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'First retrieval', content: 'Shared retrieval keyword.',
    });
    await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Second retrieval', content: 'Shared retrieval keyword.',
    });

    const items = await queryKnowledgeForAgent(projectId, { query: 'shared retrieval', limit: 1 });
    expect(items).toHaveLength(1);
    const firstAccess = await listKnowledgeAccess(first.id);
    const returnedAccess = await listKnowledgeAccess(items[0].id);
    expect(returnedAccess).toEqual([expect.objectContaining({ surface: 'agent_query', rank: 1 })]);
    expect(firstAccess.length).toBeLessThanOrEqual(1);
  });
});
