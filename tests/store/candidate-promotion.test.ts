import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { startMemorySession } from '../../src/store/session-repository.js';
import { promoteSessionCandidates } from '../../src/store/candidate-promotion.js';

const ROOT = path.resolve('./.knowl-candidate-promotion-test');
describe('candidate promotion', () => {
  let projectId: string;
  beforeAll(async () => { await fs.rm(ROOT, { recursive: true, force: true }); await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true }); await initDb(ROOT); projectId = (await repo.createProject(ROOT, 'Promotion test')).id; });
  beforeEach(async () => { const db = getDb() as any; await db.run(sql`DELETE FROM knowledge_evidence`); await db.run(sql`DELETE FROM evidence`); await db.run(sql`DELETE FROM knowledge_commits`); await db.run(sql`DELETE FROM knowledge_items`); await db.run(sql`DELETE FROM memory_session_events`); await db.run(sql`DELETE FROM memory_sessions`); });
  afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('promotes candidates once with evidence and an idempotent session result', async () => {
    const session = await startMemorySession({ title: 'Promote decision' });
    const candidates = [{ candidateType: 'decision' as const, sessionId: session.id, category: 'decision' as const, title: 'Use local SQLite', content: 'Use SQLite for local persistence.', confidence: 0.9, evidence: [{ type: 'agent' as const, locator: `session://${session.id}`, observedAt: new Date().toISOString(), relationship: 'derived_from' as const }] }];
    const first = await promoteSessionCandidates(projectId, session.id, candidates);
    const second = await promoteSessionCandidates(projectId, session.id, candidates);
    expect(first.itemIds).toHaveLength(1);
    expect(second.itemIds).toEqual(first.itemIds);
    const db = getDb() as any;
    expect(await db.all(`SELECT * FROM knowledge_evidence`)).toHaveLength(1);
    expect(await db.all(`SELECT * FROM knowledge_commits`)).toHaveLength(1);
    expect((await db.all(`SELECT promotion_status FROM memory_sessions WHERE id = '${session.id}'`))[0].promotion_status).toBe('promoted');
  });
});
