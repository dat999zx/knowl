import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

vi.mock('../../src/ai/provider.js', () => ({
  initAI: vi.fn(),
  filterInput: vi.fn(),
  extractKnowledge: vi.fn(),
  compareKnowledge: vi.fn(),
  askQuestion: vi.fn(),
  deriveTruth: vi.fn(),
}));

import { closeDb, getDb, initDb, withClientTransaction } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { createCurrentAssertion, replaceCurrentAssertion } from '../../src/store/assertions.js';
import { checkKnowledgeDrift } from '../../src/store/drift.js';
import { runMerge } from '../../src/pipeline/merge.js';
import { runDeriveTruth } from '../../src/pipeline/derive.js';
import { deriveTruth } from '../../src/ai/provider.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

const ROOT = path.resolve('./.knowl-drizzle-txn-test');

/**
 * Every `db.transaction()` this process opens, counted.
 *
 * The failure mode being pinned is not "a transaction went wrong" -- each of these works
 * correctly in isolation. `drizzle-orm@0.45.2`'s libSQL wrapper leaks native state per
 * transaction and the process segfaults at exit once between 800 and 1000 have accumulated,
 * regardless of how many statements each held (measured, `database.ts`). In a one-shot CLI
 * command that ceiling is unreachable; the MCP server is long-lived and every tool call goes
 * through these paths, so it is not. Counting the calls is therefore the durable assertion --
 * a test that tried to reach the threshold would take minutes and crash the runner.
 */
function transactionCounter() {
  return vi.spyOn(getDb(), 'transaction');
}

describe('write paths do not open Drizzle transactions', () => {
  let projectId = '';

  beforeAll(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await saveConfig(ROOT, {
      ...DEFAULT_CONFIG,
      search: { vector: { ...DEFAULT_CONFIG.search?.vector, enabled: false } },
    });
    await initDb(ROOT);
  });

  afterAll(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    const db = getDb();
    await db.run(sql`DELETE FROM knowledge_assertions`);
    await db.run(sql`DELETE FROM knowledge_commits`);
    await db.run(sql`DELETE FROM knowledge_items`);
    projectId = (await repo.createProject(ROOT, 'drizzle txn')).id;
  });

  it('replaceCurrentAssertion', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Retention window', content: 'Sessions are kept for thirty days.',
    });
    await getDb().run(sql`DELETE FROM knowledge_assertions WHERE knowledge_item_id = ${item.id}`);
    await createCurrentAssertion({ knowledgeItemId: item.id, content: 'Thirty days.', confidence: 0.9 });

    const transactions = transactionCounter();
    const replaced = await replaceCurrentAssertion({
      knowledgeItemId: item.id, content: 'Ninety days.', confidence: 0.9,
    });

    expect(transactions).not.toHaveBeenCalled();
    // Still one open assertion and one closed one: the swap is still atomic.
    expect(replaced.validTo).toBeNull();
    const rows = await getDb().all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM knowledge_assertions WHERE knowledge_item_id = ${item.id} AND valid_to IS NULL`,
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  it('checkKnowledgeDrift --apply', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Token refresh', content: 'Refresh happens in the auth middleware.',
      affectedPaths: ['src/auth/token.ts'],
    });

    const transactions = transactionCounter();
    const result = await checkKnowledgeDrift(projectId, {
      sinceCommit: 'abc123', changedFiles: ['src/auth/token.ts'], apply: true,
    });

    expect(transactions).not.toHaveBeenCalled();
    expect(result.updatedCount).toBe(1);
    expect((await repo.getKnowledgeItem(item.id))!.freshness).toBe('needs_review');
  });

  it('runMerge', async () => {
    const transactions = transactionCounter();
    const result = await runMerge(projectId, [
      { atom: { category: 'fact', title: 'Queue backend', content: 'Redis streams carry the job queue.' }, action: 'insert' },
      { atom: { category: 'decision', title: 'Retry policy', content: 'Three attempts, then the dead-letter table.' }, action: 'insert' },
    ]);

    expect(transactions).not.toHaveBeenCalled();
    expect(result.insertedIds).toHaveLength(2);
    expect(result.commitId).toBeTruthy();
  });

  it('runDeriveTruth', async () => {
    vi.mocked(deriveTruth).mockResolvedValue([{ key: 'database', value: 'SQLite' }]);
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'decision', title: 'Local persistence', content: 'SQLite for local persistence.',
    });

    const transactions = transactionCounter();
    const result = await runDeriveTruth(projectId, [await repo.getKnowledgeItem(item.id) as never]);

    expect(transactions).not.toHaveBeenCalled();
    expect(result.stateChangesCount).toBe(1);
  });

  it('runDeriveTruth takes a handed-down connection instead of opening its own transaction', async () => {
    // The one caller shape the queue cannot serve: `withClientTransaction` refuses to nest,
    // because under a promise-chain queue an inner call would wait on the outer transaction
    // that is waiting on it. A connection handed in means an outer transaction is already
    // open, and the body must simply run on it.
    vi.mocked(deriveTruth).mockResolvedValue([{ key: 'cache', value: 'in-process LRU' }]);
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'decision', title: 'Cache placement', content: 'An in-process LRU, not a shared cache.',
    });
    const stored = await repo.getKnowledgeItem(item.id) as never;

    const result = await withClientTransaction(conn => runDeriveTruth(projectId, [stored], conn));

    expect(result.stateChangesCount).toBe(1);
    const state = await getDb().all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM knowledge_items WHERE category = 'state' AND title = 'cache'`,
    );
    expect(Number(state[0].n)).toBe(1);
  });
});
