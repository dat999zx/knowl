import { describe, expect, it } from 'vitest';
import { HOST_PROFILES, hostProfile } from '../../../src/session/hosts/index.js';
import { HookHost } from '../../../src/cli/agents/host-hook.js';

const ALL_HOSTS: HookHost[] = [
  'codex', 'claude', 'cursor', 'claude-desktop', 'generic',
  'copilot', 'openhands', 'antigravity', 'windsurf', 'cline',
  'hermes',
];

describe('host profile registry', () => {
  // The matcher on the pre-tool hook entry is built from `writeTools`, and the write gate reads
  // the same list through `toolWritesFile`. If a host declared both, the two could disagree and
  // the host would stop starting the process for a tool the gate still wanted to refuse -- a
  // gate that silently stops firing, which is the failure mode with no symptom.
  it('never declares both a writesFiles predicate and a writeTools list', () => {
    for (const host of ALL_HOSTS) {
      const profile = hostProfile(host);
      expect(
        Boolean(profile.writesFiles) && Boolean(profile.writeTools),
        `${host} declares both writesFiles and writeTools`,
      ).toBe(false);
    }
  });

  it('accepts every one of its writeTools as a write, and nothing outside the list', () => {
    for (const host of ALL_HOSTS) {
      const profile = hostProfile(host);
      if (!profile.writeTools) continue;
      expect(profile.writeTools.length, `${host} declares an empty writeTools`).toBeGreaterThan(0);
      // The matcher is anchored, so a name must match itself and nothing must match a name the
      // list does not carry.
      const matcher = new RegExp(`^(${profile.writeTools.join('|')})$`);
      for (const tool of profile.writeTools) expect(matcher.test(tool), `${host}: ${tool}`).toBe(true);
      expect(matcher.test('Read')).toBe(false);
      expect(matcher.test('Bash')).toBe(false);
    }
  });

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

  it('a profile that carries pre-tool advice has a pre-tool event to carry it on', () => {
    // `preToolContext` is only ever reached from the pre-tool hook, so a host declaring the
    // envelope without registering the event has an envelope nothing can deliver -- the
    // capability-by-return-value rule failing in the one direction it cannot catch itself.
    for (const profile of Object.values(HOST_PROFILES)) {
      if (!profile.preToolContext) continue;
      const preTool = profile.hookEvents.filter(event => profile.normalizedEvent(event) === 'tool-precheck');
      expect(preTool.length, `${profile.host} declares preToolContext with no pre-tool event`).toBeGreaterThan(0);
      expect(profile.preToolContext('advice'), profile.host).toBeTruthy();
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

  it('reads no payload field the stdin allowlist throws away', async () => {
    // The failure this pins killed Antigravity outright and left Windsurf one fallback short:
    // a profile reads a field, `readLifecyclePayload` drops it before the profile ever runs,
    // and the event dies on "requires a session id" -- which the hook entry swallows in
    // silence, so the host reports nothing, logs nothing, and looks exactly like one nobody
    // configured. Neither side is wrong on its own; only the pair is, which is why this asks
    // them together rather than asserting a list.
    const { readLifecyclePayload } = await import('../../../src/cli/agents/lifecycle.js');
    const { Readable } = await import('node:stream');

    for (const host of ALL_HOSTS) {
      const profile = hostProfile(host);
      const read = new Set<string>();
      const spy = new Proxy({}, { get: (_t, key) => { if (typeof key === 'string') read.add(key); return undefined; } });
      profile.identity(spy as Record<string, unknown>);
      profile.normalizePayload?.(spy as Record<string, unknown>);
      // A truthy value per key, so a survivor is visible and a dropped key is absent.
      const sent = Object.fromEntries([...read].map(key => [key, 'x']));
      const kept = await readLifecyclePayload(Readable.from([JSON.stringify(sent)]) as never);
      for (const key of read) expect(kept, `${host} reads ${key}, which stdin drops`).toHaveProperty(key);
    }
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
