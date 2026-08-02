import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import {
  createResumePoint,
  formatResumeBrief,
  listResumePoints,
  normalizeKey,
  readResumePoint,
} from '../../src/store/resume-points.js';

const TEST_ROOT = path.resolve('./.knowl-resume-points-test');
const PROJECT = 'D:\\Code\\FakeProject';

describe('resume points', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
    await repo.createProject(TEST_ROOT, 'Resume points test');
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('mints a key a person can retype: short, lowercase, no lookalike characters', async () => {
    const point = await createResumePoint(PROJECT, { goal: 'ship the thing', nextAction: 'run the tests' });
    expect(point.key).toMatch(/^[a-z2-9]{6}$/);
    // 0/O and 1/l/I are the characters people transcribe wrongly from a screen.
    expect(point.key).not.toMatch(/[01loi]/);
  });

  it('accepts the key however the user pastes it', () => {
    expect(normalizeKey('  K7X2QM ')).toBe('k7x2qm');
    expect(normalizeKey('knowl:k7x2qm')).toBe('k7x2qm');
    expect(normalizeKey('knowl/resume/k7x2qm')).toBe('k7x2qm');
    expect(normalizeKey('k7x2-qm.')).toBe('k7x2qm');
  });

  it('resumes more than once, because work gets picked up and parked again', async () => {
    const point = await createResumePoint(PROJECT, { goal: 'long haul', nextAction: 'continue' });

    const first = await readResumePoint(point.key);
    expect(first?.brief.goal).toBe('long haul');
    expect(first?.resumeCount).toBe(0);

    // A one-shot key would make Wednesday's pickup an error. It must not.
    const second = await readResumePoint(point.key.toUpperCase());
    expect(second?.brief.goal).toBe('long haul');
    expect(second?.resumeCount).toBe(1);
  });

  it('holds several parked workstreams at once, unlike the single session baton', async () => {
    const a = await createResumePoint(PROJECT, { goal: 'workstream A', nextAction: 'a' });
    const b = await createResumePoint(PROJECT, { goal: 'workstream B', nextAction: 'b' });
    expect(a.key).not.toBe(b.key);

    const parked = await listResumePoints(PROJECT);
    const goals = parked.map(p => p.brief.goal);
    expect(goals).toContain('workstream A');
    expect(goals).toContain('workstream B');
  });

  it('finds a key regardless of which directory it is pasted into', async () => {
    const point = await createResumePoint(PROJECT, { goal: 'cross-directory', nextAction: 'go' });
    // Someone pasting a key in the wrong folder means to reach the work, not to
    // be told it does not exist.
    const found = await readResumePoint(point.key);
    expect(found?.brief.goal).toBe('cross-directory');
  });

  it('returns nothing for an unknown key rather than the nearest match', async () => {
    expect(await readResumePoint('zzzzzz')).toBeNull();
    expect(await readResumePoint('')).toBeNull();
  });

  it('points the resuming session at the transcript instead of trusting the brief', async () => {
    const point = await createResumePoint(PROJECT, {
      goal: 'finish the migration',
      nextAction: 'run the backfill',
      completed: ['schema written'],
      blocker: 'waiting on review',
      verificationStatus: 'typecheck clean, not run end to end',
      sessionId: 'abc-123',
    });

    const brief = formatResumeBrief((await readResumePoint(point.key))!);
    expect(brief).toContain('finish the migration');
    expect(brief).toContain('run the backfill');
    expect(brief).toContain('schema written');
    expect(brief).toContain('waiting on review');
    expect(brief).toContain('not run end to end');
    // The pointer is the point: a brief cannot carry everything, so it must say
    // where the rest lives.
    expect(brief).toContain('abc-123');
    expect(brief).toContain('knowl_transcript_search');
  });
});
