import { describe, expect, it } from 'vitest';
import { detectSessionFailureKind, formatPendingHandoffContext } from '../../src/store/session-handoff.js';

describe('session handoff helpers', () => {
  it('detects Claude rate-limit failures from structured error codes', () => {
    expect(detectSessionFailureKind({ status: 'failed', error: 'rate_limit' }, 'failed')).toBe('rate_limit');
    expect(detectSessionFailureKind({ status: 'failed', error: { code: 'rate_limit', message: 'hit limit' } }, 'failed')).toBe('rate_limit');
    expect(detectSessionFailureKind({ status: 'failed', message: 'Session limit reached' }, 'failed')).toBe('rate_limit');
  });

  it('keeps non-limit failures as generic failed handoffs', () => {
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
      failedAt: '2026-07-12T00:00:00.000Z',
    });

    expect(text).toContain('PENDING SESSION HANDOFF');
    expect(text).toContain('rate_limit');
    expect(text).toContain('Review loop gated');
    expect(text).toContain('Do not restart from scratch');
  });
});
