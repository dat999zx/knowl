import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NormalizedHostHook } from '../../src/cli/agents/host-hook.js';
import { KNOWL_CLAUDE_CONTINUATION_REMINDER } from '../../src/core/knowl-guidance.js';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { readCommitHead } from '../../src/store/change-watermark.js';
import { handleHostLifecycleEvent } from '../../src/session/host-lifecycle.js';
import {
  bindHostSession,
  closeHostSessionBinding,
  findHostSession,
  HostSessionKey,
  incrementHostSuccessfulToolCount,
  readHostSeenCommit,
  setHostSeenCommit,
} from '../../src/session/host-session-bindings.js';
import * as repo from '../../src/store/repository.js';
import { recordPendingSessionHandoff } from '../../src/session/session-handoff.js';
import { startMemorySession } from '../../src/store/session-repository.js';

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

  it('counts successful tools per active turn binding and resets on rebind', async () => {
    const key: HostSessionKey = {
      host: 'claude',
      projectRoot: ROOT,
      externalSessionId: 'counter-session',
      externalTurnId: '__turn__',
    };
    const first = await startMemorySession({ title: 'First counter turn', agent: 'claude' });
    await bindHostSession(key, first.id);

    expect(await incrementHostSuccessfulToolCount(key)).toBe(1);
    expect(await incrementHostSuccessfulToolCount(key)).toBe(2);

    await closeHostSessionBinding(key);
    const second = await startMemorySession({ title: 'Second counter turn', agent: 'claude' });
    await bindHostSession(key, second.id);
    expect(await incrementHostSuccessfulToolCount(key)).toBe(1);
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
      payload: {
        summary: 'Current task state',
        changedPaths: ['src/auth.ts'],
        goal: 'Ship resumable handoffs',
        completed: ['Added the regression case'],
        nextAction: 'Implement the checkpoint contract',
        blocker: 'None',
        artifactRefs: ['tests/store/host-lifecycle.test.ts'],
        verificationStatus: 'unverified',
      },
    }));

    expect(checkpoint.sessionId).toBe(start.sessionId);
    const rows = await getClient().execute({ sql: 'SELECT payload FROM memory_session_events WHERE session_id = ? AND type = ?', args: [start.sessionId!, 'checkpoint'] });
    expect(JSON.parse(String(rows.rows[0].payload))).toEqual({
      summary: 'Current task state',
      changedPaths: ['src/auth.ts'],
      goal: 'Ship resumable handoffs',
      completed: ['Added the regression case'],
      nextAction: 'Implement the checkpoint contract',
      blocker: 'None',
      artifactRefs: ['tests/store/host-lifecycle.test.ts'],
      verificationStatus: 'unverified',
    });
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

  it('debounces exact duplicate capture events within the window', async () => {
    const first = await handleHostLifecycleEvent(projectId, hook({
      host: 'codex',
      event: 'session-event',
      externalSessionId: 'debounce-session',
      externalTurnId: 'debounce-turn',
      type: 'command',
      payload: { command: 'npm test', exitCode: 0 },
    }));
    const second = await handleHostLifecycleEvent(projectId, hook({
      host: 'codex',
      event: 'session-event',
      externalSessionId: 'debounce-session',
      externalTurnId: 'debounce-turn',
      type: 'command',
      payload: { command: 'npm test', exitCode: 0 },
    }));
    const distinct = await handleHostLifecycleEvent(projectId, hook({
      host: 'codex',
      event: 'session-event',
      externalSessionId: 'debounce-session',
      externalTurnId: 'debounce-turn',
      type: 'command',
      payload: { command: 'npm run build', exitCode: 0 },
    }));
    const failure = await handleHostLifecycleEvent(projectId, hook({
      host: 'codex',
      event: 'session-event',
      externalSessionId: 'debounce-session',
      externalTurnId: 'debounce-turn',
      type: 'error',
      status: 'failed',
      payload: { message: 'tool failed' },
    }));
    const stop = await handleHostLifecycleEvent(projectId, hook({
      host: 'codex',
      event: 'turn-stop',
      externalSessionId: 'debounce-session',
      externalTurnId: 'debounce-turn',
      status: 'finished',
      payload: { status: 'finished' },
    }));

    expect(first).toMatchObject({ accepted: true, sessionId: expect.any(String) });
    expect(second).toEqual({ accepted: true, reason: 'debounced', sessionId: first.sessionId });
    expect(distinct.accepted).toBe(true);
    expect(failure.accepted).toBe(true);
    expect(stop.accepted).toBe(true);

    const commandRows = await getClient().execute({
      sql: 'SELECT payload FROM memory_session_events WHERE session_id = ? AND type = ? ORDER BY observed_at ASC',
      args: [first.sessionId!, 'command'],
    });
    expect(commandRows.rows).toHaveLength(2);
    expect(String(commandRows.rows[0].payload)).toContain('npm test');
    expect(String(commandRows.rows[1].payload)).toContain('npm run build');

    const errorRows = await getClient().execute({
      sql: 'SELECT payload FROM memory_session_events WHERE session_id = ? AND type = ?',
      args: [first.sessionId!, 'error'],
    });
    expect(errorRows.rows).toHaveLength(1);
  });

  it('debounces exact duplicate checkpoint captures within the window', async () => {
    const first = await handleHostLifecycleEvent(projectId, hook({
      host: 'codex',
      event: 'checkpoint',
      externalSessionId: 'debounce-checkpoint-session',
      externalTurnId: 'debounce-checkpoint-turn',
      type: 'checkpoint',
      payload: { summary: 'state', changedPaths: ['src/a.ts', 'src/b.ts'] },
    }));
    const second = await handleHostLifecycleEvent(projectId, hook({
      host: 'codex',
      event: 'checkpoint',
      externalSessionId: 'debounce-checkpoint-session',
      externalTurnId: 'debounce-checkpoint-turn',
      type: 'checkpoint',
      payload: { summary: 'state', changedPaths: ['src/b.ts', 'src/a.ts'] },
    }));

    expect(first.accepted).toBe(true);
    expect(second).toEqual({ accepted: true, reason: 'debounced', sessionId: first.sessionId });

    const rows = await getClient().execute({
      sql: 'SELECT payload FROM memory_session_events WHERE session_id = ? AND type = ?',
      args: [first.sessionId!, 'checkpoint'],
    });
    expect(rows.rows).toHaveLength(1);
  });

  it('reminds Claude after 12 consecutive non-Knowl tool events and resets on a Knowl tool', async () => {
    const drift = (command: string) => hook({
      host: 'claude', event: 'session-event', externalSessionId: 'claude-long-turn', externalTurnId: undefined,
      type: 'command', payload: { command, exitCode: 0 },
    });
    const results = [];
    for (let index = 1; index <= 13; index++) {
      results.push(await handleHostLifecycleEvent(projectId, drift(`tool-${index}`)));
    }

    expect(results.slice(0, 11).every(result => result.hostOutput === undefined)).toBe(true);
    expect(results[11].hostOutput).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: KNOWL_CLAUDE_CONTINUATION_REMINDER,
      },
    });
    expect(results[12].hostOutput).toBeUndefined();

    // Using a Knowl tool resets the drift counter, so the next 11 non-Knowl calls stay quiet.
    await handleHostLifecycleEvent(projectId, hook({
      host: 'claude', event: 'session-event', externalSessionId: 'claude-long-turn', externalTurnId: undefined,
      type: 'checkpoint', payload: { summary: 'mcp__knowl__knowl_query completed' }, knowlTool: true,
    }));
    const afterReset = [];
    for (let index = 1; index <= 11; index++) {
      afterReset.push(await handleHostLifecycleEvent(projectId, drift(`post-reset-${index}`)));
    }
    expect(afterReset.every(result => result.hostOutput === undefined)).toBe(true);
  });

  it('does not count duplicate or failed Claude tool events toward the reminder', async () => {
    const base = {
      host: 'claude' as const,
      event: 'session-event' as const,
      externalSessionId: 'claude-filtered-turn',
      externalTurnId: undefined,
    };
    const first = await handleHostLifecycleEvent(projectId, hook({
      ...base,
      type: 'command',
      payload: { command: 'same-tool', exitCode: 0 },
    }));
    const duplicate = await handleHostLifecycleEvent(projectId, hook({
      ...base,
      type: 'command',
      payload: { command: 'same-tool', exitCode: 0 },
    }));
    const failure = await handleHostLifecycleEvent(projectId, hook({
      ...base,
      type: 'error',
      status: 'failed',
      payload: { message: 'tool failed' },
    }));
    const following = [];
    for (let index = 2; index <= 12; index++) {
      following.push(await handleHostLifecycleEvent(projectId, hook({
        ...base,
        type: 'command',
        payload: { command: `filtered-tool-${index}`, exitCode: 0 },
      })));
    }

    expect(first.hostOutput).toBeUndefined();
    expect(duplicate.reason).toBe('debounced');
    expect(failure.hostOutput).toBeUndefined();
    expect(following.slice(0, 10).every(result => result.hostOutput === undefined)).toBe(true);
    expect(following[10].hostOutput).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: KNOWL_CLAUDE_CONTINUATION_REMINDER,
      },
    });
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

  it('stores a host-scoped hard-stop handoff and injects it first on the next matching SessionStart', async () => {
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
      payload: {
        summary: 'Human review gate active',
        changedPaths: ['src/forge.ts'],
        goal: 'Ship resumable handoffs',
        completed: ['Captured a structured checkpoint', 'Ran focused tests'],
        nextAction: 'Persist the pending handoff',
        blocker: 'Rate limit',
        artifactRefs: ['src/store/session-handoff.ts', 'tests/store/host-lifecycle.test.ts'],
        verificationStatus: 'needs-review',
      },
    }));
    const failedStop = await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'turn-stop',
      externalSessionId: 'claude-rate-limit',
      externalTurnId: 'turn-rate',
      status: 'failed',
      payload: {
        status: 'failed',
        error: 'rate_limit',
        message: 'Claude session limit hit',
        nextAction: 'Resume after the rate limit resets',
        verificationStatus: 'blocked',
      },
    }));

    expect(sessionStart.accepted).toBe(true);
    expect(checkpoint.accepted).toBe(true);
    expect(failedStop.accepted).toBe(true);
    expect(failedStop.handoff?.handoff.kind).toBe('rate_limit');
    expect(failedStop.handoff?.handoff.lastCheckpoint).toBe('Human review gate active');
    expect(failedStop.handoff?.handoff.taskState).toEqual({
      goal: 'Ship resumable handoffs',
      completed: ['Captured a structured checkpoint', 'Ran focused tests'],
      nextAction: 'Resume after the rate limit resets',
      blocker: 'Rate limit',
      artifactRefs: ['src/store/session-handoff.ts', 'tests/store/host-lifecycle.test.ts'],
      verificationStatus: 'blocked',
    });
    expect(failedStop.promotion).toBeDefined();

    const sessionRows = await getClient().execute({
      sql: 'SELECT status FROM memory_sessions WHERE id = ?',
      args: [failedStop.sessionId!],
    });
    expect(String(sessionRows.rows[0].status)).toBe('failed');

    const codexStart = await handleHostLifecycleEvent(projectId, hook({
      host: 'codex',
      event: 'session-start',
      externalSessionId: 'codex-other',
      externalTurnId: undefined,
    }));
    expect(String(codexStart.context)).not.toContain('PENDING SESSION HANDOFF');

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
    expect(String(nextStart.context)).toContain('Ship resumable handoffs');
    expect(String(nextStart.context)).toContain('Resume after the rate limit resets');
    expect(String(nextStart.context)).toContain('Rate limit');
    expect(String(nextStart.context)).toContain('src/store/session-handoff.ts');
    expect(String(nextStart.context)).toContain('blocked');
    expect(String(nextStart.context)).toContain('Use local memory');
    expect(String(secondStart.context)).not.toContain('PENDING SESSION HANDOFF');
  });

  it('updates one host-scoped handoff record for repeated failures instead of creating duplicates', async () => {
    await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'session-start',
      externalSessionId: 'claude-dedupe-session',
      externalTurnId: undefined,
    }));
    await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'checkpoint',
      externalSessionId: 'claude-dedupe-session',
      externalTurnId: 'turn-1',
      type: 'checkpoint',
      payload: {
        summary: 'First checkpoint',
        goal: 'Keep one handoff',
        completed: ['Recorded first failure path'],
        nextAction: 'Retry after rate limit',
        blocker: 'Rate limit',
        artifactRefs: ['src/store/session-handoff.ts'],
        verificationStatus: 'unverified',
      },
    }));
    const firstFail = await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'turn-stop',
      externalSessionId: 'claude-dedupe-session',
      externalTurnId: 'turn-1',
      status: 'failed',
      payload: { status: 'failed', error: 'rate_limit', message: 'limit hit' },
    }));
    const secondFail = await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'turn-stop',
      externalSessionId: 'claude-dedupe-session',
      externalTurnId: 'turn-1',
      status: 'failed',
      payload: { status: 'failed', error: 'rate_limit', message: 'limit hit again' },
    }));

    expect(firstFail.handoff?.itemId).toBeTruthy();
    expect(secondFail.handoff?.itemId).toBe(firstFail.handoff?.itemId);

    const active = await getClient().execute({
      sql: "SELECT id, content, conflict_scope, tags FROM knowledge_items WHERE title = 'Pending session handoff' AND status = 'active'",
    });
    expect(active.rows).toHaveLength(1);
    const handoff = JSON.parse(String(active.rows[0].content));
    expect(handoff.externalSessionId).toBe('claude-dedupe-session');
    expect(handoff.taskState.verificationStatus).toBe('unverified');
    expect(String(active.rows[0].tags)).toContain('session:claude-dedupe-session');
    expect(JSON.parse(String(active.rows[0].conflict_scope))).toEqual({
      host: 'claude',
      externalSessionId: 'claude-dedupe-session',
    });
  });

  it('uses task state attached to a hard-stop failure without a checkpoint', async () => {
    await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'session-start',
      externalSessionId: 'claude-failure-state',
      externalTurnId: undefined,
    }));
    const failedStop = await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'turn-stop',
      externalSessionId: 'claude-failure-state',
      externalTurnId: 'turn-failure-state',
      status: 'failed',
      payload: {
        status: 'failed',
        error: 'rate_limit',
        message: 'Claude session limit hit',
        goal: 'Ship resumable handoffs',
        completed: ['Captured the failure state'],
        nextAction: 'Resume after the limit resets',
        blocker: 'Rate limit',
        artifactRefs: ['src/store/session-handoff.ts'],
        verificationStatus: 'blocked',
      },
    }));

    expect(failedStop.handoff?.handoff.taskState).toEqual({
      goal: 'Ship resumable handoffs',
      completed: ['Captured the failure state'],
      nextAction: 'Resume after the limit resets',
      blocker: 'Rate limit',
      artifactRefs: ['src/store/session-handoff.ts'],
      verificationStatus: 'blocked',
    });

    const resume = await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'session-start',
      externalSessionId: 'claude-failure-resume',
      externalTurnId: undefined,
    }));
    expect(String(resume.context)).toContain('Captured the failure state');
    expect(String(resume.context)).toContain('Resume after the limit resets');
  });

  it('replaces stale handoff state when a newer external session fails', async () => {
    await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'session-start',
      externalSessionId: 'claude-old-session',
      externalTurnId: undefined,
    }));
    await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'checkpoint',
      externalSessionId: 'claude-old-session',
      externalTurnId: 'turn-old',
      type: 'checkpoint',
      payload: {
        summary: 'Old checkpoint',
        changedPaths: ['src/old.ts'],
        goal: 'Old goal',
        nextAction: 'Old action',
      },
    }));
    const firstFail = await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'turn-stop',
      externalSessionId: 'claude-old-session',
      externalTurnId: 'turn-old',
      status: 'failed',
      payload: { status: 'failed', error: 'rate_limit', message: 'Old session limit hit' },
    }));
    const secondFail = await recordPendingSessionHandoff(projectId, hook({
      host: 'claude',
      event: 'turn-stop',
      externalSessionId: 'claude-new-session',
      externalTurnId: 'turn-new',
      status: 'failed',
      payload: { status: 'failed', error: 'model_error', message: 'New session failed' },
    }));

    expect(secondFail?.itemId).toBe(firstFail.handoff?.itemId);
    expect(secondFail?.handoff.externalSessionId).toBe('claude-new-session');
    expect(secondFail?.handoff.memorySessionId).toBeUndefined();
    expect(secondFail?.handoff.lastCheckpoint).toBeUndefined();
    expect(secondFail?.handoff.changedPaths).toBeUndefined();
    expect(secondFail?.handoff.taskState).toBeUndefined();

    const active = await getClient().execute({
      sql: 'SELECT content, conflict_scope FROM knowledge_items WHERE id = ?',
      args: [secondFail!.itemId],
    });
    expect(active.rows).toHaveLength(1);
    const handoff = JSON.parse(String(active.rows[0].content));
    expect(handoff.externalSessionId).toBe('claude-new-session');
    expect(handoff.lastCheckpoint).toBeUndefined();
    expect(handoff.taskState).toBeUndefined();
    expect(JSON.parse(String(active.rows[0].conflict_scope))).toEqual({
      host: 'claude',
      externalSessionId: 'claude-new-session',
    });
  });

  it('records host-neutral hard-stop handoffs for Codex and Cursor failures', async () => {
    await handleHostLifecycleEvent(projectId, hook({
      host: 'codex',
      event: 'session-start',
      externalSessionId: 'codex-fail',
      externalTurnId: undefined,
    }));
    const codexFail = await handleHostLifecycleEvent(projectId, hook({
      host: 'codex',
      event: 'turn-stop',
      externalSessionId: 'codex-fail',
      externalTurnId: 'turn-fail',
      status: 'failed',
      payload: { status: 'failed', error: 'model_error', message: 'provider blew up' },
    }));
    expect(codexFail.handoff?.handoff.kind).toBe('failed');
    expect(codexFail.handoff?.handoff.urgency).toBe('high');
    expect(codexFail.promotion).toBeDefined();

    await handleHostLifecycleEvent(projectId, hook({
      host: 'cursor',
      event: 'session-start',
      externalSessionId: 'cursor-auth',
      externalTurnId: undefined,
    }));
    const cursorFail = await handleHostLifecycleEvent(projectId, hook({
      host: 'cursor',
      event: 'turn-stop',
      externalSessionId: 'cursor-auth',
      externalTurnId: 'turn-auth',
      status: 'failed',
      payload: { status: 'failed', code: '401', message: 'unauthorized' },
    }));
    expect(cursorFail.handoff?.handoff.kind).toBe('auth');

    const cursorResume = await handleHostLifecycleEvent(projectId, hook({
      host: 'cursor',
      event: 'session-start',
      externalSessionId: 'cursor-resume',
      externalTurnId: undefined,
    }));
    expect(cursorResume.hostOutput).toMatchObject({
      additional_context: expect.stringContaining('PENDING SESSION HANDOFF'),
      sessionStart: true,
    });
    expect(String(cursorResume.context)).toContain('auth');
  });

  it('does not create handoffs for successful stops', async () => {
    await handleHostLifecycleEvent(projectId, hook({
      host: 'generic',
      event: 'session-start',
      externalSessionId: 'generic-ok',
      externalTurnId: undefined,
    }));
    const stop = await handleHostLifecycleEvent(projectId, hook({
      host: 'generic',
      event: 'turn-stop',
      externalSessionId: 'generic-ok',
      externalTurnId: 'turn-ok',
      status: 'finished',
      payload: { status: 'finished' },
    }));
    expect(stop.handoff).toBeFalsy();
  });

  it('binds a subagent to the parent memory session and returns SubagentStart context', async () => {
    const parent = await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'session-start',
      externalSessionId: 'subagent-parent',
      externalTurnId: undefined,
      title: 'Agent session',
    }));

    const child = await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'agent-start',
      externalSessionId: 'subagent-parent',
      externalTurnId: undefined,
      agentId: 'agent-alpha',
      agentType: 'Explore',
      title: 'Agent session (Explore)',
    }));

    expect(child.accepted).toBe(true);
    expect(child.sessionId).toBe(parent.sessionId);
    expect(child.hostOutput).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SubagentStart',
        additionalContext: child.context,
      },
    });
    expect(child.context).toContain('KNOWL - RECENT SESSION CONTEXT');
    // Subagent bootstrap is capped at half DEFAULT_CONTEXT_MAX_CHARS (3000) because
    // fan-out multiplies whatever a subagent costs.
    expect(child.context!.length).toBeLessThanOrEqual(1_500);
  });

  it('carries the operational guidance card in subagent bootstrap', async () => {
    await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'session-start',
      externalSessionId: 'subagent-card',
      externalTurnId: undefined,
      title: 'Agent session',
    }));

    const child = await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'agent-start',
      externalSessionId: 'subagent-card',
      externalTurnId: undefined,
      agentId: 'agent-card',
      agentType: 'Explore',
    }));

    // Subagents receive no prompt event, so the prompt-time reminder never reaches
    // them, and a live probe confirmed MCP server instructions do not either. Without
    // the card riding along with the bootstrap a subagent gets data and no reason to
    // use it, which silently disables the workflow for every subagent.
    expect(child.context).toContain('KNOWL');
    expect(child.context).toContain('knowl_query');
    expect(child.context).toContain('knowl_store');
    // Guidance precedes data, and must survive the halved cap rather than being
    // truncated away with the tail of the recent-context block.
    expect(child.context!.indexOf('knowl_query'))
      .toBeLessThan(child.context!.indexOf('KNOWL - RECENT SESSION CONTEXT'));
    expect(child.context!.length).toBeLessThanOrEqual(1_500);
  });

  it('returns the guidance card even when the project has no recent context', async () => {
    const bare = await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'agent-start',
      externalSessionId: 'subagent-card-bare',
      externalTurnId: undefined,
      agentId: 'agent-card-bare',
      agentType: 'Explore',
    }));

    expect(bare.accepted).toBe(true);
    expect(bare.context).toContain('knowl_query');
  });

  it('routes subagent tool events to an agent-scoped binding, isolated from the parent', async () => {
    await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'session-start',
      externalSessionId: 'sibling-session',
      externalTurnId: undefined,
      title: 'Agent session',
    }));

    const agentKey: HostSessionKey = {
      host: 'claude',
      projectRoot: ROOT,
      externalSessionId: 'sibling-session',
      externalTurnId: '__agent__:agent-beta',
    };
    const parentTurnKey: HostSessionKey = { ...agentKey, externalTurnId: '__turn__' };

    await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'session-event',
      type: 'checkpoint',
      externalSessionId: 'sibling-session',
      externalTurnId: undefined,
      agentId: 'agent-beta',
      agentType: 'Explore',
      payload: { summary: 'Grep completed' },
    }));

    expect(await findHostSession(agentKey)).not.toBeNull();
    expect(await findHostSession(parentTurnKey)).toBeNull();
  });

  it('closes only the subagent binding on agent-stop', async () => {
    const agentKey: HostSessionKey = {
      host: 'claude',
      projectRoot: ROOT,
      externalSessionId: 'agent-stop-session',
      externalTurnId: '__agent__:agent-gamma',
    };
    const sessionKey: HostSessionKey = { ...agentKey, externalTurnId: '__session__' };

    await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'session-start',
      externalSessionId: 'agent-stop-session',
      externalTurnId: undefined,
      title: 'Agent session',
    }));
    await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'agent-start',
      externalSessionId: 'agent-stop-session',
      externalTurnId: undefined,
      agentId: 'agent-gamma',
      agentType: 'Plan',
    }));
    expect(await findHostSession(agentKey)).not.toBeNull();

    const stopped = await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'agent-stop',
      externalSessionId: 'agent-stop-session',
      externalTurnId: undefined,
      agentId: 'agent-gamma',
    }));

    expect(stopped.accepted).toBe(true);
    expect(stopped.hostOutput).toBeUndefined();
    expect(await findHostSession(agentKey)).toBeNull();
    expect(await findHostSession(sessionKey)).not.toBeNull();
  });

  // captureFingerprint includes payload.summary, so identical consecutive events are
  // dropped by the 1500ms capture debounce. Real tool calls differ; these must too.
  let toolEventSeq = 0;
  const claudeToolEvent = (externalSessionId: string, extra: Partial<NormalizedHostHook> = {}) => hook({
    host: 'claude',
    event: 'session-event',
    type: 'checkpoint',
    externalSessionId,
    externalTurnId: undefined,
    payload: { summary: `Tool ${++toolEventSeq} completed` },
    ...extra,
  });

  it('adopts head without notifying when the watermark is uninitialised', async () => {
    await repo.createKnowledgeCommit(projectId, 'Pre-existing history', [
      { itemId: 'history-1', action: 'insert', after: { id: 'history-1', category: 'fact', title: 'Old news' } },
    ]);
    const key: HostSessionKey = {
      host: 'claude',
      projectRoot: ROOT,
      externalSessionId: 'watermark-init-session',
      externalTurnId: '__turn__',
    };
    const session = await startMemorySession({ title: 'Watermark init' });
    await bindHostSession(key, session.id);
    // A row as the ALTER TABLE leaves it: watermark never set. Written directly because
    // no API produces this state -- every write path marks the row initialized.
    await getClient().execute({
      sql: `UPDATE host_session_bindings SET seen_commit_rowid = 0, seen_commit_initialized = 0
        WHERE external_session_id = ? AND external_turn_id = '__turn__'`,
      args: ['watermark-init-session'],
    });

    const result = await handleHostLifecycleEvent(projectId, claudeToolEvent('watermark-init-session'));

    expect(result.changes).toBeUndefined();
    expect(result.hostOutput).toBeUndefined();
    expect(await readHostSeenCommit(key)).toBe(await readCommitHead());
  });

  it('reports the first commit for a session bound against a repo with no history', async () => {
    // The case the old `seen === 0` sentinel swallowed: 0 meant both "never set" and
    // "genuinely at zero", and the second reading is a real repo on its first commit.
    const key: HostSessionKey = {
      host: 'claude',
      projectRoot: ROOT,
      externalSessionId: 'empty-history-session',
      externalTurnId: '__turn__',
    };
    const session = await startMemorySession({ title: 'Empty history' });
    await bindHostSession(key, session.id);
    await setHostSeenCommit(key, 0); // as if bound when the commit log was empty

    await repo.createKnowledgeCommit(projectId, 'First ever commit', [
      { itemId: 'first-1', action: 'insert', after: { id: 'first-1', category: 'fact', title: 'The very first item' } },
    ]);
    const result = await handleHostLifecycleEvent(projectId, claudeToolEvent('empty-history-session'));

    // Asserted on the summary, not the rendered card: this suite shares one database, so
    // by now the card truncates to five lines plus a "+N more".
    expect(result.changes?.items.map(item => item.title)).toContain('The very first item');
    expect(result.hostOutput).toBeDefined();
  });

  it('emits a change card for a sibling commit and resets drift', async () => {
    const key: HostSessionKey = {
      host: 'claude',
      projectRoot: ROOT,
      externalSessionId: 'sibling-write-session',
      externalTurnId: '__turn__',
    };
    await handleHostLifecycleEvent(projectId, claudeToolEvent('sibling-write-session'));
    await incrementHostSuccessfulToolCount(key);

    await repo.createKnowledgeCommit(projectId, 'Sibling stored a decision', [
      { itemId: 'sibling-x', action: 'insert', after: { id: 'sibling-x', category: 'decision', title: 'Ship the watermark' } },
    ]);

    const result = await handleHostLifecycleEvent(projectId, claudeToolEvent('sibling-write-session'));

    expect(result.changes).toEqual({
      count: 1,
      items: [{ itemId: 'sibling-x', category: 'decision', title: 'Ship the watermark', action: 'insert' }],
    });
    const context = (result.hostOutput as any).hookSpecificOutput.additionalContext as string;
    expect(context).toContain('KNOWL CHANGED: 1 item since you last looked.');
    expect(context).toContain('- decision: Ship the watermark');
    expect(await readHostSeenCommit(key)).toBe(await readCommitHead());

    // The card is delivered once; the next tool event is silent.
    const next = await handleHostLifecycleEvent(projectId, claudeToolEvent('sibling-write-session'));
    expect(next.hostOutput).toBeUndefined();
  });

  it('does not report the agents own write back to it', async () => {
    await handleHostLifecycleEvent(projectId, claudeToolEvent('own-write-session'));

    await repo.createKnowledgeCommit(projectId, 'My own store', [
      { itemId: 'own-1', action: 'insert', after: { id: 'own-1', category: 'fact', title: 'A thing I just learned' } },
    ]);

    const result = await handleHostLifecycleEvent(projectId, claudeToolEvent('own-write-session', {
      knowlTool: true,
      knowlChangeKeys: { ids: [], titles: ['A thing I just learned'] },
    }));

    expect(result.changes).toBeUndefined();
    expect(result.hostOutput).toBeUndefined();
  });

  it('reports a sibling commit even when the agent wrote at the same time', async () => {
    await handleHostLifecycleEvent(projectId, claudeToolEvent('mixed-write-session'));

    await repo.createKnowledgeCommit(projectId, 'Sibling', [
      { itemId: 'mixed-sibling', action: 'insert', after: { id: 'mixed-sibling', category: 'fact', title: 'Sibling fact' } },
    ]);
    await repo.createKnowledgeCommit(projectId, 'Mine', [
      { itemId: 'mixed-mine', action: 'insert', after: { id: 'mixed-mine', category: 'fact', title: 'My fact' } },
    ]);

    const result = await handleHostLifecycleEvent(projectId, claudeToolEvent('mixed-write-session', {
      knowlTool: true,
      knowlChangeKeys: { ids: [], titles: ['My fact'] },
    }));

    expect(result.changes!.items.map(item => item.itemId)).toEqual(['mixed-sibling']);
  });

  it('clamps a watermark ahead of head, as after a snapshot restore', async () => {
    const key: HostSessionKey = {
      host: 'claude',
      projectRoot: ROOT,
      externalSessionId: 'clamp-session',
      externalTurnId: '__turn__',
    };
    await handleHostLifecycleEvent(projectId, claudeToolEvent('clamp-session'));
    await setHostSeenCommit(key, 100_000);

    const result = await handleHostLifecycleEvent(projectId, claudeToolEvent('clamp-session'));

    expect(result.changes).toBeUndefined();
    expect(result.hostOutput).toBeUndefined();
    expect(await readHostSeenCommit(key)).toBe(await readCommitHead());
  });

  it('populates changes for generic hosts without emitting host output', async () => {
    await handleHostLifecycleEvent(projectId, hook({
      host: 'generic',
      event: 'session-event',
      type: 'checkpoint',
      externalSessionId: 'generic-changes-session',
      payload: { summary: 'Generic tool one completed' },
    }));

    await repo.createKnowledgeCommit(projectId, 'Sibling for generic', [
      { itemId: 'generic-1', action: 'insert', after: { id: 'generic-1', category: 'fact', title: 'Generic visible fact' } },
    ]);

    const result = await handleHostLifecycleEvent(projectId, hook({
      host: 'generic',
      event: 'session-event',
      type: 'checkpoint',
      externalSessionId: 'generic-changes-session',
      payload: { summary: 'Generic tool two completed' },
    }));

    expect(result.changes!.items.map(item => item.title)).toEqual(['Generic visible fact']);
    expect(result.hostOutput).toBeUndefined();
  });

  it('prefers the change card over the drift reminder', async () => {
    const key: HostSessionKey = {
      host: 'claude',
      projectRoot: ROOT,
      externalSessionId: 'precedence-session',
      externalTurnId: '__turn__',
    };
    await handleHostLifecycleEvent(projectId, claudeToolEvent('precedence-session'));
    // Park drift one short of the threshold so the next event would emit the static card.
    for (let index = 0; index < 11; index++) await incrementHostSuccessfulToolCount(key);

    await repo.createKnowledgeCommit(projectId, 'Sibling at drift boundary', [
      { itemId: 'precedence-1', action: 'insert', after: { id: 'precedence-1', category: 'fact', title: 'Boundary fact' } },
    ]);

    const result = await handleHostLifecycleEvent(projectId, claudeToolEvent('precedence-session'));
    const context = (result.hostOutput as any).hookSpecificOutput.additionalContext as string;

    expect(context).toContain('KNOWL CHANGED');
    expect(context).not.toContain(KNOWL_CLAUDE_CONTINUATION_REMINDER);
  });

  it('delivers the change card to every host with a mid-turn channel', async () => {
    const hosts: Array<{ host: 'claude' | 'codex' | 'cursor'; expected: (output: any) => void }> = [
      { host: 'claude', expected: o => expect(o.hookSpecificOutput.hookEventName).toBe('PostToolUse') },
      { host: 'codex', expected: o => expect(o.hookSpecificOutput.hookEventName).toBe('PostToolUse') },
      { host: 'cursor', expected: o => expect(o.additional_context).toContain('KNOWL CHANGED') },
    ];

    for (const { host, expected } of hosts) {
      const session = `multi-${host}`;
      await handleHostLifecycleEvent(projectId, hook({
        host, event: 'session-event', type: 'checkpoint', externalSessionId: session,
        externalTurnId: 'turn-1', payload: { summary: `${host} warmup` },
      }));

      await repo.createKnowledgeCommit(projectId, `Sibling for ${host}`, [
        { itemId: `multi-${host}-1`, action: 'insert', after: { id: `multi-${host}-1`, category: 'fact', title: `Fact for ${host}` } },
      ]);

      const result = await handleHostLifecycleEvent(projectId, hook({
        host, event: 'session-event', type: 'checkpoint', externalSessionId: session,
        externalTurnId: 'turn-1', payload: { summary: `${host} second tool` },
      }));

      expect(result.changes?.items.map(item => item.title), host).toEqual([`Fact for ${host}`]);
      expect(result.hostOutput, host).toBeDefined();
      expected(result.hostOutput);
    }
  });

  it('keeps hosts with no mid-turn channel silent while still reporting changes', async () => {
    for (const host of ['generic', 'claude-desktop'] as const) {
      const session = `silent-${host}`;
      await handleHostLifecycleEvent(projectId, hook({
        host, event: 'session-event', type: 'checkpoint', externalSessionId: session,
        externalTurnId: 'turn-1', payload: { summary: `${host} warmup` },
      }));

      await repo.createKnowledgeCommit(projectId, `Sibling for ${host}`, [
        { itemId: `silent-${host}-1`, action: 'insert', after: { id: `silent-${host}-1`, category: 'fact', title: `Quiet fact for ${host}` } },
      ]);

      const result = await handleHostLifecycleEvent(projectId, hook({
        host, event: 'session-event', type: 'checkpoint', externalSessionId: session,
        externalTurnId: 'turn-1', payload: { summary: `${host} second tool` },
      }));

      expect(result.changes?.items.map(item => item.title), host).toEqual([`Quiet fact for ${host}`]);
      expect(result.hostOutput, host).toBeUndefined();
    }
  });
});
