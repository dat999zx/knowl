import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb, initDb } from '../../src/store/database.js';
import { appendMemorySessionEvent, finishMemorySession, startMemorySession } from '../../src/store/session-repository.js';
import { extractSessionMemoryCandidates } from '../../src/store/session-candidates.js';

const TEST_ROOT = path.resolve('./.knowl-session-candidates-test');

describe('session candidates', () => {
  beforeAll(async () => { await fs.rm(TEST_ROOT, { recursive: true, force: true }); await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true }); await initDb(TEST_ROOT); });
  beforeEach(async () => { const db = getDb() as any; await db.run(sql`DELETE FROM memory_session_events`); await db.run(sql`DELETE FROM memory_sessions`); });
  afterAll(async () => { await closeDb(); await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('derives bounded decision, verified-command, and task-state candidates', async () => {
    const session = await startMemorySession({ title: 'Improve retrieval', query: 'search' });
    await appendMemorySessionEvent(session.id, 'decision', { text: 'Use RRF ranking for hybrid retrieval.' });
    await appendMemorySessionEvent(session.id, 'command', { command: 'npm test', exitCode: 0, summary: 'All tests passed.' });
    await finishMemorySession(session.id, 'finished', 'Improved retrieval ranking.');

    const candidates = await extractSessionMemoryCandidates(session.id);
    expect(candidates).toHaveLength(3);
    expect(candidates.map(candidate => candidate.candidateType)).toEqual(['decision', 'verified-command', 'outcome']);
    expect(candidates.every(candidate => candidate.content.length <= 2_000)).toBe(true);
    expect(candidates.every(candidate => candidate.evidence.length > 0)).toBe(true);
  });
});
