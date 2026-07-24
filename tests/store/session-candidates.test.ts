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

  it('derives durable decisions and outcomes, not successful command noise', async () => {
    const session = await startMemorySession({ title: 'Improve retrieval', query: 'search' });
    await appendMemorySessionEvent(session.id, 'decision', { text: 'Use RRF ranking for hybrid retrieval.' });
    await appendMemorySessionEvent(session.id, 'command', { command: 'npm test', exitCode: 0, summary: 'All tests passed.' });
    await finishMemorySession(session.id, 'finished', 'Improved retrieval ranking.');

    const candidates = await extractSessionMemoryCandidates(session.id);
    expect(candidates).toHaveLength(2);
    expect(candidates.map(candidate => candidate.candidateType)).toEqual(['decision', 'outcome']);
    expect(candidates.every(candidate => candidate.content.length <= 2_000)).toBe(true);
    expect(candidates.every(candidate => candidate.evidence.length > 0)).toBe(true);
  });

  it('promotes up to 8 importance-ranked candidates, decisions before the outcome', async () => {
    const session = await startMemorySession({ title: 'Many decisions', query: 'x' });
    for (let index = 1; index <= 7; index++) {
      await appendMemorySessionEvent(session.id, 'decision', { text: `Decision number ${index} about the system.` });
    }
    await finishMemorySession(session.id, 'finished', 'Wrapped up.');

    const candidates = await extractSessionMemoryCandidates(session.id);
    expect(candidates).toHaveLength(8); // 7 decisions + 1 outcome, above the old cap of 5
    expect(candidates.slice(0, 7).every(candidate => candidate.candidateType === 'decision')).toBe(true);
    expect(candidates[7].candidateType).toBe('outcome');
  });
});
