import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { recordKnowledgeAccess } from '../../src/store/access-feedback.js';
import { observeRecallGap, recallGapReport } from '../../src/store/recall-gap.js';

const TEST_ROOT = path.resolve('./.knowl-recall-gap-test');

describe('recall gap', () => {
  let projectId: string;

  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
    projectId = (await repo.createProject(TEST_ROOT, 'Recall gap test')).id;
  });

  beforeEach(async () => {
    const db = getDb() as any;
    await db.run(sql`DELETE FROM recall_observations`);
    await db.run(sql`DELETE FROM knowledge_access`);
    await db.run(sql`DELETE FROM knowledge_items`);
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('counts a touch as missed when the store held knowledge the agent never retrieved', async () => {
    await repo.createKnowledgeItem(projectId, {
      category: 'constraint',
      title: 'GC must protect memory an agent keeps re-deriving',
      content: 'Re-derivation is the one positive capture signal.',
      affectedPaths: ['src/store/gc.ts'],
    });

    const observed = await observeRecallGap(projectId, {
      conversation: 'conv-1',
      paths: ['src/store/gc.ts'],
    });

    expect(observed).toEqual({ held: 1, retrieved: 0 });

    const report = await recallGapReport(projectId);
    expect(report).toEqual(expect.objectContaining({ touches: 1, held: 1, retrieved: 0, missed: 1 }));
  });

  it('counts a touch as retrieved when the agent queried the atom inside the window', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'constraint',
      title: 'GC must protect memory an agent keeps re-deriving',
      content: 'Re-derivation is the one positive capture signal.',
      affectedPaths: ['src/store/gc.ts'],
    });
    await recordKnowledgeAccess({ itemId: item.id, query: 'gc protection', surface: 'agent_query', rank: 1 });

    const observed = await observeRecallGap(projectId, {
      conversation: 'conv-1',
      paths: ['src/store/gc.ts'],
    });

    expect(observed).toEqual({ held: 1, retrieved: 1 });

    const report = await recallGapReport(projectId);
    expect(report).toEqual(expect.objectContaining({ touches: 1, held: 1, retrieved: 1, missed: 0 }));
  });

  it('records a touch with no matching knowledge, so coverage has a denominator', async () => {
    await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Unrelated', content: 'About something else.',
      affectedPaths: ['src/store/other.ts'],
    });

    const observed = await observeRecallGap(projectId, {
      conversation: 'conv-1',
      paths: ['src/store/gc.ts'],
    });

    expect(observed).toEqual({ held: 0, retrieved: 0 });

    const report = await recallGapReport(projectId);
    expect(report).toEqual(expect.objectContaining({ touches: 1, held: 0, missed: 0 }));
  });

  it('ignores a retrieval older than the window, because a stale read is not this turn', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'constraint', title: 'Windowed', content: 'Retrieved long ago.',
      affectedPaths: ['src/store/gc.ts'],
    });
    await recordKnowledgeAccess({ itemId: item.id, query: 'old', surface: 'agent_query', rank: 1 });
    const db = getDb() as any;
    const longAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    await db.run(sql`UPDATE knowledge_access SET retrieved_at = ${longAgo}`);

    const observed = await observeRecallGap(projectId, {
      conversation: 'conv-1',
      paths: ['src/store/gc.ts'],
      windowMinutes: 60,
    });

    expect(observed).toEqual({ held: 1, retrieved: 0 });
  });
});
