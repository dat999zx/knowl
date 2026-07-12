import { describe, expect, it } from 'vitest';
import { detectSessionFailureKind, formatPendingHandoffContext } from '../../src/store/session-handoff.js';

describe('session handoff helpers', () => {
  it('detects hard-stop kinds from structured codes first', () => {
    expect(detectSessionFailureKind({ status: 'failed', error: 'rate_limit' }, 'failed')).toBe('rate_limit');
    expect(detectSessionFailureKind({ status: 'failed', error: { code: 'rate_limit', message: 'hit limit' } }, 'failed')).toBe('rate_limit');
    expect(detectSessionFailureKind({ status: 'failed', code: '401' }, 'failed')).toBe('auth');
    expect(detectSessionFailureKind({ status: 'failed', error: { type: 'overloaded' } }, 'failed')).toBe('provider_outage');
    expect(detectSessionFailureKind({ status: 'failed', code: 'aborted' }, 'failed')).toBe('interrupted');
  });

  it('uses message fallback only after structured codes', () => {
    expect(detectSessionFailureKind({ status: 'failed', message: 'Session limit reached' }, 'failed')).toBe('rate_limit');
    expect(detectSessionFailureKind({ status: 'failed', message: 'model crashed' }, 'failed')).toBe('failed');
    expect(detectSessionFailureKind({ status: 'finished' }, 'finished')).toBeNull();
  });

  it('formats a resume-first handoff block', () => {
    const text = formatPendingHandoffContext({
      kind: 'rate_limit',
      urgency: 'critical',
      host: 'claude',
      projectRoot: 'D:/Code/demo',
      externalSessionId: 'sess-1',
      memorySessionId: 'mem-1',
      sessionTitle: 'Agent session',
      errorCode: 'rate_limit',
      lastCheckpoint: 'Review loop gated',
      changedPaths: ['src/forge.ts'],
      taskState: {
        goal: 'Ship resumable handoffs',
        completed: ['Added a regression test'],
        nextAction: 'Persist task state',
        blocker: 'Rate limit',
        artifactRefs: ['tests/store/session-handoff.test.ts'],
      },
      failedAt: '2026-07-12T00:00:00.000Z',
    });

    expect(text).toContain('PENDING SESSION HANDOFF');
    expect(text).toContain('rate_limit');
    expect(text).toContain('Review loop gated');
    expect(text).toContain('Ship resumable handoffs');
    expect(text).toContain('Persist task state');
    expect(text).toContain('tests/store/session-handoff.test.ts');
    expect(text).toContain('Do not restart from scratch');
  });
});
