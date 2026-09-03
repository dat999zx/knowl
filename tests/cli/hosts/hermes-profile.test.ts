import { describe, expect, it } from 'vitest';
import { hostProfile } from '../../../src/session/hosts/index.js';

describe('hermes profile', () => {
  const profile = hostProfile('hermes');

  it('maps Hermes shell-hook events, with two routes into turn-stop', () => {
    expect(profile.normalizedEvent('on_session_start')).toBe('session-start');
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

  it('registers the lifecycle events and keeps the prompt event separate', () => {
    expect([...profile.hookEvents]).toEqual([
      'on_session_start', 'pre_tool_call', 'post_tool_call', 'pre_verify', 'on_session_end', 'on_session_finalize',
    ]);
    expect(profile.promptEvent).toBe('pre_llm_call');
    expect(profile.hookEvents).not.toContain('pre_llm_call');
    expect(profile.hookConfigStyle).toBe('hermes-yaml');
    expect(profile.nativeOutput).toBe(true);
    expect(profile.lifecycleClaimable).toBe(false);
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
