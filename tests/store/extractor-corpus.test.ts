import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCommitSubjects } from '../../src/store/extractors/commit-subject.js';
import { findFailureFixPairs } from '../../src/store/extractors/failure-fix.js';
import type { MemorySessionEvent } from '../../src/core/types.js';

const CORPUS = path.join('benchmarks', 'unassisted-capture', 'corpus', 'events.json');

async function corpusEvents(): Promise<Map<string, MemorySessionEvent[]>> {
  const rows = JSON.parse(await fs.readFile(CORPUS, 'utf8')) as any[];
  const bySession = new Map<string, MemorySessionEvent[]>();
  for (const row of rows) {
    const sessionId = String(row.session_id);
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(String(row.payload)); } catch { payload = {}; }
    const event = {
      id: String(row.id),
      sessionId,
      type: row.type,
      payload,
      observedAt: String(row.observed_at),
      expiresAt: String(row.expires_at),
    } as MemorySessionEvent;
    const bucket = bySession.get(sessionId);
    if (bucket) bucket.push(event); else bySession.set(sessionId, [event]);
  }
  return bySession;
}

describe('extractor rules against the recorded corpus', () => {
  it('recovers commit subjects from real sessions', async () => {
    const bySession = await corpusEvents();
    let sessionsWithCommits = 0;
    let totalSubjects = 0;

    for (const events of bySession.values()) {
      const subjects = events
        .filter((event) => event.type === 'command')
        .flatMap((event) => parseCommitSubjects(String(event.payload.command ?? '')));
      if (subjects.length > 0) sessionsWithCommits++;
      totalSubjects += subjects.length;
    }

    // Measured during the capture experiment: 36 subjects across 14 of 32 sessions.
    // Asserted as floors so an improved parser is not a failure.
    expect(sessionsWithCommits).toBeGreaterThanOrEqual(14);
    expect(totalSubjects).toBeGreaterThanOrEqual(36);
  });

  it('finds resolved failures in real sessions', async () => {
    const bySession = await corpusEvents();
    const sessionsWithPairs = [...bySession.values()].filter((events) => findFailureFixPairs(events).length > 0);

    // 16 of 32 sessions contain at least one error; not every error was resolved
    // in-session, so the floor is deliberately lower than 16.
    expect(sessionsWithPairs.length).toBeGreaterThanOrEqual(5);
  });

  it('produces no candidate at all for the stub sessions the corpus excluded', async () => {
    // Every corpus session cleared >=10 events and >=2 changed paths, so each should
    // yield something from at least one rule. A rule set that fires on none of them
    // would be inert the way the previous one was.
    const bySession = await corpusEvents();
    const productive = [...bySession.values()].filter((events) => {
      const commits = events.filter((e) => e.type === 'command').flatMap((e) => parseCommitSubjects(String(e.payload.command ?? '')));
      return commits.length > 0 || findFailureFixPairs(events).length > 0;
    });

    expect(productive.length).toBeGreaterThanOrEqual(20);
  });
});
