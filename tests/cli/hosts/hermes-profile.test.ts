import { describe, expect, it } from 'vitest';
import { hostProfile } from '../../../src/session/hosts/index.js';
import { HERMES_PLUGIN_EVENTS } from '../../../src/session/hosts/hermes.js';

describe('hermes profile', () => {
  const profile = hostProfile('hermes');

  it('maps Hermes hook events, with two routes into turn-stop', () => {
    // Not mapped on purpose: binding the session there spends the bootstrap card on an event
    // whose return value Hermes discards, and the first real turn then gets nothing.
    expect(profile.normalizedEvent('on_session_start')).toBeUndefined();
    expect(profile.normalizedEvent('pre_llm_call')).toBe('turn-start');
    expect(profile.normalizedEvent('pre_tool_call')).toBe('tool-precheck');
    expect(profile.normalizedEvent('post_tool_call')).toBe('session-event');
    // The edit-turn event that can keep the turn going, and the every-turn finaliser.
    expect(profile.normalizedEvent('pre_verify')).toBe('turn-stop');
    expect(profile.normalizedEvent('on_session_end')).toBe('turn-stop');
    expect(profile.normalizedEvent('on_session_finalize')).toBe('session-stop');
    // Hermes events Knowl does not register must not normalise to anything.
    expect(profile.normalizedEvent('post_llm_call')).toBeUndefined();
    expect(profile.normalizedEvent('subagent_stop')).toBeUndefined();
  });

  it('registers no hooks file, because the plugin is the channel', () => {
    expect(profile.hookEvents).toEqual([]);
    expect(profile.hookConfigStyle).toBe('none');
    expect(profile.promptEvent).toBe('pre_llm_call');
    expect(profile.nativeOutput).toBe(true);
    expect(profile.lifecycleClaimable).toBe(false);
  });

  it('accepts every event the shipped plugin forwards', () => {
    for (const event of HERMES_PLUGIN_EVENTS) {
      expect(profile.normalizedEvent(event), event).toBeDefined();
    }
    expect(HERMES_PLUGIN_EVENTS).not.toContain('on_session_start');
  });

  it('refuses and nudges with the Claude Stop shape Hermes accepts, plus exit 2', () => {
    expect(profile.denyToolCall?.('trap')).toEqual({ decision: 'block', reason: 'trap' });
    expect(profile.stopContext?.('store first')).toEqual({ decision: 'block', reason: 'store first' });
    expect(profile.denyExitCode).toBe(2);
    // Hermes reads top-level keys only; the hookSpecificOutput wrapper would be ignored.
    expect(profile.denyToolCall?.('x')).not.toHaveProperty('hookSpecificOutput');
  });

  it('injects context on the prompt event only', () => {
    expect(profile.startContext('turn-start', 'card')).toEqual({ context: 'card' });
    expect(profile.startContext('session-start', 'card')).toBeUndefined();
    expect(profile.midTurnContext('x')).toBeUndefined();
    expect(profile.preToolContext).toBeUndefined();
  });

  it('knows Hermes tool names', () => {
    expect(profile.writeTools).toEqual(['write_file', 'patch']);
    expect(profile.readsFiles?.('post_tool_call', 'read_file')).toBe(true);
    expect(profile.readsFiles?.('post_tool_call', 'search_files')).toBe(false);
    expect(profile.isShellEvent('pre_tool_call', 'terminal')).toBe(true);
  });

  it('keys identity on session_id alone, since extra never reaches the engine', () => {
    expect(profile.identity({ session_id: 's1', extra: { turn_id: 't1' } })).toEqual({ externalSessionId: 's1' });
  });
});
