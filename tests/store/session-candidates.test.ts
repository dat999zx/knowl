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

  it('derives durable decisions, not successful command noise', async () => {
    const session = await startMemorySession({ title: 'Improve retrieval', query: 'search' });
    await appendMemorySessionEvent(session.id, 'decision', { text: 'Use RRF ranking for hybrid retrieval.' });
    await appendMemorySessionEvent(session.id, 'command', { command: 'npm test', exitCode: 0, summary: 'All tests passed.' });
    await finishMemorySession(session.id, 'finished', 'Improved retrieval ranking.');

    const candidates = await extractSessionMemoryCandidates(session.id);
    expect(candidates).toHaveLength(1);
    expect(candidates.map(candidate => candidate.candidateType)).toEqual(['decision']);
    expect(candidates.every(candidate => candidate.content.length <= 2_000)).toBe(true);
    expect(candidates.every(candidate => candidate.evidence.length > 0)).toBe(true);
  });

  it('promotes up to 8 importance-ranked decision candidates', async () => {
    const session = await startMemorySession({ title: 'Many decisions', query: 'x' });
    for (let index = 1; index <= 9; index++) {
      await appendMemorySessionEvent(session.id, 'decision', { text: `Decision number ${index} about the system.` });
    }
    await finishMemorySession(session.id, 'finished', 'Wrapped up.');

    const candidates = await extractSessionMemoryCandidates(session.id);
    expect(candidates).toHaveLength(8); // 9 decisions, capped at 8
    expect(candidates.every(candidate => candidate.candidateType === 'decision')).toBe(true);
  });

  it('captures a commit subject as a fact, with evidence', async () => {
    const session = await startMemorySession({ title: 'Commit work', query: 'x' });
    await appendMemorySessionEvent(session.id, 'command', {
      command: 'git add -A && git commit -q -m "fix(store): take writes through the client"',
      exitCode: 0,
    });
    await finishMemorySession(session.id, 'finished');

    const candidates = await extractSessionMemoryCandidates(session.id);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].candidateType).toBe('commit');
    expect(candidates[0].title).toContain('take writes through the client');
    expect(candidates[0].evidence.length).toBeGreaterThan(0);
  });

  it('skips docs, test, chore and merge commits, which are process not knowledge', async () => {
    const session = await startMemorySession({ title: 'Process commits', query: 'x' });
    for (const subject of ['docs: tidy readme', 'test: add a case', 'chore: bump deps', 'Merge branch feat/x']) {
      await appendMemorySessionEvent(session.id, 'command', { command: `git commit -q -m "${subject}"`, exitCode: 0 });
    }
    await finishMemorySession(session.id, 'finished');

    expect(await extractSessionMemoryCandidates(session.id)).toEqual([]);
  });

  it('captures a failure that was fixed, naming the error and the files that changed', async () => {
    const session = await startMemorySession({ title: 'Fix a failure', query: 'x' });
    await appendMemorySessionEvent(session.id, 'error', { message: 'TypeError: retry is not a function' });
    await appendMemorySessionEvent(session.id, 'checkpoint', { changedPaths: ['src/store/retry.ts'] });
    await finishMemorySession(session.id, 'finished');

    const candidates = await extractSessionMemoryCandidates(session.id);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].candidateType).toBe('error');
    expect(candidates[0].content).toContain('TypeError: retry is not a function');
    expect(candidates[0].content).toContain('src/store/retry.ts');
  });

  it('no longer writes a Repeated workflow item however often a command runs', async () => {
    const session = await startMemorySession({ title: 'Repeats', query: 'x' });
    for (let index = 0; index < 5; index++) {
      await appendMemorySessionEvent(session.id, 'command', { command: 'npm run build && npm test', exitCode: 0 });
    }
    await finishMemorySession(session.id, 'finished');

    const candidates = await extractSessionMemoryCandidates(session.id);

    expect(candidates.some((candidate) => candidate.title.startsWith('Repeated workflow'))).toBe(false);
    expect(candidates.some((candidate) => candidate.candidateType === 'verified-command')).toBe(false);
  });

  it('no longer writes a Session outcome item', async () => {
    const session = await startMemorySession({ title: 'Outcome', query: 'x' });
    await appendMemorySessionEvent(session.id, 'decision', { text: 'Use RRF ranking for hybrid retrieval.' });
    await finishMemorySession(session.id, 'finished', 'Wrapped up the work.');

    const candidates = await extractSessionMemoryCandidates(session.id);

    expect(candidates.some((candidate) => candidate.title.startsWith('Session outcome'))).toBe(false);
    expect(candidates.some((candidate) => candidate.candidateType === 'outcome')).toBe(false);
  });
});
