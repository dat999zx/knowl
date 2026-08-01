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
    expect(candidates[0].category).toBe('fact');
    expect(candidates[0].title).toContain('take writes through the client');
    expect(candidates[0].evidence.length).toBeGreaterThan(0);
  });

  it('files a feat commit as architecture, not as a fact', async () => {
    const session = await startMemorySession({ title: 'Feature work', query: 'x' });
    await appendMemorySessionEvent(session.id, 'command', {
      command: 'git commit -q -m "feat(workspace): record a role per linked repo"',
      exitCode: 0,
    });
    await finishMemorySession(session.id, 'finished');

    const candidates = await extractSessionMemoryCandidates(session.id);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].category).toBe('architecture');
  });

  it("captures the real subject of a commit written in the $(cat <<'EOF') form", async () => {
    const session = await startMemorySession({ title: 'Heredoc commit', query: 'x' });
    await appendMemorySessionEvent(session.id, 'command', {
      command: `git add -A && git commit -m "$(cat <<'EOF'\nfeat(store): widen the write path\n\nThe orchestrator now assembles candidates.\nEOF\n)"`,
      exitCode: 0,
    });
    await finishMemorySession(session.id, 'finished');

    const candidates = await extractSessionMemoryCandidates(session.id);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].title).toBe('feat(store): widen the write path');
    expect(candidates[0].content).toContain('The orchestrator now assembles candidates.');
  });

  it("skips a docs commit written in the $(cat <<'EOF') form", async () => {
    // The skip list is keyed on the conventional-commit type. A subject that starts
    // with shell syntax has no type, so the whole skip rule is bypassed.
    const session = await startMemorySession({ title: 'Heredoc docs commit', query: 'x' });
    await appendMemorySessionEvent(session.id, 'command', {
      command: `git add -A && git commit -m "$(cat <<'EOF'\ndocs: tidy the readme\n\nNothing durable here.\nEOF\n)"`,
      exitCode: 0,
    });
    await finishMemorySession(session.id, 'finished');

    expect(await extractSessionMemoryCandidates(session.id)).toEqual([]);
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

  it('gives two unrelated failures distinct titles, even when both start with the exit line', async () => {
    // Real error payloads open with the shell's exit line, so a title taken from the
    // first line collides across every failure in the corpus. Colliding titles are
    // read as the same subject by the write path, which then retires the earlier item.
    const session = await startMemorySession({ title: 'Two failures', query: 'x' });
    await appendMemorySessionEvent(session.id, 'error', {
      message: 'Exit code 1\nsrc/store/a.ts(3,5): error TS2339: Property foo does not exist on type Bar',
    });
    await appendMemorySessionEvent(session.id, 'checkpoint', { changedPaths: ['src/store/a.ts'] });
    await appendMemorySessionEvent(session.id, 'error', {
      message: 'Exit code 1\nFAIL tests/render.test.ts > renders the header',
    });
    await appendMemorySessionEvent(session.id, 'checkpoint', { changedPaths: ['tests/render.test.ts'] });
    await finishMemorySession(session.id, 'finished');

    const titles = (await extractSessionMemoryCandidates(session.id))
      .filter((candidate) => candidate.candidateType === 'error')
      .map((candidate) => candidate.title);

    expect(titles).toHaveLength(2);
    expect(new Set(titles).size).toBe(2);
    // Distinctness alone is not enough: the title must name the actual failure, or
    // it carries no subject for the reader or for the write path's subject match.
    expect(titles.find((title) => title.includes('src/store/a.ts'))).toContain('TS2339');
    expect(titles.find((title) => title.includes('tests/render.test.ts'))).toContain('renders the header');
    for (const title of titles) expect(title).not.toMatch(/:\s*Exit code \d+$/i);
  });

  it('distinguishes two failures whose first meaningful line is identical, by the path that changed', async () => {
    // Skipping the exit line is not enough on its own: the next line is often the
    // runner's generic "npm ERR!" banner, identical across unrelated failures.
    const banner = 'Exit code 1\nnpm ERR! Test failed. See above for more details.';
    const session = await startMemorySession({ title: 'Same banner', query: 'x' });
    // The two messages must differ enough that errorSignature tells them apart, or
    // the second reads as a recurrence of the first and neither pairs at all. Bare
    // filenames, because the signature strips multi-segment paths.
    await appendMemorySessionEvent(session.id, 'error', { message: `${banner}\nFAIL writer.test.ts` });
    await appendMemorySessionEvent(session.id, 'checkpoint', { changedPaths: ['src/store/writer.ts'] });
    await appendMemorySessionEvent(session.id, 'error', { message: `${banner}\nFAIL report.test.ts` });
    await appendMemorySessionEvent(session.id, 'checkpoint', { changedPaths: ['src/cli/report.ts'] });
    await finishMemorySession(session.id, 'finished');

    const titles = (await extractSessionMemoryCandidates(session.id))
      .filter((candidate) => candidate.candidateType === 'error')
      .map((candidate) => candidate.title);

    expect(titles).toHaveLength(2);
    expect(new Set(titles).size).toBe(2);
  });

  it('keeps the resolution line even when the error message fills the content budget', async () => {
    // The capture layer already caps the message at exactly MAX_CONTENT_CHARS, so
    // slicing the joined string drops the only evidence that anything was resolved.
    const session = await startMemorySession({ title: 'Long failure', query: 'x' });
    await appendMemorySessionEvent(session.id, 'error', { message: `Exit code 1\n${'stack frame noise '.repeat(110)}` });
    await appendMemorySessionEvent(session.id, 'checkpoint', { changedPaths: ['src/store/knowledge-writer.ts'] });
    await finishMemorySession(session.id, 'finished');

    const candidates = await extractSessionMemoryCandidates(session.id);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].content).toContain('Resolved after changing: src/store/knowledge-writer.ts');
    expect(candidates[0].content.length).toBeLessThanOrEqual(2_000);
  });

  it('survives a malformed event payload instead of losing the whole session', async () => {
    const session = await startMemorySession({ title: 'Bad payload', query: 'x' });
    await appendMemorySessionEvent(session.id, 'command', {
      command: 'git commit -q -m "fix(store): guard the payload parse"',
      exitCode: 0,
    });
    await finishMemorySession(session.id, 'finished');
    const db = getDb() as any;
    await db.run(sql`INSERT INTO memory_session_events (id, session_id, type, payload, observed_at, expires_at)
      VALUES ('broken-1', ${session.id}, 'command', '{not json', '2999-01-01T00:00:00.000Z', '2999-01-02T00:00:00.000Z')`);

    const candidates = await extractSessionMemoryCandidates(session.id);

    expect(candidates.map((candidate) => candidate.title)).toContain('fix(store): guard the payload parse');
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
