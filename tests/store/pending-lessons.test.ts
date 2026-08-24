import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';
import { captureEventsMode } from '../../src/store/capture-config.js';
import {
  claimLessonBlock,
  markPendingLessons,
  MAX_CORRECTION_LESSONS,
  MAX_LESSON_BLOCKS,
  openPendingLessons,
  recordCorrectionLesson,
  recordDestructiveLesson,
  renderLessonStopReason,
  resolveLessonsBefore,
} from '../../src/store/pending-lessons.js';

/** Fresh root per test, for the reason capture-outcome.test.ts gives: an opened libsql file
 * cannot be unlinked on Windows, so a shared root silently accumulates earlier tests' rows. */
let nextRoot = 0;
const ROOTS: string[] = [];
const freshRoot = (): string => {
  const root = path.resolve(`./.knowl-pending-lessons-${nextRoot += 1}`);
  ROOTS.push(root);
  return root;
};

const HIT = { id: 'process-kill-broad', label: 'a process kill with a broad selector (name, image, filter or pipeline)' } as const;

describe('capture events mode', () => {
  it('reads the three known modes, and anything else as off', () => {
    expect(captureEventsMode({ ...DEFAULT_CONFIG, capture: { events: 'shadow' } })).toBe('shadow');
    expect(captureEventsMode({ ...DEFAULT_CONFIG, capture: { events: 'enforce' } })).toBe('enforce');
    expect(captureEventsMode({ ...DEFAULT_CONFIG, capture: { events: 'banana' } as never })).toBe('off');
    expect(captureEventsMode(undefined)).toBe('off');
  });
});

describe('pending lessons on disk', () => {
  beforeEach(async () => {
    await closeDb();
    await releaseAll();
    const root = freshRoot();
    await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
    await saveConfig(root, { ...DEFAULT_CONFIG });
    await initDb(root);
  });

  afterEach(async () => {
    await closeDb();
    await releaseAll();
  });

  afterAll(async () => {
    await closeDb();
    await releaseAll();
    for (const root of ROOTS) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('records a destructive lesson once per class per conversation', async () => {
    expect(await recordDestructiveLesson('c1', HIT, 'pkill -f node')).toBe(true);
    // The second event of the same class is not news, whatever the command text was.
    expect(await recordDestructiveLesson('c1', HIT, 'taskkill /IM node.exe /F')).toBe(false);
    expect((await openPendingLessons('c1')).map(lesson => lesson.class)).toEqual(['process-kill-broad']);
    // A different conversation is its own ledger.
    expect(await recordDestructiveLesson('c2', HIT, 'pkill -f node')).toBe(true);
  });

  it('clips the stored snippet and never stores correction text at all', async () => {
    const long = `pkill -f ${'x'.repeat(300)}`;
    await recordDestructiveLesson('c1', HIT, long);
    await recordCorrectionLesson('c1');
    const open = await openPendingLessons('c1');
    const destructive = open.find(lesson => lesson.kind === 'destructive');
    const correction = open.find(lesson => lesson.kind === 'correction');
    expect(destructive!.snippet!.length).toBeLessThanOrEqual(121);
    expect(correction!.snippet).toBeNull();
  });

  it('caps corrections per conversation', async () => {
    const results: boolean[] = [];
    for (let i = 0; i < MAX_CORRECTION_LESSONS + 2; i += 1) results.push(await recordCorrectionLesson('c1'));
    expect(results.filter(Boolean)).toHaveLength(MAX_CORRECTION_LESSONS);
  });

  it('a durable write settles only the lessons that predate it', async () => {
    await recordDestructiveLesson('c1', HIT, 'pkill -f node');
    const betweenEvents = new Date().toISOString();
    await new Promise(resolve => setTimeout(resolve, 5));
    await recordDestructiveLesson('c1', { id: 'git-discard', label: 'a git command that discards uncommitted work' }, 'git reset --hard');

    await resolveLessonsBefore('c1', betweenEvents);

    const open = await openPendingLessons('c1');
    // The write could not have been about an event that had not happened yet.
    expect(open.map(lesson => lesson.class)).toEqual(['git-discard']);
  });

  it('spends the block budget exactly MAX_LESSON_BLOCKS times, race-safe', async () => {
    const claims: boolean[] = [];
    for (let i = 0; i < MAX_LESSON_BLOCKS + 3; i += 1) claims.push(await claimLessonBlock('c1'));
    expect(claims).toEqual([true, true, true, false, false, false]);
    // Another conversation has its own budget.
    expect(await claimLessonBlock('c2')).toBe(true);
  });

  it('marking lessons settles them out of the open set', async () => {
    await recordDestructiveLesson('c1', HIT, 'pkill -f node');
    const [lesson] = await openPendingLessons('c1');
    await markPendingLessons([lesson.id], 'shadow');
    expect(await openPendingLessons('c1')).toHaveLength(0);
  });

  it('never throws with no database at all', async () => {
    await closeDb();
    await expect(recordDestructiveLesson('c1', HIT, 'pkill -f x')).resolves.toBe(false);
    await expect(openPendingLessons('c1')).resolves.toEqual([]);
    await expect(claimLessonBlock('c1')).resolves.toBe(false);
    await expect(resolveLessonsBefore('c1', new Date().toISOString())).resolves.toBeUndefined();
  });
});

describe('the stop reason', () => {
  it('lists every open lesson and carries the honest escape hatches', () => {
    const reason = renderLessonStopReason([
      { id: 'a', conversation: 'c1', kind: 'destructive', class: 'process-kill-broad', snippet: 'pkill -f node', observedAt: 'now' },
      { id: 'b', conversation: 'c1', kind: 'correction', class: null, snippet: null, observedAt: 'now' },
    ]);
    expect(reason).toContain('pkill -f node');
    expect(reason).toContain('the user corrected you');
    // (d) is what keeps the gate from teaching fabrication: an empty answer must always be a
    // legal way out.
    expect(reason).toContain('Never invent an incident');
    expect(reason).toContain('knowl_store');
  });
});
