import { describe, expect, it } from 'vitest';
import {
  formatPendingHandoffContext,
  HANDOFF_URGENCY,
  SESSION_HANDOFF_KINDS,
} from '../../src/store/session-handoff.js';
import type { PendingHandoff } from '../../src/store/session-handoff.js';

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
