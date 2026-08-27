import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getClient, getDb, initDb } from '../../src/store/database.js';
import { observeRecallGap, recallGapReport } from '../../src/store/recall-gap.js';

const TEST_ROOT = path.resolve('./.knowl-recall-actor-test');

// One conversation key for every observation on purpose: it is exactly what a subagent and its
// parent share, and the point of the column is that this string cannot tell them apart.
const observe = async (agentId: string | null, paths: string[]) =>
  observeRecallGap('p', { conversation: 'claude|/repo|session-1', agentId, paths });

beforeAll(async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
  await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
  await initDb(TEST_ROOT);
});

beforeEach(async () => {
  await (getDb() as any).run(sql`DELETE FROM recall_observations`);
});

afterAll(async () => {
  await closeDb();
  // Swallowed the same way every other store test swallows it: on Windows the db file can still
  // be held when the suite ends, and the harness sweeps leftover fixtures on the next run.
  await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe('recall gap, split by actor', () => {
  it('separates a subagent from its parent even though they share one conversation key', async () => {
    // The whole reason the column exists. A Claude subagent shares its parent's external session
    // id, so `conversationKey` — host + root + session — is identical for both, and every child's
    // recall used to land on the parent's row.
    await observe(null, ['src/a.ts']);
    await observe('agent-7', ['src/b.ts']);

    const rows = await getClient().execute('SELECT agent_id FROM recall_observations ORDER BY agent_id');
    expect(rows.rows.map((row: any) => row.agent_id)).toEqual([null, 'agent-7']);
  });

  it('reports no split until both populations exist', async () => {
    // One side alone invites reading a single population as a comparison. It also protects a
    // freshly-migrated store, whose pre-column rows are all null, from reporting "100% main
    // thread" as though that had been measured.
    await observe(null, ['src/a.ts']);
    expect((await recallGapReport('p')).byActor).toBeUndefined();

    await observe('agent-7', ['src/b.ts']);
    expect((await recallGapReport('p')).byActor).toBeDefined();
  });

  it('leaves the pooled totals unchanged by the split', async () => {
    // The split is additive reporting, not a redefinition. Whatever the top-line numbers said
    // before this column, they still say.
    await observe(null, ['src/a.ts']);
    await observe('agent-7', ['src/b.ts']);
    const report = await recallGapReport('p');

    expect(report.touches).toBe(2);
    expect(report.touches).toBe(report.byActor!.main.touches + report.byActor!.subagent.touches);
    expect(report.held).toBe(report.byActor!.main.held + report.byActor!.subagent.held);
    expect(report.retrieved).toBe(report.byActor!.main.retrieved + report.byActor!.subagent.retrieved);
  });

  it('treats an absent agentId as the main thread', async () => {
    await observeRecallGap('p', { conversation: 'claude|/repo|session-1', paths: ['src/a.ts'] });
    const rows = await getClient().execute('SELECT agent_id FROM recall_observations');
    expect(rows.rows[0].agent_id).toBeNull();
  });
});
