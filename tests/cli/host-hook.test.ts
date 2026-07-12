import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeHostHook } from '../../src/cli/agents/host-hook.js';

const ROOT = path.resolve('.knowl-host-hook-test');

describe('host hook normalization', () => {
  it('normalizes Codex turn start without retaining the prompt body', () => {
    const result = normalizeHostHook('codex', 'UserPromptSubmit', {
      session_id: 'session-1',
      turn_id: 'turn-1',
      cwd: ROOT,
      prompt: 'Private prompt text must not be stored',
    });

    expect(result).toMatchObject({
      host: 'codex',
      event: 'turn-start',
      externalSessionId: 'session-1',
      externalTurnId: 'turn-1',
      projectRoot: ROOT,
      title: 'Agent turn',
      payload: {},
    });
    expect(JSON.stringify(result)).not.toContain('Private prompt');
  });

  it('uses stable Codex fallback identity fields', () => {
    const result = normalizeHostHook('codex', 'UserPromptSubmit', {
      conversation_id: 'conversation-1',
      generation_id: 'generation-1',
      cwd: ROOT,
    });

    expect(result.externalSessionId).toBe('conversation-1');
    expect(result.externalTurnId).toBe('generation-1');
  });

  it('normalizes Claude tool success and failure into allowlisted events', () => {
    const success = normalizeHostHook('claude', 'PostToolUse', {
      session_id: 'session-2',
      cwd: ROOT,
      tool_name: 'Bash',
      tool_input: { command: 'npm test', unsafe: 'discard me' },
      tool_response: { stdout: 'discard me', exit_code: 0 },
    });
    const failure = normalizeHostHook('claude', 'PostToolUseFailure', {
      session_id: 'session-2',
      cwd: ROOT,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      error: 'Tests failed',
      stderr: 'discard me',
    });

    expect(success).toMatchObject({
      event: 'session-event',
      type: 'command',
      payload: { command: 'npm test', exitCode: 0 },
    });
    expect(failure).toMatchObject({
      event: 'session-event',
      type: 'error',
      status: 'failed',
      payload: { message: 'Tests failed' },
    });
    expect(JSON.stringify([success, failure])).not.toContain('discard me');
  });

  it('normalizes Cursor shell and file-edit events', () => {
    const command = normalizeHostHook('cursor', 'afterShellExecution', {
      conversation_id: 'session-3',
      generation_id: 'turn-3',
      workspace_roots: [ROOT],
      command: 'npm test',
      exit_code: 0,
      stdout: 'discard me',
    });
    const edit = normalizeHostHook('cursor', 'afterFileEdit', {
      conversation_id: 'session-3',
      generation_id: 'turn-3',
      workspace_roots: [ROOT],
      file_path: path.join(ROOT, 'src', 'auth.ts'),
    });

    expect(command).toMatchObject({
      externalSessionId: 'session-3',
      externalTurnId: 'turn-3',
      projectRoot: ROOT,
      type: 'command',
      payload: { command: 'npm test', exitCode: 0 },
    });
    expect(edit).toMatchObject({
      type: 'checkpoint',
      payload: { changedPaths: ['src/auth.ts'] },
    });
  });

  it('accepts the generic contract and bounds retained strings', () => {
    const result = normalizeHostHook('generic', 'session-event', {
      sessionId: 'session-4',
      turnId: 'turn-4',
      cwd: ROOT,
      type: 'checkpoint',
      summary: 'x'.repeat(3_000),
      stdout: 'discard me',
    });

    expect(result.externalSessionId).toBe('session-4');
    expect(result.externalTurnId).toBe('turn-4');
    expect(result.type).toBe('checkpoint');
    expect(result.payload.summary).toHaveLength(2_000);
    expect(result.payload).not.toHaveProperty('stdout');
  });

  it('keeps structured checkpoint state without retaining arbitrary tool output', () => {
    const result = normalizeHostHook('generic', 'checkpoint', {
      sessionId: 'session-structured',
      turnId: 'turn-structured',
      cwd: ROOT,
      summary: 'Checkpoint complete',
      goal: 'Ship resumable handoffs',
      completed: ['Added a test'],
      nextAction: 'Implement the contract',
      blocker: 'Waiting for a rate-limit reset',
      artifactRefs: ['tests/store/host-lifecycle.test.ts'],
      stdout: 'discard me',
    });

    expect(result.payload).toEqual({
      summary: 'Checkpoint complete',
      goal: 'Ship resumable handoffs',
      completed: ['Added a test'],
      nextAction: 'Implement the contract',
      blocker: 'Waiting for a rate-limit reset',
      artifactRefs: ['tests/store/host-lifecycle.test.ts'],
    });
  });


  it('preserves Claude StopFailure rate-limit error codes', () => {
    const result = normalizeHostHook('claude', 'StopFailure', {
      session_id: 'session-rate',
      turn_id: 'turn-rate',
      cwd: ROOT,
      error: 'rate_limit',
      message: 'Claude session limit hit',
    });

    expect(result).toMatchObject({
      host: 'claude',
      event: 'turn-stop',
      status: 'failed',
      payload: {
        status: 'failed',
        error: 'rate_limit',
        code: 'rate_limit',
        message: 'Claude session limit hit',
      },
    });
  });
  it('rejects unsupported hosts and events', () => {
    expect(() => normalizeHostHook('unknown', 'SessionStart', {})).toThrow('Unsupported hook host');
    expect(() => normalizeHostHook('codex', 'UnknownEvent', { session_id: 's', cwd: ROOT })).toThrow('Unsupported codex hook event');
  });
});

