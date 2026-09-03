import { describe, expect, it } from 'vitest';
import { hostProfile } from '../../../src/session/hosts/index.js';

describe('hermes profile', () => {
  const profile = hostProfile('hermes');

  it('accepts the normalized events the plugin sends, and has no turn-stop', () => {
    for (const event of ['session-start', 'turn-start', 'tool-precheck', 'session-event', 'session-stop']) {
      expect(profile.normalizedEvent(event), event).toBe(event);
    }
    // Hermes has no hook between the model's last step and the end of the turn.
    expect(profile.normalizedEvent('turn-stop')).toBeUndefined();
    expect(profile.stopContext).toBeUndefined();
  });

  it('can refuse, in the plugin shape', () => {
    expect(profile.denyToolCall?.('why')).toEqual({ denied: 'why' });
    expect(profile.nativeOutput).toBe(false);
    expect(profile.hookEvents).toEqual([]);
    expect(profile.hookConfigStyle).toBe('none');
    expect(profile.lifecycleClaimable).toBe(false);
  });

  it('knows Hermes tool names', () => {
    expect(profile.readsFiles?.('', 'read_file')).toBe(true);
    for (const tool of ['write_file', 'patch']) expect(profile.writesFiles?.('', tool), tool).toBe(true);
    expect(profile.writesFiles?.('', 'read_file')).toBe(false);
    expect(profile.isShellEvent('', 'terminal')).toBe(true);
  });
});
