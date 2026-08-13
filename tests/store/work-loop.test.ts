import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getClient, getDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { checkpointWorkLoop, finishWorkLoop, startWorkLoop } from '../../src/store/work-loop.js';

const TEST_ROOT = path.resolve('./.knowl-work-loop-session-test');

describe('work loop session capture', () => {
  beforeAll(async () => { await fs.rm(TEST_ROOT, { recursive: true, force: true }); await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true }); await initDb(TEST_ROOT); });
  afterAll(async () => { await closeDb(); await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('starts and finishes the linked memory session', async () => {
    const project = await repo.createProject(TEST_ROOT, 'Work loop test');
    const started = await startWorkLoop(project.id, 'Capture lifecycle', 'sessions');
    const db = getDb() as any;
    const active = await db.all(`SELECT * FROM memory_sessions WHERE status = 'active'`);
    expect(active).toHaveLength(1);
    await finishWorkLoop(project.id, started.taskId, 'Complete lifecycle capture');
    const finished = await db.all(`SELECT * FROM memory_sessions WHERE status = 'finished'`);
    const events = await db.all(`SELECT type FROM memory_session_events`);
    expect(finished).toHaveLength(1);
    expect(events.map((row: any) => row.type)).toEqual(expect.arrayContaining(['start', 'stop']));
  });

  it('stores structured checkpoint task state on the linked memory session', async () => {
    const project = await repo.createProject(TEST_ROOT, 'Work loop structured checkpoint');
    const started = await startWorkLoop(project.id, 'Ship resumable handoffs', 'handoffs');
    const checkpoint = await checkpointWorkLoop(project.id, started.taskId, {
      summary: 'Captured structured progress',
      goal: 'Ship resumable handoffs',
      completed: ['Extended work-loop checkpoints'],
      nextAction: 'Verify MCP tool payload',
      blocker: 'None',
      artifactRefs: ['src/store/work-loop.ts', 'tests/store/work-loop.test.ts'],
      verificationStatus: 'tests-passing',
    });

    expect(checkpoint.taskState).toEqual({
      goal: 'Ship resumable handoffs',
      completed: ['Extended work-loop checkpoints'],
      nextAction: 'Verify MCP tool payload',
      blocker: 'None',
      artifactRefs: ['src/store/work-loop.ts', 'tests/store/work-loop.test.ts'],
      verificationStatus: 'tests-passing',
    });

    const rows = await getClient().execute({
      sql: 'SELECT payload FROM memory_session_events WHERE session_id = ? AND type = ?',
      args: [started.memorySessionId!, 'checkpoint'],
    });
    expect(JSON.parse(String(rows.rows[0].payload))).toEqual({
      summary: 'Captured structured progress',
      goal: 'Ship resumable handoffs',
      completed: ['Extended work-loop checkpoints'],
      nextAction: 'Verify MCP tool payload',
      blocker: 'None',
      artifactRefs: ['src/store/work-loop.ts', 'tests/store/work-loop.test.ts'],
      verificationStatus: 'tests-passing',
    });
  });

  it('finishes exactly once: a second finish and a post-finish checkpoint are refused', async () => {
    const project = await repo.createProject(TEST_ROOT, 'Work loop finish-once');
    const started = await startWorkLoop(project.id, 'Finish once', 'finish-once');
    await finishWorkLoop(project.id, started.taskId, 'done');

    // The description says "exactly once"; the layer used to mint a second completion item
    // against a terminal memory session, so two different finishes existed for one task.
    await expect(finishWorkLoop(project.id, started.taskId, 'done again'))
      .rejects.toThrow(/already finished/i);
    await expect(checkpointWorkLoop(project.id, started.taskId, 'zombie checkpoint'))
      .rejects.toThrow(/already finished/i);
  });

  /**
   * A finished task should leave one atom, not a pile.
   *
   * Measured on this repository's own store before these were written: 54 active work-loop atoms
   * across 18 tasks, every one of them titled `Work Loop checkpoint` or `Work Loop finish`
   * regardless of which task it belonged to. `recent-context.ts` already filters them out by title
   * prefix, which is the codebase conceding they are noise rather than knowledge.
   */
  describe('step atoms collapse per task', () => {
    /** Every work-loop atom for one task, newest first. */
    const stepsFor = async (taskId: string) => (await getClient().execute({
      sql: `SELECT id, title, status, superseded_by_id FROM knowledge_items
            WHERE tags LIKE ? ORDER BY created_at DESC`,
      args: [`%task:${taskId}%`],
    })).rows;

    it('names the task in the title, so two tasks are told apart', async () => {
      const project = await repo.createProject(TEST_ROOT, 'Work loop titles');
      const started = await startWorkLoop(project.id, 'Ship the parser', 'parser');
      await checkpointWorkLoop(project.id, started.taskId, 'half done');

      const titles = (await stepsFor(started.taskId)).map(row => String(row.title));
      expect(titles.some(title => title.includes('Ship the parser'))).toBe(true);
    });

    it('supersedes the previous checkpoint rather than accumulating', async () => {
      const project = await repo.createProject(TEST_ROOT, 'Work loop collapse');
      const started = await startWorkLoop(project.id, 'Ship the indexer', 'indexer');
      const first = await checkpointWorkLoop(project.id, started.taskId, 'step one');
      const second = await checkpointWorkLoop(project.id, started.taskId, 'step two');

      const rows = await stepsFor(started.taskId);
      const firstRow = rows.find(row => row.id === first.itemId);
      const secondRow = rows.find(row => row.id === second.itemId);

      // Retired, not deleted: "what did this task do" stays answerable.
      expect(String(firstRow?.status)).toBe('superseded');
      expect(String(firstRow?.superseded_by_id)).toBe(second.itemId);
      expect(String(secondRow?.status)).toBe('active');
    });

    it('leaves exactly one active atom once the task finishes', async () => {
      const project = await repo.createProject(TEST_ROOT, 'Work loop finish collapse');
      const started = await startWorkLoop(project.id, 'Ship the ranker', 'ranker');
      await checkpointWorkLoop(project.id, started.taskId, 'step one');
      await checkpointWorkLoop(project.id, started.taskId, 'step two');
      const finished = await finishWorkLoop(project.id, started.taskId, 'shipped');

      const active = (await stepsFor(started.taskId)).filter(row => String(row.status) === 'active');
      expect(active).toHaveLength(1);
      expect(String(active[0].id)).toBe(finished.itemId);
    });

    it('records the retirement in the same commit as the insert that caused it', async () => {
      // The audit log is the only place a supersession is visible after the fact. Retiring after
      // the commit was written left these absent from it entirely -- the store would show a new
      // checkpoint appearing and the previous one silently not-active, with nothing joining them.
      const project = await repo.createProject(TEST_ROOT, 'Work loop audit trail');
      const started = await startWorkLoop(project.id, 'Ship the audit trail', 'audit');
      const first = await checkpointWorkLoop(project.id, started.taskId, 'step one');
      const second = await checkpointWorkLoop(project.id, started.taskId, 'step two');

      const rows = (await getClient().execute({
        sql: `SELECT ci.item_id, ci.action FROM knowledge_commit_items ci
              WHERE ci.item_id IN (?, ?)`,
        args: [first.itemId, second.itemId],
      })).rows;

      const actionsFor = (id: string) => rows
        .filter(row => String(row.item_id) === id)
        .map(row => String(row.action));
      expect(actionsFor(second.itemId)).toContain('insert');
      expect(actionsFor(first.itemId)).toContain('supersede');
    });

    it('never touches another task running at the same time', async () => {
      // The reason superseding keys on the `task:<id>` tag and not on the title. Users run work
      // loops in parallel; keying on the title would make one loop retire another's checkpoints.
      const project = await repo.createProject(TEST_ROOT, 'Work loop parallel');
      const a = await startWorkLoop(project.id, 'Task A', 'a');
      const b = await startWorkLoop(project.id, 'Task B', 'b');

      const a1 = await checkpointWorkLoop(project.id, a.taskId, 'a one');
      const b1 = await checkpointWorkLoop(project.id, b.taskId, 'b one');
      await checkpointWorkLoop(project.id, a.taskId, 'a two');

      // A's second checkpoint retired A's first and left B's alone.
      const aRows = await stepsFor(a.taskId);
      const bRows = await stepsFor(b.taskId);
      expect(String(aRows.find(row => row.id === a1.itemId)?.status)).toBe('superseded');
      expect(String(bRows.find(row => row.id === b1.itemId)?.status)).toBe('active');
    });
  });
});
