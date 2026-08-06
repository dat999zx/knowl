import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NormalizedHostHook } from '../../src/cli/agents/host-hook.js';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import {
  consumePendingSessionHandoff,
  formatPendingHandoffContext,
  HANDOFF_URGENCY,
  recordDeliberateHandoff,
  recordPendingSessionHandoff,
  SESSION_HANDOFF_KINDS,
} from '../../src/session/session-handoff.js';
import type { PendingHandoff } from '../../src/session/session-handoff.js';

describe('handoff kind inventory', () => {
  it('is a single list the type, the writer and the parser all derive from', () => {
    expect([...SESSION_HANDOFF_KINDS]).toEqual([
      'handoff', 'rate_limit', 'auth', 'provider_outage', 'interrupted', 'failed',
    ]);
  });

  it('includes the deliberate kind, which the crash kinds do not cover', () => {
    expect(SESSION_HANDOFF_KINDS).toContain('handoff');
  });
});

const baseHandoff = (over: Partial<PendingHandoff> = {}): PendingHandoff => ({
  kind: 'handoff',
  urgency: HANDOFF_URGENCY,
  host: 'claude',
  projectRoot: '/repo/knowl',
  externalSessionId: 'session-abc',
  failedAt: '2026-08-03T10:00:00.000Z',
  consumed: false,
  taskState: { goal: 'Ship the parser', nextAction: 'Wire the CLI flag' },
  ...over,
} as PendingHandoff);

describe('handoff context reads by kind', () => {
  it('opens a planned baton as parked work, not as damage', () => {
    const text = formatPendingHandoffContext(baseHandoff());

    expect(text).toContain('SESSION HANDOFF');
    expect(text).toMatch(/parked this work for you on purpose/i);
    expect(text).toMatch(/Parked at:/);
    expect(text).not.toMatch(/ended before a clean finish/i);
    expect(text).not.toMatch(/Failed at:/);
  });

  it('keeps the crash opening for a crash', () => {
    const text = formatPendingHandoffContext(baseHandoff({
      kind: 'rate_limit',
      urgency: 'critical',
    }));

    expect(text).toMatch(/ended before a clean finish/i);
    expect(text).toMatch(/Failed at:/);
    expect(text).not.toMatch(/on purpose/i);
  });

  it('carries the task state either way', () => {
    for (const kind of ['handoff', 'interrupted'] as const) {
      const text = formatPendingHandoffContext(baseHandoff({ kind } as Partial<PendingHandoff>));
      expect(text).toContain('Ship the parser');
      expect(text).toContain('Wire the CLI flag');
    }
  });
});

const TEST_ROOT = path.resolve('.knowl-deliberate-handoff-test');

describe('recordDeliberateHandoff', () => {
  let projectId = '';

  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
    projectId = (await repo.createProject(TEST_ROOT, 'Deliberate handoff')).id;
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  const park = (externalSessionId: string, taskState: PendingHandoff['taskState']) =>
    recordDeliberateHandoff(projectId, {
      host: 'claude',
      projectRoot: TEST_ROOT,
      externalSessionId,
      taskState: taskState ?? {},
    });

  it('parks a baton and delivers it exactly once', async () => {
    await park('session-one', { goal: 'Ship the parser', nextAction: 'Wire the CLI flag' });

    const first = await consumePendingSessionHandoff(projectId, 'claude');
    expect(first?.handoff.kind).toBe('handoff');
    expect(first?.handoff.urgency).toBe(HANDOFF_URGENCY);
    expect(first?.handoff.taskState?.goal).toBe('Ship the parser');
    expect(first?.context).toMatch(/parked this work for you on purpose/i);

    // One-shot: the next session gets nothing.
    expect(await consumePendingSessionHandoff(projectId, 'claude')).toBeNull();
  });

  it('holds one baton per project - parking again replaces the previous one', async () => {
    await park('session-one', { goal: 'First goal', nextAction: 'First action' });
    await park('session-one', { goal: 'Second goal' });

    const received = await consumePendingSessionHandoff(projectId, 'claude');
    expect(received?.handoff.taskState?.goal).toBe('Second goal');
    // Replaced, not merged: the previous baton's fields do not bleed into the new one.
    expect(received?.handoff.taskState?.nextAction).toBeUndefined();

    expect(await consumePendingSessionHandoff(projectId, 'claude')).toBeNull();
  });

  it('supersedes a stale crash handoff rather than queueing behind it', async () => {
    await recordPendingSessionHandoff(projectId, {
      host: 'claude',
      event: 'turn-stop',
      externalSessionId: 'session-crashed',
      externalTurnId: 'turn-1',
      projectRoot: TEST_ROOT,
      status: 'failed',
      payload: { status: 'failed', code: 'aborted' },
    } as NormalizedHostHook);

    await park('session-one', { goal: 'Deliberate goal' });

    const received = await consumePendingSessionHandoff(projectId, 'claude');
    expect(received?.handoff.kind).toBe('handoff');
    expect(received?.handoff.taskState?.goal).toBe('Deliberate goal');

    expect(await consumePendingSessionHandoff(projectId, 'claude')).toBeNull();
  });

  it('carries artifact references through the round trip', async () => {
    await park('session-one', {
      goal: 'Ship the parser',
      artifactRefs: ['src/parser.ts', 'docs/parser.md'],
      verificationStatus: 'unverified',
    });

    const received = await consumePendingSessionHandoff(projectId, 'claude');
    expect(received?.handoff.taskState?.artifactRefs).toEqual(['src/parser.ts', 'docs/parser.md']);
    expect(received?.handoff.taskState?.verificationStatus).toBe('unverified');
  });
});
