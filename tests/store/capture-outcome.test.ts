import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';
import { captureNudgeMode } from '../../src/store/capture-config.js';
import {
  captureHealth,
  claimSilenceNudge,
  isDurableWriteTool,
  conversationKey,
  MIN_SUBSTANTIVE_TURNS,
  readCaptureOutcome,
  recordDurableWrite,
  recordSessionTurn,
  shouldNudgeForSilence,
} from '../../src/store/capture-outcome.js';

/*
 * A fresh root per test, rather than one root cleaned between them.
 *
 * The obvious shape -- one directory, `fs.rm` in `beforeEach` -- silently does nothing here: a
 * process cannot unlink a libsql file it has opened, so on Windows the remove fails, the same
 * database survives, and every count in this file reads the previous test's rows plus its own.
 * It fails as wrong numbers rather than as an error, which is the kind of test bug that gets
 * "fixed" by loosening the assertion.
 */
let nextRoot = 0;
const ROOTS: string[] = [];
const freshRoot = (): string => {
  const root = path.resolve(`./.knowl-capture-outcome-${nextRoot += 1}`);
  ROOTS.push(root);
  return root;
};

describe('capture nudge mode', () => {
  it('reads only the three known modes, and anything else as off', () => {
    expect(captureNudgeMode({ ...DEFAULT_CONFIG, capture: { nudge: 'shadow' } })).toBe('shadow');
    expect(captureNudgeMode({ ...DEFAULT_CONFIG, capture: { nudge: 'enforce' } })).toBe('enforce');
    expect(captureNudgeMode({ ...DEFAULT_CONFIG, capture: { nudge: 'off' } })).toBe('off');
  });

  it('fails towards silence on a hand-edited value', () => {
    // `enforce` blocks a stop, and config.json is a file people edit by hand. A typo must not
    // be the thing that starts interrupting them.
    expect(captureNudgeMode({ ...DEFAULT_CONFIG, capture: { nudge: 'yes' } as never })).toBe('off');
    expect(captureNudgeMode({ ...DEFAULT_CONFIG })).toBe('off');
    expect(captureNudgeMode(undefined)).toBe('off');
  });
});

describe('durable write tools', () => {
  it('counts the four tools that put knowledge in the store', () => {
    for (const tool of ['knowl_store', 'knowl_decide', 'knowl_update', 'knowl_ingest_atoms']) {
      expect(isDurableWriteTool(tool), tool).toBe(true);
    }
  });

  it('does not count a read as a write', () => {
    // The whole point is catching a session that queried diligently and stored nothing, so
    // counting retrieval here would hide exactly what is being looked for.
    for (const tool of ['knowl_query', 'knowl_recent', 'knowl_state', 'knowl_context', undefined]) {
      expect(isDurableWriteTool(tool), String(tool)).toBe(false);
    }
  });
});

describe('the silence verdict', () => {
  const outcome = (over: Partial<{ turns: number; durableWrites: number; nudged: string | null }>) => ({
    conversation: 's1', turns: MIN_SUBSTANTIVE_TURNS, durableWrites: 0, nudged: null, ...over,
  });

  it('fires for a session that ran long enough and stored nothing', () => {
    expect(shouldNudgeForSilence(outcome({}))).toBe(true);
  });

  it('stays quiet when the session stored something', () => {
    expect(shouldNudgeForSilence(outcome({ durableWrites: 1 }))).toBe(false);
  });

  it('stays quiet for a session too short for silence to mean anything', () => {
    expect(shouldNudgeForSilence(outcome({ turns: MIN_SUBSTANTIVE_TURNS - 1 }))).toBe(false);
  });

  it('stays quiet once the session has already been nudged', () => {
    expect(shouldNudgeForSilence(outcome({ nudged: 'enforce' }))).toBe(false);
  });

  it('stays quiet for a session it has no record of', () => {
    expect(shouldNudgeForSilence(null)).toBe(false);
  });
});

describe('capture outcomes on disk', () => {
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

  it('counts turns and writes independently, whichever arrives first', async () => {
    await recordDurableWrite('s1');
    await recordSessionTurn('s1');
    await recordSessionTurn('s1');

    expect(await readCaptureOutcome('s1')).toMatchObject({ turns: 2, durableWrites: 1 });
  });

  it('starts a row from either counter', async () => {
    await recordSessionTurn('turn-first');
    await recordDurableWrite('write-first');

    expect(await readCaptureOutcome('turn-first')).toMatchObject({ turns: 1, durableWrites: 0 });
    expect(await readCaptureOutcome('write-first')).toMatchObject({ turns: 0, durableWrites: 1 });
  });

  it('gives a session exactly one nudge, however many stops it takes', async () => {
    // The no-loop guarantee. In enforce mode the nudge is delivered by blocking a stop, and the
    // agent cannot clear "stored nothing" by any action it may reasonably want to take -- so a
    // second claim succeeding is an agent that can never finish.
    await recordSessionTurn('s1');

    expect(await claimSilenceNudge('s1', 'enforce')).toBe(true);
    expect(await claimSilenceNudge('s1', 'enforce')).toBe(false);
    expect(await readCaptureOutcome('s1')).toMatchObject({ nudged: 'enforce' });
  });

  it('does not claim a session it has never seen', async () => {
    expect(await claimSilenceNudge('never-seen', 'enforce')).toBe(false);
  });

  it('survives a blank session id rather than writing a row that joins to nothing', async () => {
    await recordSessionTurn('');
    await recordDurableWrite('   ');

    expect(await captureHealth()).toMatchObject({ sessions: 0 });
    expect(await readCaptureOutcome('')).toBeNull();
  });

  it('reports the health of the repo, counting only long-enough silences as substantive', async () => {
    // Talked and stored nothing.
    for (let turn = 0; turn < MIN_SUBSTANTIVE_TURNS; turn += 1) await recordSessionTurn('silent');
    // One question, one answer, nothing to store -- silent, but correctly so.
    await recordSessionTurn('brief');
    // Did the right thing.
    for (let turn = 0; turn < MIN_SUBSTANTIVE_TURNS; turn += 1) await recordSessionTurn('wrote');
    await recordDurableWrite('wrote');

    expect(await captureHealth()).toEqual({ sessions: 3, silent: 2, substantiveSilent: 1, nudged: 0 });
  });

  it('reports no sessions rather than throwing when the table has never been written', async () => {
    expect(await captureHealth()).toEqual({ sessions: 0, silent: 0, substantiveSilent: 0, nudged: 0 });
  });

  it('round-trips a composite key through the row it was stored in', async () => {
    // The separator is load-bearing and the failure is silent: under NUL the libsql client
    // truncates this key on the READ path, so `stored` comes back as `claude` alone and binding
    // it finds nothing -- while every assertion above still passes, because they all recompute
    // the key rather than reading one. This is the only test that reads one back.
    const key = conversationKey({ host: 'claude', projectRoot: 'D:/coding/knowl', externalSessionId: 's1' });
    await recordSessionTurn(key);

    const rows = await getClient().execute('SELECT conversation FROM capture_outcomes');
    const stored = String(rows.rows[0]?.conversation);

    expect(stored).toBe(key);
    expect(await readCaptureOutcome(stored)).toMatchObject({ turns: 1 });
  });

  it('counts one conversation on one row however the host spelled the project root', async () => {
    // The raw root split one conversation across two rows -- 33 turns on one, 1 on the other, on
    // a real store -- and every counter keyed this way then read a fragment: capture health, the
    // `turns >= 3` silence threshold, and the prompt reminder's drift gate.
    //
    // Asserted through `canonicalProjectRoot` rather than against a literal, because what counts
    // as the same root is per-platform and the first version of this test hardcoded Windows: it
    // compared `D:/...` with `d:/...`, which POSIX resolves to two different directories under
    // the CWD and case-sensitively, so it failed on ubuntu and macos while passing on windows.
    const key = (root: string) => conversationKey({ host: 'claude', projectRoot: root, externalSessionId: 's1' });
    const root = process.cwd();
    // Unnormalised but equivalent, on every platform: `path.resolve` collapses the round trip.
    expect(key(path.join(root, 'child', '..'))).toBe(key(root));
    // Drive-letter case, only where drive letters exist. This is the split that was observed.
    if (process.platform === 'win32') expect(key(root.toLowerCase())).toBe(key(root.toUpperCase()));

    await recordSessionTurn(key(root));
    await recordSessionTurn(key(path.join(root, 'child', '..')));
    expect(await readCaptureOutcome(key(root))).toMatchObject({ turns: 2 });
  });
});
