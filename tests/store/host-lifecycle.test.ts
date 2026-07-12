import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NormalizedHostHook } from '../../src/cli/agents/host-hook.js';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { handleHostLifecycleEvent } from '../../src/store/host-lifecycle.js';
import * as repo from '../../src/store/repository.js';

const ROOT = path.resolve('.knowl-host-lifecycle-test');

const hook = (input: Partial<NormalizedHostHook>): NormalizedHostHook => ({
  host: 'generic',
  event: 'turn-start',
  externalSessionId: 'external-session',
  externalTurnId: 'turn-1',
  projectRoot: ROOT,
  payload: {},
  ...input,
});

describe('host lifecycle orchestration', () => {
  let projectId = '';

  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'Host lifecycle')).id;
    await repo.createKnowledgeItem(projectId, {
      category: 'decision',
      title: 'Use local memory',
      content: 'Knowl stores project memory locally.',
    });
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('bootstraps bounded context at host session start', async () => {
    const result = await handleHostLifecycleEvent(projectId, hook({
      host: 'codex',
      event: 'session-start',
      externalSessionId: 'codex-session',
      externalTurnId: undefined,
      title: 'Agent session',
    }));

    expect(result).toMatchObject({ accepted: true, sessionId: expect.any(String) });
    expect(result.context).toContain('Use local memory');
    expect(result.context!.length).toBeLessThanOrEqual(3_000);
    expect(result.hostOutput).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: result.context,
      },
    });
  });

  it('delivers context once after SessionStart and not on later prompts or events', async () => {
    const sessionStart = await handleHostLifecycleEvent(projectId, hook({ host: 'codex', event: 'session-start', externalSessionId: 'one-shot', externalTurnId: undefined }));
    const firstPrompt = await handleHostLifecycleEvent(projectId, hook({ host: 'codex', event: 'turn-start', externalSessionId: 'one-shot', externalTurnId: 'prompt-1' }));
    const secondPrompt = await handleHostLifecycleEvent(projectId, hook({ host: 'codex', event: 'turn-start', externalSessionId: 'one-shot', externalTurnId: 'prompt-2' }));
    const checkpoint = await handleHostLifecycleEvent(projectId, hook({ host: 'codex', event: 'checkpoint', externalSessionId: 'one-shot', externalTurnId: 'prompt-2', type: 'checkpoint', payload: { summary: 'state' } }));

    expect(sessionStart.hostOutput?.hookSpecificOutput).toHaveProperty('additionalContext');
    expect(firstPrompt.hostOutput).toBeUndefined();
    expect(secondPrompt.hostOutput).toBeUndefined();
    expect(checkpoint).not.toHaveProperty('context');
  });

  it('captures a turn, finalizes candidates, and drops duplicate stops', async () => {
    const start = await handleHostLifecycleEvent(projectId, hook({ title: 'Agent turn' }));
    const event = await handleHostLifecycleEvent(projectId, hook({
      event: 'session-event',
      type: 'command',
      payload: { command: 'npm test', exitCode: 0, stdout: 'discard me' },
    }));
    const stop = await handleHostLifecycleEvent(projectId, hook({
      event: 'turn-stop',
      status: 'finished',
      payload: { status: 'finished' },
    }));
    const duplicate = await handleHostLifecycleEvent(projectId, hook({
      event: 'turn-stop',
      status: 'finished',
      payload: { status: 'finished' },
    }));

    expect(event.sessionId).toBe(start.sessionId);
    expect(stop).toMatchObject({ accepted: true, sessionId: start.sessionId, promotion: { candidateCount: 0 } });
    expect(duplicate).toEqual({ accepted: false, reason: 'event-loss' });
    const rows = await getClient().execute({ sql: 'SELECT payload FROM memory_session_events WHERE session_id = ? AND type = ?', args: [start.sessionId!, 'command'] });
    expect(String(rows.rows[0].payload)).not.toContain('discard me');
  });

  it('records bounded checkpoints before compaction', async () => {
    const start = await handleHostLifecycleEvent(projectId, hook({ externalTurnId: 'turn-2', title: 'Compaction turn' }));
    const checkpoint = await handleHostLifecycleEvent(projectId, hook({
      externalTurnId: 'turn-2',
      event: 'checkpoint',
      type: 'checkpoint',
      payload: { summary: 'Current task state', changedPaths: ['src/auth.ts'] },
    }));

    expect(checkpoint.sessionId).toBe(start.sessionId);
    const rows = await getClient().execute({ sql: 'SELECT payload FROM memory_session_events WHERE session_id = ? AND type = ?', args: [start.sessionId!, 'checkpoint'] });
    expect(JSON.parse(String(rows.rows[0].payload))).toEqual({ summary: 'Current task state', changedPaths: ['src/auth.ts'] });
  });

  it('delivers fallback context once across completed turns without SessionStart', async () => {
    const firstStart = await handleHostLifecycleEvent(projectId, hook({
      host: 'codex',
      externalSessionId: 'missing-session-start',
      externalTurnId: 'prompt-1',
    }));
    const firstStop = await handleHostLifecycleEvent(projectId, hook({
      host: 'codex',
      event: 'turn-stop',
      externalSessionId: 'missing-session-start',
      externalTurnId: 'prompt-1',
      status: 'finished',
      payload: { status: 'finished' },
    }));
    const secondStart = await handleHostLifecycleEvent(projectId, hook({
      host: 'codex',
      externalSessionId: 'missing-session-start',
      externalTurnId: 'prompt-2',
    }));

    expect(firstStart.hostOutput?.hookSpecificOutput).toHaveProperty('additionalContext');
    expect(firstStop.accepted).toBe(true);
    expect(secondStart.hostOutput).toBeUndefined();
    expect(secondStart.sessionId).not.toBe(firstStart.sessionId);
  });

  it('captures a Codex tool turn without UserPromptSubmit', async () => {
    const sessionStart = await handleHostLifecycleEvent(projectId, hook({
      host: 'codex', event: 'session-start', externalSessionId: 'tool-only-session', externalTurnId: undefined,
    }));
    const event = await handleHostLifecycleEvent(projectId, hook({
      host: 'codex', event: 'session-event', externalSessionId: 'tool-only-session', externalTurnId: 'tool-turn',
      type: 'command', payload: { command: 'npm test', exitCode: 0 },
    }));
    const stop = await handleHostLifecycleEvent(projectId, hook({
      host: 'codex', event: 'turn-stop', externalSessionId: 'tool-only-session', externalTurnId: 'tool-turn',
      status: 'finished', payload: { status: 'finished' },
    }));

    expect(sessionStart.hostOutput?.hookSpecificOutput).toHaveProperty('additionalContext');
    expect(event.accepted).toBe(true);
    expect(stop.accepted).toBe(true);
  });

  it('does not inject fallback context from a tool event when SessionStart is missing', async () => {
    const event = await handleHostLifecycleEvent(projectId, hook({
      host: 'codex', event: 'session-event', externalSessionId: 'missing-bootstrap', externalTurnId: 'tool-turn',
      type: 'command', payload: { command: 'npm test', exitCode: 0 },
    }));
    const stop = await handleHostLifecycleEvent(projectId, hook({
      host: 'codex', event: 'turn-stop', externalSessionId: 'missing-bootstrap', externalTurnId: 'tool-turn',
      status: 'finished', payload: { status: 'finished' },
    }));

    expect(event).toEqual({ accepted: true, sessionId: expect.any(String) });
    expect(stop.accepted).toBe(true);
  });

  it('stores a Claude rate-limit handoff and injects it first on the next SessionStart', async () => {
    const sessionStart = await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'session-start',
      externalSessionId: 'claude-rate-limit',
      externalTurnId: undefined,
      title: 'Agent session',
    }));
    const checkpoint = await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'checkpoint',
      externalSessionId: 'claude-rate-limit',
      externalTurnId: 'turn-rate',
      type: 'checkpoint',
      payload: { summary: 'Human review gate active', changedPaths: ['src/forge.ts'] },
    }));
    const failedStop = await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'turn-stop',
      externalSessionId: 'claude-rate-limit',
      externalTurnId: 'turn-rate',
      status: 'failed',
      payload: { status: 'failed', error: 'rate_limit', message: 'Claude session limit hit' },
    }));

    expect(sessionStart.accepted).toBe(true);
    expect(checkpoint.accepted).toBe(true);
    expect(failedStop.accepted).toBe(true);
    expect(failedStop.handoff?.handoff.kind).toBe('rate_limit');
    expect(failedStop.handoff?.handoff.lastCheckpoint).toBe('Human review gate active');

    const nextStart = await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'session-start',
      externalSessionId: 'claude-resume',
      externalTurnId: undefined,
      title: 'Agent session',
    }));
    const secondStart = await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'session-start',
      externalSessionId: 'claude-resume-2',
      externalTurnId: undefined,
      title: 'Agent session',
    }));

    expect(String(nextStart.context)).toContain('PENDING SESSION HANDOFF');
    expect(String(nextStart.context)).toContain('rate_limit');
    expect(String(nextStart.context)).toContain('Human review gate active');
    expect(String(nextStart.context)).toContain('Use local memory');
    expect(String(secondStart.context)).not.toContain('PENDING SESSION HANDOFF');
  });

  it('records lower-urgency handoffs for non-limit StopFailure events', async () => {
    await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'session-start',
      externalSessionId: 'claude-generic-fail',
      externalTurnId: undefined,
    }));
    const failedStop = await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'turn-stop',
      externalSessionId: 'claude-generic-fail',
      externalTurnId: 'turn-fail',
      status: 'failed',
      payload: { status: 'failed', error: 'model_error', message: 'provider blew up' },
    }));

    expect(failedStop.handoff?.handoff.kind).toBe('failed');
    expect(failedStop.handoff?.handoff.urgency).toBe('high');
  });
});
