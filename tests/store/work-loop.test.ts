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
});
