import { describe, expect, it } from 'vitest';
import { HOST_PROFILES, hostProfile } from '../../../src/session/hosts/index.js';
import { HookHost } from '../../../src/cli/agents/host-hook.js';

const ALL_HOSTS: HookHost[] = [
  'codex', 'claude', 'cursor', 'claude-desktop', 'generic',
  'copilot', 'openhands', 'antigravity', 'windsurf', 'cline',
];

describe('host profile registry', () => {
  it('has exactly one profile per HookHost', () => {
    expect(Object.keys(HOST_PROFILES).sort()).toEqual([...ALL_HOSTS].sort());
    for (const host of ALL_HOSTS) expect(hostProfile(host).host).toBe(host);
  });

  it('rejects an unknown host', () => {
    expect(() => hostProfile('nope' as HookHost)).toThrow('Unsupported hook host');
  });

  it('a profile that refuses by exit status also renders a reason', () => {
    for (const profile of Object.values(HOST_PROFILES)) {
      if (profile.denyExitCode === undefined) continue;
      expect(profile.denyExitCode, profile.host).toBeGreaterThan(0);
      expect(typeof profile.denyToolCall, profile.host).toBe('function');
    }
  });

  it('a host that registers hook handlers declares the shape of the file they go in', () => {
    for (const profile of Object.values(HOST_PROFILES)) {
      // `generic` declares events so third-party callers can send them, but `knowl init`
      // never writes a file for it -- it is invoked directly, never installed.
      const installs = profile.hookEvents.length > 0 && profile.host !== 'generic';
      expect(profile.hookConfigStyle === 'none', profile.host).toBe(!installs);
    }
  });

  it('never declares its prompt event as a lifecycle event as well', () => {
    // `mergeNestedHookConfig` writes the lifecycle handler under the event key and then
    // overwrites that same key with the reminder entry, rebuilt from the pre-merge map. A
    // host declaring both loses its lifecycle handler permanently -- re-running `knowl init`
    // reproduces it, and `verifyNestedHookConfig` then reports stale hooks forever.
    for (const profile of Object.values(HOST_PROFILES)) {
      if (!profile.promptEvent) continue;
      expect(profile.hookEvents, profile.host).not.toContain(profile.promptEvent);
    }
  });

  it('codex declares exactly the lifecycle events codex 0.147.0 implements', () => {
    // Verified 2026-08-22 by string inspection of the shipped codex.exe (0.147.0, win32-x64).
    // `PostToolUseFailure` and `StopFailure` are absent from that binary and were declared here
    // for years; `PostCompact` and `PermissionRequest` are present but deliberately not
    // registered -- see the profile's header for why registering either would double-count or
    // answer with the wrong event name.
    expect([...hostProfile('codex').hookEvents]).toEqual([
      'SessionStart', 'SubagentStart', 'PreToolUse', 'PostToolUse',
      'PreCompact', 'Stop', 'SubagentStop', 'SessionEnd',
    ]);
    expect(hostProfile('codex').promptEvent).toBe('UserPromptSubmit');
  });

  it('codex can refuse a tool call and withhold a stop', () => {
    const profile = hostProfile('codex');
    expect(profile.denyToolCall?.('nope')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'nope',
      },
    });
    expect(profile.stopContext?.('store it')).toEqual({ decision: 'block', reason: 'store it' });
  });

  describe.each(ALL_HOSTS)('%s', host => {
    const profile = () => hostProfile(host);

    it('maps every registered hook event to a normalized event', () => {
      for (const event of profile().hookEvents) {
        expect(profile().normalizedEvent(event), `${host}:${event}`).toBeDefined();
      }
    });

    it('maps its prompt event when it declares one', () => {
      const { promptEvent } = profile();
      if (promptEvent) expect(profile().normalizedEvent(promptEvent)).toBe('turn-start');
    });

    it('returns undefined for an unknown event name', () => {
      expect(profile().normalizedEvent('NotARealEvent')).toBeUndefined();
    });

    it('either returns a non-empty envelope or undefined for mid-turn context', () => {
      const output = profile().midTurnContext('hello');
      if (output !== undefined) {
        expect(Object.keys(output).length).toBeGreaterThan(0);
        expect(JSON.stringify(output)).toContain('hello');
      }
    });

    it('either returns a non-empty envelope or undefined for start context', () => {
      const output = profile().startContext('session-start', 'hello');
      if (output !== undefined) {
        expect(JSON.stringify(output)).toContain('hello');
      }
    });

    it('claims verified mid-turn delivery only when it has an envelope to deliver', () => {
      // The converse is deliberately allowed: Cursor has an envelope and unverified
      // delivery, which is what keeps the MCP fallback channel talking to it.
      if (profile().midTurnDeliveryVerified) expect(profile().midTurnContext('x')).toBeDefined();
    });

    it('declares mid-turn support only when it registers a tool event', () => {
      // A host with no tool-call event has nowhere to attach a mid-turn card.
      //
      // Asked of the profile rather than matched against a list of spellings. The regex this
      // replaces (`/posttooluse|aftershellexecution/i`) had to be edited every time a host
      // named the same event differently, and it failed open: an unrecognised spelling read as
      // "no tool event", so the assertion it exists to make quietly stopped being made.
      // `session-event` *is* the definition of a mid-turn attachment point.
      const hasToolEvent = profile().hookEvents.some(event => profile().normalizedEvent(event) === 'session-event');
      if (profile().midTurnContext('x') !== undefined) expect(hasToolEvent).toBe(true);
    });
  });

  it('gives claude-desktop no hook events and no envelopes', () => {
    // Regression: the old eventMap ternary silently routed claude-desktop through
    // Cursor's event map because only codex and claude were checked by name.
    const profile = hostProfile('claude-desktop');
    expect(profile.hookEvents).toEqual([]);
    expect(profile.normalizedEvent('postToolUse')).toBeUndefined();
    expect(profile.normalizedEvent('PostToolUse')).toBeUndefined();
    expect(profile.startContext('session-start', 'x')).toBeUndefined();
    expect(profile.midTurnContext('x')).toBeUndefined();
  });

  it('extracts identity from each host\'s own payload keys', () => {
    expect(hostProfile('claude').identity({ session_id: 's', agent_id: 'a', agent_type: 'Explore' }))
      .toEqual({ externalSessionId: 's', externalTurnId: undefined, agentId: 'a', agentType: 'Explore' });
    expect(hostProfile('codex').identity({ session_id: 's', turn_id: 't' }))
      .toMatchObject({ externalSessionId: 's', externalTurnId: 't' });
    expect(hostProfile('cursor').identity({ conversation_id: 'c', generation_id: 'g' }))
      .toMatchObject({ externalSessionId: 'c', externalTurnId: 'g' });
    expect(hostProfile('generic').identity({ sessionId: 's', turnId: 't' }))
      .toMatchObject({ externalSessionId: 's', externalTurnId: 't' });
  });
});
