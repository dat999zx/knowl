import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { NormalizedHostHook } from '../../src/cli/agents/host-hook.js';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';
import { handleHostLifecycleEvent } from '../../src/session/host-lifecycle.js';
import * as repo from '../../src/store/repository.js';
import { conversationKey } from '../../src/store/capture-outcome.js';
import { MAX_LESSON_BLOCKS, openPendingLessons } from '../../src/store/pending-lessons.js';
import type { CaptureNudgeMode } from '../../src/store/capture-config.js';

/**
 * The pending-lesson gate, end to end through the hook path: a destructive command nudges
 * mid-turn, an unstored lesson withholds exactly one stop, a durable write settles it, and a
 * subagent stop is never withheld. Harness follows `capture-nudge-lifecycle.test.ts`,
 * including its one-root-per-test rule and its reason.
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

async function withRepo(mode: CaptureNudgeMode | undefined) {
  const root = path.resolve(`./.knowl-lesson-lifecycle-${nextRoot += 1}`);
  ROOTS.push(root);
  await closeDb();
  await releaseAll();
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG, ...(mode ? { capture: { events: mode } } : {}) });
  await initDb(root);
  const projectId = (await repo.createProject(root, 'lesson gate')).id;
  await handleHostLifecycleEvent(projectId, hook(root, { event: 'session-start' }));
  await handleHostLifecycleEvent(projectId, hook(root, { event: 'turn-start' }));
  return { root, projectId };
}

const command = (root: string, text: string, extra: Partial<NormalizedHostHook> = {}) =>
  hook(root, { event: 'session-event', type: 'command', payload: { command: text, exitCode: 0 }, ...extra });

const contextOf = (result: { hostOutput?: Record<string, unknown> } | undefined): string => {
  const specific = result?.hostOutput?.hookSpecificOutput as { additionalContext?: string } | undefined;
  return String(specific?.additionalContext ?? '');
};

describe('the pending-lesson gate, through the hook path', () => {
  beforeEach(async () => {
    await closeDb();
    await releaseAll();
  });

  afterAll(async () => {
    await closeDb();
    await releaseAll();
    for (const root of ROOTS) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('records nothing at all when the feature is off', async () => {
    const { root, projectId } = await withRepo(undefined);
    const result = await handleHostLifecycleEvent(projectId, command(root, 'pkill -f node'));
    expect(contextOf(result)).not.toContain('KNOWL LESSON');
    expect(await openPendingLessons(conversationKey(hook(root, {})))).toHaveLength(0);
  });

  it('in shadow: records the lesson, says nothing mid-turn, settles silently at stop', async () => {
    const { root, projectId } = await withRepo('shadow');
    const during = await handleHostLifecycleEvent(projectId, command(root, 'pkill -f node'));
    expect(contextOf(during)).not.toContain('KNOWL LESSON');
    expect(await openPendingLessons(conversationKey(hook(root, {})))).toHaveLength(1);

    const stop = await handleHostLifecycleEvent(projectId, hook(root, { event: 'turn-stop', status: 'finished' }));
    expect(stop.hostOutput).toBeUndefined();
    expect(await openPendingLessons(conversationKey(hook(root, {})))).toHaveLength(0);
  });

  it('in enforce: nudges mid-turn, blocks exactly one stop, then lets the next one pass', async () => {
    const { root, projectId } = await withRepo('enforce');

    const during = await handleHostLifecycleEvent(projectId, command(root, 'pkill -f node'));
    expect(contextOf(during)).toContain('KNOWL LESSON');
    expect(contextOf(during)).toContain('pkill -f node');

    const blocked = await handleHostLifecycleEvent(projectId, hook(root, { event: 'turn-stop', status: 'finished' }));
    expect(blocked.hostOutput).toMatchObject({ decision: 'block' });
    expect(String((blocked.hostOutput as { reason?: string }).reason)).toContain('Never invent an incident');

    await handleHostLifecycleEvent(projectId, hook(root, { event: 'turn-start' }));
    const clean = await handleHostLifecycleEvent(projectId, hook(root, { event: 'turn-stop', status: 'finished' }));
    expect(clean.hostOutput).toBeUndefined();
  });

  it('a durable write settles the lesson before the stop ever asks', async () => {
    const { root, projectId } = await withRepo('enforce');
    await handleHostLifecycleEvent(projectId, command(root, 'git reset --hard origin/main'));
    await new Promise(resolve => setTimeout(resolve, 5));
    await handleHostLifecycleEvent(projectId, command(root, 'stored the lesson', {
      knowlTool: true, knowlToolName: 'knowl_store',
      payload: { summary: 'knowl_store completed' }, type: 'checkpoint',
    }));

    const stop = await handleHostLifecycleEvent(projectId, hook(root, { event: 'turn-stop', status: 'finished' }));
    expect(stop.hostOutput).toBeUndefined();
  });

  it('the same class nudges once, and the block budget is a hard ceiling', async () => {
    const { root, projectId } = await withRepo('enforce');

    const first = await handleHostLifecycleEvent(projectId, command(root, 'pkill -f node'));
    const second = await handleHostLifecycleEvent(projectId, command(root, 'pkill -f vite'));
    expect(contextOf(first)).toContain('KNOWL LESSON');
    expect(contextOf(second)).not.toContain('KNOWL LESSON');

    // Distinct classes across turns, each blocked in turn; after the budget, silence.
    const classes = ['git reset --hard origin/main', 'git push --force origin main', 'psql -c "DROP TABLE t"', 'docker system prune -a'];
    let blocks = 0;
    // The pkill lesson from above is still open and rides the first block.
    for (const text of classes) {
      await handleHostLifecycleEvent(projectId, command(root, text));
      const stop = await handleHostLifecycleEvent(projectId, hook(root, { event: 'turn-stop', status: 'finished' }));
      if ((stop.hostOutput as { decision?: string } | undefined)?.decision === 'block') blocks += 1;
      await handleHostLifecycleEvent(projectId, hook(root, { event: 'turn-start' }));
    }
    expect(blocks).toBe(MAX_LESSON_BLOCKS);
  });

  it('a correction signal nudges at turn-start and arms the gate', async () => {
    const { root, projectId } = await withRepo('enforce');
    const start = await handleHostLifecycleEvent(projectId, hook(root, {
      event: 'turn-start', payload: { correctionSignal: true },
    }));
    expect(contextOf(start)).toContain('CORRECTION');
    expect((await openPendingLessons(conversationKey(hook(root, {})))).map(lesson => lesson.kind)).toContain('correction');
  });

  it('never withholds a subagent stop, whatever is pending', async () => {
    const { root, projectId } = await withRepo('enforce');
    await handleHostLifecycleEvent(projectId, command(root, 'pkill -f node'));
    const agentStop = await handleHostLifecycleEvent(projectId, hook(root, {
      event: 'agent-stop', agentId: 'sub-1',
    }));
    // The engine's own rule for agent-stop: it may not block a subagent from stopping, so it
    // emits no host output at all -- with or without this feature armed.
    expect(agentStop.hostOutput).toBeUndefined();
  });
});
