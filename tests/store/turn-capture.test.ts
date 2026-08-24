import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';
import { captureScope } from '../../src/store/capture-config.js';
import {
  claimTurnCapturePrompt,
  MAX_TURN_CAPTURE_PROMPTS,
  MIN_SUBSTANTIVE_TURN_EVENTS,
  recordTurnToolEvent,
  resetTurnCapture,
  shouldPromptTurnCapture,
  type TurnCaptureOutcome,
} from '../../src/store/capture-outcome.js';

let nextRoot = 0;
const ROOTS: string[] = [];
const freshRoot = (): string => {
  const root = path.resolve(`./.knowl-turn-capture-${nextRoot += 1}`);
  ROOTS.push(root);
  return root;
};

describe('capture scope', () => {
  it('reads turn, and anything else as conversation', () => {
    expect(captureScope({ ...DEFAULT_CONFIG, capture: { scope: 'turn' } })).toBe('turn');
    expect(captureScope({ ...DEFAULT_CONFIG, capture: { scope: 'conversation' } })).toBe('conversation');
    expect(captureScope({ ...DEFAULT_CONFIG, capture: { scope: 'session' } as never })).toBe('conversation');
    expect(captureScope(undefined)).toBe('conversation');
  });
});

describe('the turn verdict', () => {
  const outcome = (over: Partial<TurnCaptureOutcome>): TurnCaptureOutcome => ({
    turnKey: 't1', conversation: 'c1',
    toolEvents: MIN_SUBSTANTIVE_TURN_EVENTS, fileWrites: 1, durableWrites: 0, prompted: null,
    ...over,
  });

  it('fires for a turn that built something and stored nothing', () => {
    expect(shouldPromptTurnCapture(outcome({}))).toBe(true);
  });

  it('stays quiet below the event floor, without a file write, after a durable write, once prompted, and with no record', () => {
    expect(shouldPromptTurnCapture(outcome({ toolEvents: MIN_SUBSTANTIVE_TURN_EVENTS - 1 }))).toBe(false);
    expect(shouldPromptTurnCapture(outcome({ fileWrites: 0 }))).toBe(false);
    expect(shouldPromptTurnCapture(outcome({ durableWrites: 1 }))).toBe(false);
    expect(shouldPromptTurnCapture(outcome({ prompted: 'prompted' }))).toBe(false);
    expect(shouldPromptTurnCapture(null)).toBe(false);
  });
});

describe('turn capture on disk', () => {
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

  it('counts events and returns the updated row from the same write', async () => {
    await recordTurnToolEvent('t1', 'c1', { fileWrite: false, durableWrite: false });
    const row = await recordTurnToolEvent('t1', 'c1', { fileWrite: true, durableWrite: false });
    expect(row).toMatchObject({ toolEvents: 2, fileWrites: 1, durableWrites: 0, prompted: null });
  });

  it('claims once per turn, and the boundary reset re-arms the next turn', async () => {
    await recordTurnToolEvent('t1', 'c1', { fileWrite: true, durableWrite: false });
    expect(await claimTurnCapturePrompt('t1', 'c1')).toBe(true);
    expect(await claimTurnCapturePrompt('t1', 'c1')).toBe(false);

    // The boundary delete is what makes a reused key per-turn: fresh counters, fresh claim.
    await resetTurnCapture('t1');
    const next = await recordTurnToolEvent('t1', 'c1', { fileWrite: true, durableWrite: false });
    expect(next).toMatchObject({ toolEvents: 1, prompted: null });
    expect(await claimTurnCapturePrompt('t1', 'c1')).toBe(true);
  });

  it('the conversation ceiling survives turn resets and stops at the cap', async () => {
    const claims: boolean[] = [];
    for (let turn = 0; turn < MAX_TURN_CAPTURE_PROMPTS + 2; turn += 1) {
      await recordTurnToolEvent('t1', 'c1', { fileWrite: true, durableWrite: false });
      claims.push(await claimTurnCapturePrompt('t1', 'c1'));
      await resetTurnCapture('t1');
    }
    expect(claims).toEqual([true, true, true, false, false]);
    // Another conversation has its own ceiling.
    await recordTurnToolEvent('t9', 'c2', { fileWrite: true, durableWrite: false });
    expect(await claimTurnCapturePrompt('t9', 'c2')).toBe(true);
  });

  it('never throws with no database at all', async () => {
    await closeDb();
    await expect(recordTurnToolEvent('t1', 'c1', { fileWrite: false, durableWrite: false })).resolves.toBeNull();
    await expect(claimTurnCapturePrompt('t1', 'c1')).resolves.toBe(false);
    await expect(resetTurnCapture('t1')).resolves.toBeUndefined();
  });
});
