import { describe, expect, it } from 'vitest';
import { hostProfile } from '../../../src/session/hosts/index.js';
import { OPENCLAW_PLUGIN_EVENTS, openclawProfile } from '../../../src/session/hosts/openclaw.js';

describe('openclaw profile', () => {
  const profile = hostProfile('openclaw');

  it('maps OpenClaw hook events, with session_start deliberately unmapped to deliver the bootstrap card', () => {
    // Not mapped on purpose: binding the session there spends the bootstrap card on an event
    // whose return value OpenClaw discards, and the first real turn then gets nothing.
    expect(openclawProfile.normalizedEvent('session_start')).toBeUndefined();
    expect(openclawProfile.normalizedEvent('before_prompt_build')).toBe('turn-start');
    expect(profile.normalizedEvent('before_tool_call')).toBe('tool-precheck');
    expect(profile.normalizedEvent('after_tool_call')).toBe('session-event');
    expect(profile.normalizedEvent('before_compaction')).toBe('checkpoint');
    expect(profile.normalizedEvent('session_end')).toBe('turn-stop');
    expect(profile.normalizedEvent('agent_end')).toBe('turn-stop');
    expect(profile.normalizedEvent('gateway_stop')).toBe('session-stop');
  });

  it('accepts every event the shipped plugin forwards except session_start', () => {
    for (const event of OPENCLAW_PLUGIN_EVENTS) {
      expect(openclawProfile.normalizedEvent(event), event).toBeDefined();
    }
    expect(OPENCLAW_PLUGIN_EVENTS).not.toContain('session_start');
  });
});
