import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import {
  consumePendingSessionHandoff,
  formatPendingHandoffContext,
  recordDeliberateHandoff,
  recordPendingSessionHandoff,
} from '../../src/store/session-handoff.js';

const TEST_ROOT = path.resolve('./.knowl-deliberate-handoff-test');
const HOST = 'claude';

describe('deliberate session handoff', () => {
  let projectId: string;

  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
    projectId = (await repo.createProject(TEST_ROOT, 'Deliberate handoff test')).id;
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  const park = (goal: string, sessionId: string, extra: Record<string, unknown> = {}) =>
    recordDeliberateHandoff(projectId, {
      host: HOST,
      projectRoot: TEST_ROOT,
      externalSessionId: sessionId,
      taskState: { goal, nextAction: 'continue where the last session stopped', ...extra },
    });

  it('parks a baton and delivers it exactly once to the next session', async () => {
    await park('finish the trial screen meta band', 'session-a', {
      completed: ['band contrast fixed'],
      blocker: 'fork stage still unskinned',
      verificationStatus: 'typecheck clean, not run in the browser',
    });

    const first = await consumePendingSessionHandoff(projectId, HOST);
    expect(first).not.toBeNull();
    expect(first!.handoff.kind).toBe('handoff');
    expect(first!.handoff.taskState?.goal).toContain('meta band');
    expect(first!.handoff.taskState?.blocker).toContain('fork stage');

    // One-shot: the baton is spent, so a second session must not receive it.
    expect(await consumePendingSessionHandoff(projectId, HOST)).toBeNull();
  });

  it('reads as a planned handoff, not as a crash', async () => {
    await park('ship the embedding upgrade', 'session-b');
    const consumed = await consumePendingSessionHandoff(projectId, HOST);
    const context = formatPendingHandoffContext(consumed!.handoff);

    // A parked baton and a 3am crash deserve opposite openings.
    expect(context).toContain('parked this work for you on purpose');
    expect(context).toContain('Parked at:');
    expect(context).not.toContain('ended before a clean finish');
    expect(context).not.toContain('Failed at:');
  });

  it('keeps the crash path reading as a failure', async () => {
    const recorded = await recordPendingSessionHandoff(projectId, {
      host: HOST,
      projectRoot: TEST_ROOT,
      externalSessionId: 'session-crash',
      status: 'failed',
      payload: { error: { code: 'rate_limit' } },
    } as any);
    expect(recorded).not.toBeNull();

    const context = formatPendingHandoffContext(recorded!.handoff);
    expect(context).toContain('ended before a clean finish');
    expect(context).not.toContain('parked this work for you on purpose');
    await consumePendingSessionHandoff(projectId, HOST);
  });

  it('holds one baton per project — parking again replaces the previous one', async () => {
    await park('first workstream', 'session-c');
    await park('second workstream', 'session-d');

    const consumed = await consumePendingSessionHandoff(projectId, HOST);
    expect(consumed!.handoff.taskState?.goal).toBe('second workstream');
    expect(consumed!.handoff.externalSessionId).toBe('session-d');
    // Only one slot existed, so nothing else is waiting behind it.
    expect(await consumePendingSessionHandoff(projectId, HOST)).toBeNull();
  });

  it('a deliberate baton supersedes a stale crash handoff rather than queueing behind it', async () => {
    await recordPendingSessionHandoff(projectId, {
      host: HOST,
      projectRoot: TEST_ROOT,
      externalSessionId: 'session-old-crash',
      status: 'failed',
      payload: { error: { code: 'rate_limit' } },
    } as any);

    await park('deliberate work that matters now', 'session-e');

    const consumed = await consumePendingSessionHandoff(projectId, HOST);
    expect(consumed!.handoff.kind).toBe('handoff');
    expect(consumed!.handoff.taskState?.goal).toBe('deliberate work that matters now');
  });

  it('carries artifact references through the round trip', async () => {
    await park('land PR 7', 'session-f', {
      artifactRefs: ['https://github.com/dat999zx/knowl/pull/7', 'src/store/transcript-index.ts'],
    });
    const consumed = await consumePendingSessionHandoff(projectId, HOST);
    expect(consumed!.handoff.taskState?.artifactRefs).toContain('src/store/transcript-index.ts');
    expect(formatPendingHandoffContext(consumed!.handoff)).toContain('pull/7');
  });
});
