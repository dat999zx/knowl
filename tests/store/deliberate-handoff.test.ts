import { describe, expect, it } from 'vitest';
import { SESSION_HANDOFF_KINDS } from '../../src/store/session-handoff.js';

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
