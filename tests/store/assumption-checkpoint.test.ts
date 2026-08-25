import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import {
  claimAssumptionCheckpoint,
  openPendingLessons,
  recordCorrectionLesson,
  resolveLessonsBefore,
} from '../../src/store/pending-lessons.js';
import { captureCheckpointMode, CHECKPOINT_EVERY_TURNS } from '../../src/store/capture-config.js';
import type { ProjectConfig } from '../../src/core/types.js';

/**
 * #184: a periodic checkpoint asking what the session is relying on but never verified. It is a
 * question, never a block — the two tests that matter are that it claims once per window and
 * that it stays out of the stop gate.
 */

let root: string;
const CONVERSATION = 'host/reposession-1';

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-checkpoint-'));
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await initDb(root);
});

afterEach(async () => {
  await closeDb();
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

describe('assumption checkpoint', () => {
  it('claims a window once, however many tool events race it', async () => {
    const first = await claimAssumptionCheckpoint(CONVERSATION, 1);
    const again = await claimAssumptionCheckpoint(CONVERSATION, 1);
    const later = await claimAssumptionCheckpoint(CONVERSATION, 2);

    expect(first).toBe(true);
    // The hook is a fresh process per tool call, so "already fired" cannot live in memory.
    expect(again).toBe(false);
    expect(later).toBe(true);
  });

  it('never reaches the stop gate', async () => {
    await claimAssumptionCheckpoint(CONVERSATION, 1);
    await recordCorrectionLesson(CONVERSATION);

    // `openPendingLessons` has exactly one consumer: the gate that withholds a stop. A checkpoint
    // is raised on a counter rather than an observed event, so blocking over one would spend the
    // annoyance budget on a guess.
    const open = await openPendingLessons(CONVERSATION);

    expect(open.map(lesson => lesson.kind)).toEqual(['correction']);
  });

  it('is settled by a durable write, like any other lesson', async () => {
    await claimAssumptionCheckpoint(CONVERSATION, 1);
    await resolveLessonsBefore(CONVERSATION, new Date(Date.now() + 1000).toISOString());

    // Settled means the next window can still ask, but this one is closed rather than pending.
    const reclaimed = await claimAssumptionCheckpoint(CONVERSATION, 1);
    expect(reclaimed, 'a settled window is not re-asked').toBe(false);
  });

  it('is off unless armed, and does not read a mode it was not given', () => {
    expect(captureCheckpointMode(undefined)).toBe('off');
    expect(captureCheckpointMode({} as ProjectConfig)).toBe('off');
    expect(captureCheckpointMode({ capture: {} } as ProjectConfig)).toBe('off');
    expect(captureCheckpointMode({ capture: { checkpoint: 'off' } } as ProjectConfig)).toBe('off');
    expect(captureCheckpointMode({ capture: { checkpoint: 'ask' } } as ProjectConfig)).toBe('ask');
    // A typo falls back to the quieter reading, matching every other capture mode.
    expect(captureCheckpointMode({ capture: { checkpoint: 'enforce' } } as unknown as ProjectConfig)).toBe('off');
  });

  it('counts in turns, and the first window needs a real stretch of work', () => {
    const windowFor = (turns: number) => Math.floor(turns / CHECKPOINT_EVERY_TURNS);

    expect(windowFor(0)).toBe(0);
    expect(windowFor(CHECKPOINT_EVERY_TURNS - 1)).toBe(0);
    expect(windowFor(CHECKPOINT_EVERY_TURNS)).toBe(1);
    expect(windowFor(CHECKPOINT_EVERY_TURNS * 2)).toBe(2);
  });
});
