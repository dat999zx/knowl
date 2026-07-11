import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { finishWorkLoop, startWorkLoop } from '../../src/store/work-loop.js';

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
});
