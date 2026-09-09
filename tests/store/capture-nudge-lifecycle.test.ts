import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { NormalizedHostHook } from '../../src/cli/agents/host-hook.js';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';
import { handleHostLifecycleEvent } from '../../src/session/host-lifecycle.js';
import * as repo from '../../src/store/repository.js';
import { conversationKey, MIN_SUBSTANTIVE_TURNS, readCaptureOutcome } from '../../src/store/capture-outcome.js';
import { openPendingLessons, recordCorrectionLesson } from '../../src/store/pending-lessons.js';
import type { CaptureNudgeMode } from '../../src/store/capture-config.js';

// One root per test, for the reason `capture-outcome.test.ts` states at length: a libsql file
// this process opened cannot be unlinked, so a shared root carries the previous test's counters.
//
// And one root per RUN, which is the same hazard a level up. `afterAll`'s `fs.rm` is exactly the
// removal that Windows refuses while libSQL still holds the `-shm` sidecar, so roots survive the
// run that made them -- and a counter restarting at 1 next time hands test N a store that already
// has test N's `capture_outcomes` row in it. That failed whichever assertions happened to land on
// a leftover number, so the file failed differently on each run and passed cleanly on a machine
// that had just swept its worktree.
const RUN = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
let nextRoot = 0;
const ROOTS: string[] = [];

const hook = (root: string, input: Partial<NormalizedHostHook>): NormalizedHostHook => ({
  host: 'claude',
  event: 'turn-start',
  externalSessionId: 'session-under-test',
  externalTurnId: undefined,
  projectRoot: root,
  payload: {},
  ...input,
});

async function withRepo(mode: CaptureNudgeMode | undefined) {
  const root = path.resolve(`./.knowl-capture-nudge-${RUN}-${nextRoot += 1}`);
  ROOTS.push(root);
  await closeDb();
  await releaseAll();
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG, ...(mode ? { capture: { nudge: mode } } : {}) });
  await initDb(root);
  const projectId = (await repo.createProject(root, 'capture nudge')).id;
  return { root, projectId };
}

/**
 * A session that has produced `turns` assistant turns and stored nothing.
 *
 * `turn-start` before every `turn-stop`, because that is the real sequence: `SessionStart` binds
 * the session, `UserPromptSubmit` binds the turn, and `Stop` closes it. A stop with no turn
 * binding is `event-loss` and never reaches the code under test -- which is how the first draft
 * of this file passed a `null` outcome to every assertion.
 */
async function talkFor(root: string, projectId: string, turns: number) {
  let last;
  await handleHostLifecycleEvent(projectId, hook(root, { event: 'session-start' }));
  for (let turn = 0; turn < turns; turn += 1) {
    await handleHostLifecycleEvent(projectId, hook(root, { event: 'turn-start' }));
    last = await handleHostLifecycleEvent(projectId, hook(root, { event: 'turn-stop', status: 'finished' }));
  }
  return last;
}

describe('the write-side negative signal, through the hook path', () => {
  beforeEach(async () => {
    await closeDb();
    await releaseAll();
  });

  afterAll(async () => {
    await closeDb();
    await releaseAll();
    for (const root of ROOTS) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('counts turns even when no nudge is configured', async () => {
    // Measurement before mechanism: the number exists whether or not anyone armed anything,
    // because the decision to arm has to be made against it.
    const { root, projectId } = await withRepo(undefined);

    const result = await talkFor(root, projectId, MIN_SUBSTANTIVE_TURNS);

    expect(result?.hostOutput).toBeUndefined();
    const outcome = await readCaptureOutcome(conversationKey(hook(root, {})));
    expect(outcome).toMatchObject({ turns: MIN_SUBSTANTIVE_TURNS, durableWrites: 0, nudged: null });
  });

  it('records the withheld nudge in shadow, and delivers nothing', async () => {
    const { root, projectId } = await withRepo('shadow');

    const result = await talkFor(root, projectId, MIN_SUBSTANTIVE_TURNS);

    expect(result?.hostOutput).toBeUndefined();
    expect(await readCaptureOutcome(conversationKey(hook(root, {})))).toMatchObject({ nudged: 'shadow' });
  });

  it('blocks the stop once in enforce, and names what to do about it', async () => {
    const { root, projectId } = await withRepo('enforce');

    const result = await talkFor(root, projectId, MIN_SUBSTANTIVE_TURNS);

    expect(result?.hostOutput).toMatchObject({ decision: 'block' });
    expect(String((result!.hostOutput as { reason: string }).reason)).toContain('knowl_store');
  });

  it('never blocks the same session twice', async () => {
    // The no-loop guarantee, end to end. "Stored nothing" is a condition the agent may rightly
    // decline to clear, so a second block is a session that can never finish.
    const { root, projectId } = await withRepo('enforce');

    await talkFor(root, projectId, MIN_SUBSTANTIVE_TURNS);
    await handleHostLifecycleEvent(projectId, hook(root, { event: 'turn-start' }));
    const again = await handleHostLifecycleEvent(projectId, hook(root, { event: 'turn-stop', status: 'finished' }));

    expect(again.hostOutput).toBeUndefined();
  });

  it('stays quiet for a session too short for silence to mean anything', async () => {
    const { root, projectId } = await withRepo('enforce');

    const result = await talkFor(root, projectId, MIN_SUBSTANTIVE_TURNS - 1);

    expect(result?.hostOutput).toBeUndefined();
  });

  it('stays quiet for a session that stored something', async () => {
    const { root, projectId } = await withRepo('enforce');
    await handleHostLifecycleEvent(projectId, hook(root, { event: 'session-start' }));
    await handleHostLifecycleEvent(projectId, hook(root, {
      event: 'session-event',
      type: 'checkpoint',
      toolName: 'mcp__knowl__knowl_store',
      knowlTool: true,
      knowlToolName: 'knowl_store',
      payload: { summary: 'stored a decision' },
    }));

    let result;
    for (let turn = 0; turn < MIN_SUBSTANTIVE_TURNS; turn += 1) {
      await handleHostLifecycleEvent(projectId, hook(root, { event: 'turn-start' }));
      result = await handleHostLifecycleEvent(projectId, hook(root, { event: 'turn-stop', status: 'finished' }));
    }

    expect(result?.hostOutput).toBeUndefined();
    expect(await readCaptureOutcome(conversationKey(hook(root, {})))).toMatchObject({ durableWrites: 1, nudged: null });
  });

  it('does not count a query as a write', async () => {
    const { root, projectId } = await withRepo('enforce');
    await handleHostLifecycleEvent(projectId, hook(root, { event: 'session-start' }));
    await handleHostLifecycleEvent(projectId, hook(root, {
      event: 'session-event',
      type: 'checkpoint',
      toolName: 'mcp__knowl__knowl_query',
      knowlTool: true,
      knowlToolName: 'knowl_query',
      payload: { summary: 'queried memory' },
    }));

    let result;
    for (let turn = 0; turn < MIN_SUBSTANTIVE_TURNS; turn += 1) {
      await handleHostLifecycleEvent(projectId, hook(root, { event: 'turn-start' }));
      result = await handleHostLifecycleEvent(projectId, hook(root, { event: 'turn-stop', status: 'finished' }));
    }

    // A session that retrieved diligently and stored nothing is exactly the case this exists
    // for, so a read must not buy its way out of the nudge.
    expect(result?.hostOutput).toMatchObject({ decision: 'block' });
  });

  it('does not count a failed write as a write', async () => {
    // The refused `knowl_store` -- a secret the validator rejected, a store that threw. It
    // produced nothing and recorded nothing, so counting it would silence the nudge for the
    // rest of the conversation on the strength of a write that never happened. The turn-scoped
    // counter beside it has excluded failures all along; the conversation-scoped one did not.
    const { root, projectId } = await withRepo('enforce');
    await handleHostLifecycleEvent(projectId, hook(root, { event: 'session-start' }));
    await handleHostLifecycleEvent(projectId, hook(root, {
      event: 'session-event',
      type: 'error',
      status: 'failed',
      toolName: 'mcp__knowl__knowl_store',
      knowlTool: true,
      knowlToolName: 'knowl_store',
      errorText: 'refused: content matched a secret pattern',
      payload: { summary: 'store refused' },
    }));

    let result;
    for (let turn = 0; turn < MIN_SUBSTANTIVE_TURNS; turn += 1) {
      await handleHostLifecycleEvent(projectId, hook(root, { event: 'turn-start' }));
      result = await handleHostLifecycleEvent(projectId, hook(root, { event: 'turn-stop', status: 'finished' }));
    }

    expect(await readCaptureOutcome(conversationKey(hook(root, {})))).toMatchObject({ durableWrites: 0 });
    expect(result?.hostOutput).toMatchObject({ decision: 'block' });
  });

  it('leaves a pending lesson open when the write that would settle it failed', async () => {
    // The second half of the same guard. Lessons are settled by a durable write because a write
    // is evidence the correction was recorded -- a failed one is evidence of the opposite, and
    // clearing on it drops the lesson silently.
    const { root, projectId } = await withRepo('shadow');
    const conversation = conversationKey(hook(root, {}));
    await handleHostLifecycleEvent(projectId, hook(root, { event: 'session-start' }));
    await recordCorrectionLesson(conversation);
    expect(await openPendingLessons(conversation)).toHaveLength(1);

    await handleHostLifecycleEvent(projectId, hook(root, {
      event: 'session-event',
      type: 'error',
      status: 'failed',
      toolName: 'mcp__knowl__knowl_store',
      knowlTool: true,
      knowlToolName: 'knowl_store',
      errorText: 'refused: content matched a secret pattern',
      payload: { summary: 'store refused' },
    }));

    expect(await openPendingLessons(conversation)).toHaveLength(1);
  });

  it('never blocks a host with no verified stop channel', async () => {
    const { root, projectId } = await withRepo('enforce');

    let result;
    await handleHostLifecycleEvent(projectId, hook(root, { host: 'generic', event: 'session-start' }));
    for (let turn = 0; turn < MIN_SUBSTANTIVE_TURNS; turn += 1) {
      await handleHostLifecycleEvent(projectId, hook(root, { host: 'generic', event: 'turn-start' }));
      result = await handleHostLifecycleEvent(projectId, hook(root, {
        host: 'generic', event: 'turn-stop', status: 'finished',
      }));
    }

    expect(result?.hostOutput).toBeUndefined();
    // And the claim was not spent on a delivery that could not happen: turning this on for an
    // unsupported host must not look identical to it having fired.
    expect(await readCaptureOutcome(conversationKey(hook(root, { host: 'generic' })))).toMatchObject({ nudged: null });
  });
});
