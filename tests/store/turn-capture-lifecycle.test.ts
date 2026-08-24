import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { NormalizedHostHook } from '../../src/cli/agents/host-hook.js';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';
import { handleHostLifecycleEvent } from '../../src/session/host-lifecycle.js';
import * as repo from '../../src/store/repository.js';
import { MIN_SUBSTANTIVE_TURN_EVENTS } from '../../src/store/capture-outcome.js';

/**
 * The turn-scoped capture prompt through the hook path. The property under test throughout:
 * querying memory does not quiet it -- only a durable write does -- because the session every
 * other reminder goes silent for is the memory-active one.
 */
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

async function withRepo(scope: 'turn' | undefined) {
  const root = path.resolve(`./.knowl-turn-lifecycle-${nextRoot += 1}`);
  ROOTS.push(root);
  await closeDb();
  await releaseAll();
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG, ...(scope ? { capture: { scope } } : {}) });
  await initDb(root);
  const projectId = (await repo.createProject(root, 'turn capture')).id;
  await handleHostLifecycleEvent(projectId, hook(root, { event: 'session-start' }));
  await handleHostLifecycleEvent(projectId, hook(root, { event: 'turn-start' }));
  return { root, projectId };
}

const command = (root: string, text: string) =>
  hook(root, { event: 'session-event', type: 'command', payload: { command: text, exitCode: 0 } });

const fileWrite = (root: string) =>
  hook(root, { event: 'session-event', type: 'checkpoint', toolName: 'Edit', payload: { changedPaths: ['src/thing.ts'] } });

// Distinct summaries per call: two byte-identical events would be debounced as one hook
// firing twice, which is not the shape being simulated.
const knowlRead = (root: string, n: number) =>
  hook(root, {
    event: 'session-event', type: 'checkpoint', knowlTool: true, knowlToolName: 'knowl_query',
    payload: { summary: `knowl_query completed (${n})` },
  });

const knowlWrite = (root: string) =>
  hook(root, {
    event: 'session-event', type: 'checkpoint', knowlTool: true, knowlToolName: 'knowl_store',
    payload: { summary: 'knowl_store completed' },
  });

const contextOf = (result: { hostOutput?: Record<string, unknown> } | undefined): string => {
  const specific = result?.hostOutput?.hookSpecificOutput as { additionalContext?: string } | undefined;
  return String(specific?.additionalContext ?? '');
};

/** Drive a substantive turn: one file write, then harmless commands up to the event floor. */
async function substantiveTurn(root: string, projectId: string, events = MIN_SUBSTANTIVE_TURN_EVENTS) {
  const outputs: string[] = [];
  outputs.push(contextOf(await handleHostLifecycleEvent(projectId, fileWrite(root))));
  for (let i = 1; i < events; i += 1) {
    outputs.push(contextOf(await handleHostLifecycleEvent(projectId, command(root, `npm run step-${i}`))));
  }
  return outputs;
}

describe('the turn-scoped capture prompt, through the hook path', () => {
  beforeEach(async () => {
    await closeDb();
    await releaseAll();
  });

  afterAll(async () => {
    await closeDb();
    await releaseAll();
    for (const root of ROOTS) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('says nothing at the default scope, however substantive the turn', async () => {
    const { root, projectId } = await withRepo(undefined);
    const outputs = await substantiveTurn(root, projectId, MIN_SUBSTANTIVE_TURN_EVENTS + 4);
    expect(outputs.every(text => !text.includes('KNOWL CAPTURE'))).toBe(true);
  });

  it('prompts exactly once when a substantive turn has stored nothing', async () => {
    const { root, projectId } = await withRepo('turn');
    const outputs = await substantiveTurn(root, projectId, MIN_SUBSTANTIVE_TURN_EVENTS + 6);
    expect(outputs.filter(text => text.includes('KNOWL CAPTURE'))).toHaveLength(1);
  });

  it('a knowl query does not quiet it -- the memory-active session is the target', async () => {
    const { root, projectId } = await withRepo('turn');
    await handleHostLifecycleEvent(projectId, fileWrite(root));
    for (let i = 0; i < MIN_SUBSTANTIVE_TURN_EVENTS - 2; i += 1) {
      await handleHostLifecycleEvent(projectId, command(root, `npm run step-${i}`));
    }
    // The threshold-crossing event is itself a query -- the twelfth event of the turn -- which
    // every other reminder treats as proof of memory health. This one prompts anyway.
    const crossing = await handleHostLifecycleEvent(projectId, knowlRead(root, 1));
    expect(contextOf(crossing)).toContain('KNOWL CAPTURE');
    // And once spent, a further query changes nothing.
    const after = await handleHostLifecycleEvent(projectId, knowlRead(root, 2));
    expect(contextOf(after)).not.toContain('KNOWL CAPTURE');
  });

  it('a durable write quiets it for the turn', async () => {
    const { root, projectId } = await withRepo('turn');
    await handleHostLifecycleEvent(projectId, knowlWrite(root));
    const outputs = await substantiveTurn(root, projectId, MIN_SUBSTANTIVE_TURN_EVENTS + 4);
    expect(outputs.every(text => !text.includes('KNOWL CAPTURE'))).toBe(true);
  });

  it('the turn boundary resets the counters', async () => {
    const { root, projectId } = await withRepo('turn');
    await substantiveTurn(root, projectId, MIN_SUBSTANTIVE_TURN_EVENTS - 1);
    await handleHostLifecycleEvent(projectId, hook(root, { event: 'turn-stop', status: 'finished' }));
    await handleHostLifecycleEvent(projectId, hook(root, { event: 'turn-start' }));
    // One more event in the new turn is nowhere near the floor; the eleven from the last
    // turn must not carry over.
    const first = await handleHostLifecycleEvent(projectId, fileWrite(root));
    expect(contextOf(first)).not.toContain('KNOWL CAPTURE');
  });
});
