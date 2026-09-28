import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { startMemorySession } from '../../src/store/session-repository.js';
import { promoteSessionCandidates, rankCandidatesByImportance } from '../../src/store/candidate-promotion.js';
import { MemoryCandidate } from '../../src/core/types.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';

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

  it('ranks a resolved failure above a commit, and both above an outcome', () => {
    const make = (candidateType: MemoryCandidate['candidateType']): MemoryCandidate => ({
      candidateType,
      sessionId: 's1',
      category: 'fact',
      title: 't',
      content: 'c',
      confidence: 0.8,
      evidence: [],
    });

    const ranked = rankCandidatesByImportance([make('outcome'), make('commit'), make('error')]);

    expect(ranked.map((candidate) => candidate.candidateType)).toEqual(['error', 'commit', 'outcome']);
  });

  it('a captured candidate is kept beside a verified fact instead of retiring it (#165)', async () => {
    const seed = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Database backup retention',
      content: 'Nightly database backups are retained for 35 days and encrypted at rest.',
      provenance: 'observed', confidence: 0.95,
    });
    const session = await startMemorySession({ title: 'Poisoned session' });
    const promoted = await promoteSessionCandidates(projectId, session.id, [{
      candidateType: 'decision', sessionId: session.id, category: 'fact',
      title: 'Database backup retention',
      content: 'Nightly database backups are retained for 1 day and encrypted at rest.',
      confidence: 0.9, evidence: [],
    }]);
    expect((await repo.getKnowledgeItem(seed.item.id))!.status).toBe('active');
    expect(promoted.itemIds).toHaveLength(1);
    expect(promoted.itemIds[0]).not.toBe(seed.item.id);
    expect((await repo.getKnowledgeItem(promoted.itemIds[0]))!.status).toBe('active');
  });

  // Nothing in production calls the single-item writer as automatic yet; this pins that the
  // parameter reaches `resolveDuplicate` for the channel that someday does.
  it('the single-item writer honours the automatic channel too', async () => {
    const seed = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Database backup retention',
      content: 'Nightly database backups are retained for 35 days and encrypted at rest.',
      provenance: 'observed',
    });
    const written = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Database backup retention',
      content: 'Nightly database backups are retained for 1 day and encrypted at rest.',
    }, undefined, undefined, 'automatic');
    expect(written.superseded).toBeUndefined();
    expect(written.nearDuplicate?.id).toBe(seed.item.id);
    expect((await repo.getKnowledgeItem(seed.item.id))!.status).toBe('active');
  });

  it('a captured candidate still supersedes an unverified item', async () => {
    const seed = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Database backup retention',
      content: 'Nightly database backups are retained for 35 days and encrypted at rest.',
    });
    const session = await startMemorySession({ title: 'Ordinary session' });
    await promoteSessionCandidates(projectId, session.id, [{
      candidateType: 'decision', sessionId: session.id, category: 'fact',
      title: 'Database backup retention',
      content: 'Nightly database backups are retained for 90 days and encrypted at rest.',
      confidence: 0.9, evidence: [],
    }]);
    expect((await repo.getKnowledgeItem(seed.item.id))!.status).toBe('superseded');
  });
});
