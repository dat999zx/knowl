import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { appendMemorySessionEvent, finishMemorySession, startMemorySession } from '../../src/store/session-repository.js';
import { finalizeMemorySession } from '../../src/store/session-finalizer.js';

const ROOT = path.resolve('./.knowl-session-finalizer-test');
describe('session finalizer', () => {
  let projectId: string;
  beforeAll(async () => { await fs.rm(ROOT, { recursive: true, force: true }); await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true }); await initDb(ROOT); projectId = (await repo.createProject(ROOT, 'Finalizer test')).id; });
  beforeEach(async () => { const db = getDb() as any; await db.run(sql`DELETE FROM knowledge_evidence`); await db.run(sql`DELETE FROM evidence`); await db.run(sql`DELETE FROM knowledge_commits`); await db.run(sql`DELETE FROM knowledge_items`); await db.run(sql`DELETE FROM memory_session_events`); await db.run(sql`DELETE FROM memory_sessions`); });
  afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('uses deterministic candidates and promotion for terminal sessions', async () => {
    const session = await startMemorySession({ title: 'Finalize retrieval' });
    await appendMemorySessionEvent(session.id, 'decision', { text: 'Use local SQLite evidence.' });
    await finishMemorySession(session.id, 'finished', 'Finalized retrieval work.');
    const result = await finalizeMemorySession(projectId, session.id);
    expect(result).toMatchObject({ status: 'promoted', candidateCount: 2, itemIds: expect.any(Array), usedAi: false });
    expect(result.itemIds).toHaveLength(2);
  });
});
