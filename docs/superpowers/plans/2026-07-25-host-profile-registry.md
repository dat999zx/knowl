# Host Profile Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace 23 scattered host conditionals with one `HostProfile` interface and one file per host, and deliver change notification to every host that has a channel for it.

**Architecture:** A `HostProfile` declares what a host supports — identity keys, event mapping, and context envelopes. Core code asks the profile instead of branching on `host === '...'`. Capability is expressed by return value: a host with no mid-turn channel returns `undefined` from `midTurnContext`, so no boolean can claim support the function does not deliver.

**Tech Stack:** TypeScript (ESM, `"type": "module"`), vitest, `@libsql/client`.

**Spec:** [docs/superpowers/specs/2026-07-25-host-profile-registry-design.md](../specs/2026-07-25-host-profile-registry-design.md)

## Global Constraints

- **Pure refactor through Task 4.** Tasks 1-4 must not change behaviour for any host. The existing suites encode current per-host behaviour and are the regression gate — 358 tests must stay green.
- **No new host conditionals.** After Task 4, `grep -rn "host === '" src/` must return nothing outside `src/cli/agents/hosts/` and `project-adapters.ts`.
- **Every `HookHost` has exactly one profile.** `HookHost` is `'codex' | 'claude' | 'cursor' | 'claude-desktop' | 'generic'`.
- **Capability by return value.** Never add a boolean that duplicates what `startContext`/`midTurnContext` returning `undefined` already says.
- **No stdout from hook paths** beyond `result.hostOutput`.
- **Card budget unchanged:** 5 item lines, titles truncated to 90 chars, zero bytes when nothing changed.
- **`KNOWL_REMINDER_DRIFT = 12`** stays.

## File Structure

**New:**

| File | Responsibility |
| --- | --- |
| `src/cli/agents/hosts/profile.ts` | The `HostProfile` and `HostIdentity` types, plus `stringValue`-style helpers shared by profiles. No host specifics. |
| `src/cli/agents/hosts/claude.ts` | Claude Code: full hooks, subagents, `hookSpecificOutput`. |
| `src/cli/agents/hosts/codex.ts` | Codex CLI: same envelope shape as Claude, own identity keys. |
| `src/cli/agents/hosts/cursor.ts` | Cursor: camelCase events, `conversation_id`/`generation_id`, `additional_context`. |
| `src/cli/agents/hosts/claude-desktop.ts` | MCP-only: no hook events, no envelopes. |
| `src/cli/agents/hosts/generic.ts` | Host-neutral contract: verbatim event names, no envelopes. |
| `src/cli/agents/hosts/index.ts` | `hostProfile(host)` registry. |
| `tests/cli/hosts/profile-conformance.test.ts` | One suite run against every registered profile. |

**Modified:** `src/cli/agents/host-hook.ts`, `src/store/host-lifecycle.ts`, `src/cli/agents/hook-config.ts`, `src/cli/agents/reminder.ts`, `src/index.ts`.

---

### Task 1: Profile interface, per-host files, registry

**Files:**
- Create: `src/cli/agents/hosts/profile.ts`, `claude.ts`, `codex.ts`, `cursor.ts`, `claude-desktop.ts`, `generic.ts`, `index.ts`
- Test: `tests/cli/hosts/profile-conformance.test.ts`

**Interfaces:**
- Consumes: `HookHost` and `NormalizedHookEventName` from `src/cli/agents/host-hook.js`.
- Produces: `hostProfile(host: HookHost): HostProfile` from `src/cli/agents/hosts/index.js`; the `HostProfile` and `HostIdentity` types from `profile.js`; `HOST_PROFILES` as a `Record<HookHost, HostProfile>`.

Pure addition — nothing imports it yet, so all 358 existing tests must still pass.

- [x] **Step 1: Write the conformance test**

Create `tests/cli/hosts/profile-conformance.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { HOST_PROFILES, hostProfile } from '../../../src/cli/agents/hosts/index.js';
import { HookHost } from '../../../src/cli/agents/host-hook.js';

const ALL_HOSTS: HookHost[] = ['codex', 'claude', 'cursor', 'claude-desktop', 'generic'];

describe('host profile registry', () => {
  it('has exactly one profile per HookHost', () => {
    expect(Object.keys(HOST_PROFILES).sort()).toEqual([...ALL_HOSTS].sort());
    for (const host of ALL_HOSTS) expect(hostProfile(host).host).toBe(host);
  });

  it('rejects an unknown host', () => {
    expect(() => hostProfile('nope' as HookHost)).toThrow('Unsupported hook host');
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

    it('declares mid-turn support only when it registers a tool event', () => {
      // A host with no tool-call event has nowhere to attach a mid-turn card.
      const hasToolEvent = profile().hookEvents.some(event => /posttooluse|aftershellexecution/i.test(event));
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
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/cli/hosts/profile-conformance.test.ts`
Expected: FAIL — cannot resolve `src/cli/agents/hosts/index.js`.

- [x] **Step 3: Create the profile contract**

Create `src/cli/agents/hosts/profile.ts`:

```typescript
import type { HookHost, NormalizedHookEventName } from '../host-hook.js';

export const MAX_HOST_STRING = 2_000;

export type HostOutput = Record<string, unknown>;

export type HostIdentity = {
  externalSessionId?: string;
  externalTurnId?: string;
  agentId?: string;
  agentType?: string;
};

/**
 * Everything that differs between hosts. Core code asks a profile instead of
 * branching on the host name.
 *
 * Capability is expressed by return value: a host that cannot receive context
 * returns undefined, so no flag can claim support the envelope does not deliver.
 */
export interface HostProfile {
  readonly host: HookHost;
  /** Host-native lifecycle events `knowl init` registers. Empty means MCP-only. */
  readonly hookEvents: readonly string[];
  /** Host event carrying the prompt-time guidance card, if the host has one. */
  readonly promptEvent?: string;
  /** True when one session binding spans turns, so turn-stop closes only the turn. */
  readonly sharesSessionBinding: boolean;
  /** True when the CLI emits host-shaped JSON instead of the host-neutral result. */
  readonly nativeOutput: boolean;
  identity(raw: Record<string, unknown>): HostIdentity;
  normalizedEvent(hostEvent: string): NormalizedHookEventName | undefined;
  isShellEvent(hostEvent: string, toolName: string): boolean;
  startContext(event: NormalizedHookEventName, context: string): HostOutput | undefined;
  midTurnContext(text: string): HostOutput | undefined;
}

export const hostString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_HOST_STRING) : undefined;

/** Shared by hosts whose tool events name the tool rather than the channel. */
export const toolNameIsShell = (toolName: string): boolean =>
  toolName.toLocaleLowerCase() === 'bash' || toolName.toLocaleLowerCase() === 'shell';

export const agentIdentityFrom = (raw: Record<string, unknown>): Pick<HostIdentity, 'agentId' | 'agentType'> => ({
  agentId: hostString(raw.agent_id) ?? hostString(raw.agentId),
  agentType: hostString(raw.agent_type) ?? hostString(raw.agentType),
});
```

- [x] **Step 4: Create the Claude and Codex profiles**

Both hosts use Anthropic-style PascalCase event names and the same
`hookSpecificOutput` envelope, so the shared parts live in one helper that each file
uses — not in a base class, because their identity keys and event lists differ.

Create `src/cli/agents/hosts/claude.ts`:

```typescript
import type { NormalizedHookEventName } from '../host-hook.js';
import { agentIdentityFrom, HostIdentity, HostOutput, HostProfile, hostString, toolNameIsShell } from './profile.js';

/** Event names shared by hosts that implement the Anthropic-style hook schema. */
export const PASCAL_EVENT_MAP: Record<string, NormalizedHookEventName> = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'turn-start',
  PostToolUse: 'session-event',
  PostToolUseFailure: 'session-event',
  PreCompact: 'checkpoint',
  Stop: 'turn-stop',
  StopFailure: 'turn-stop',
  SubagentStart: 'agent-start',
  SubagentStop: 'agent-stop',
  SessionEnd: 'session-stop',
};

/** `hookSpecificOutput` envelope used by Claude Code and Codex CLI. */
export function hookSpecificOutput(hookEventName: string, context: string): HostOutput {
  return { hookSpecificOutput: { hookEventName, additionalContext: context } };
}

export function startEventName(event: NormalizedHookEventName): string {
  if (event === 'session-start') return 'SessionStart';
  if (event === 'agent-start') return 'SubagentStart';
  return 'UserPromptSubmit';
}

export const CLAUDE_HOOK_EVENTS = [
  'SessionStart', 'SubagentStart', 'PostToolUse', 'PostToolUseFailure',
  'PreCompact', 'Stop', 'StopFailure', 'SubagentStop', 'SessionEnd',
] as const;

export const claudeProfile: HostProfile = {
  host: 'claude',
  hookEvents: CLAUDE_HOOK_EVENTS,
  promptEvent: 'UserPromptSubmit',
  sharesSessionBinding: true,
  nativeOutput: true,
  identity(raw): HostIdentity {
    return {
      externalSessionId: hostString(raw.session_id) ?? hostString(raw.conversation_id) ?? hostString(raw.thread_id),
      externalTurnId: hostString(raw.turn_id) ?? hostString(raw.generation_id),
      ...agentIdentityFrom(raw),
    };
  },
  normalizedEvent(hostEvent) {
    return PASCAL_EVENT_MAP[hostEvent];
  },
  isShellEvent(_hostEvent, toolName) {
    return toolNameIsShell(toolName);
  },
  startContext(event, context) {
    return hookSpecificOutput(startEventName(event), context);
  },
  midTurnContext(text) {
    return hookSpecificOutput('PostToolUse', text);
  },
};
```

Create `src/cli/agents/hosts/codex.ts`:

```typescript
import type { HostIdentity, HostProfile } from './profile.js';
import { agentIdentityFrom, hostString, toolNameIsShell } from './profile.js';
import { hookSpecificOutput, PASCAL_EVENT_MAP, startEventName } from './claude.js';

/**
 * Codex CLI implements the same hook schema as Claude Code, including
 * SubagentStart/SubagentStop and additionalContext on PostToolUse
 * (verified in codex.exe 0.145.0: hooks\src\engine\dispatcher.rs carries the full
 * event enum alongside additionalContext and hookSpecificOutput).
 */
export const CODEX_HOOK_EVENTS = [
  'SessionStart', 'SubagentStart', 'PostToolUse', 'PostToolUseFailure',
  'PreCompact', 'Stop', 'SubagentStop',
] as const;

export const codexProfile: HostProfile = {
  host: 'codex',
  hookEvents: CODEX_HOOK_EVENTS,
  promptEvent: undefined,
  sharesSessionBinding: true,
  nativeOutput: true,
  identity(raw): HostIdentity {
    return {
      externalSessionId: hostString(raw.session_id) ?? hostString(raw.conversation_id) ?? hostString(raw.thread_id),
      externalTurnId: hostString(raw.turn_id) ?? hostString(raw.generation_id),
      ...agentIdentityFrom(raw),
    };
  },
  normalizedEvent(hostEvent) {
    return PASCAL_EVENT_MAP[hostEvent];
  },
  isShellEvent(_hostEvent, toolName) {
    return toolNameIsShell(toolName);
  },
  startContext(event, context) {
    return hookSpecificOutput(startEventName(event), context);
  },
  midTurnContext(text) {
    return hookSpecificOutput('PostToolUse', text);
  },
};
```

- [x] **Step 5: Create the Cursor, Claude Desktop, and generic profiles**

Create `src/cli/agents/hosts/cursor.ts`:

```typescript
import type { NormalizedHookEventName } from '../host-hook.js';
import type { HostIdentity, HostProfile } from './profile.js';
import { agentIdentityFrom, hostString } from './profile.js';

const CURSOR_EVENT_MAP: Record<string, NormalizedHookEventName> = {
  sessionStart: 'session-start',
  beforeSubmitPrompt: 'turn-start',
  afterShellExecution: 'session-event',
  postToolUse: 'session-event',
  postToolUseFailure: 'session-event',
  afterFileEdit: 'session-event',
  preCompact: 'checkpoint',
  stop: 'turn-stop',
  sessionEnd: 'session-stop',
};

export const CURSOR_HOOK_EVENTS = [
  'sessionStart', 'afterShellExecution', 'postToolUse', 'postToolUseFailure',
  'afterFileEdit', 'preCompact', 'stop', 'sessionEnd',
] as const;

export const cursorProfile: HostProfile = {
  host: 'cursor',
  hookEvents: CURSOR_HOOK_EVENTS,
  promptEvent: undefined,
  sharesSessionBinding: false,
  nativeOutput: true,
  identity(raw): HostIdentity {
    return {
      externalSessionId: hostString(raw.conversation_id),
      externalTurnId: hostString(raw.generation_id),
      ...agentIdentityFrom(raw),
    };
  },
  normalizedEvent(hostEvent) {
    return CURSOR_EVENT_MAP[hostEvent];
  },
  isShellEvent(hostEvent) {
    return hostEvent === 'afterShellExecution';
  },
  startContext(_event, context) {
    return { additional_context: context, sessionStart: true };
  },
  // Cursor documents additional_context on postToolUse, and its hooks accept and log
  // it, but open upstream reports say it is not surfaced to the model. Emitting costs
  // nothing and starts working when that is fixed.
  midTurnContext(text) {
    return { additional_context: text };
  },
};
```

Create `src/cli/agents/hosts/claude-desktop.ts`:

```typescript
import type { HostIdentity, HostProfile } from './profile.js';
import { hostString } from './profile.js';

/**
 * Claude Desktop is an MCP-only host: it has no lifecycle hook channel, so it
 * registers no events and can receive no injected context. It is still a HookHost
 * because `knowl init` configures its MCP server.
 */
export const claudeDesktopProfile: HostProfile = {
  host: 'claude-desktop',
  hookEvents: [],
  promptEvent: undefined,
  sharesSessionBinding: false,
  nativeOutput: true,
  identity(raw): HostIdentity {
    return {
      externalSessionId: hostString(raw.session_id) ?? hostString(raw.conversation_id),
      externalTurnId: hostString(raw.turn_id),
    };
  },
  normalizedEvent() {
    return undefined;
  },
  isShellEvent() {
    return false;
  },
  startContext() {
    return undefined;
  },
  midTurnContext() {
    return undefined;
  },
};
```

Create `src/cli/agents/hosts/generic.ts`:

```typescript
import type { NormalizedHookEventName } from '../host-hook.js';
import type { HostIdentity, HostProfile } from './profile.js';
import { hostString, toolNameIsShell } from './profile.js';

const GENERIC_EVENTS: NormalizedHookEventName[] = [
  'session-start', 'turn-start', 'session-event', 'checkpoint', 'turn-stop', 'session-stop',
];

/**
 * The host-neutral contract: callers send normalized event names directly and read
 * the lifecycle result as JSON, so there is no envelope to build.
 */
export const genericProfile: HostProfile = {
  host: 'generic',
  hookEvents: GENERIC_EVENTS,
  promptEvent: undefined,
  sharesSessionBinding: false,
  nativeOutput: false,
  identity(raw): HostIdentity {
    return {
      externalSessionId: hostString(raw.sessionId),
      externalTurnId: hostString(raw.turnId),
    };
  },
  normalizedEvent(hostEvent) {
    return GENERIC_EVENTS.includes(hostEvent as NormalizedHookEventName)
      ? hostEvent as NormalizedHookEventName
      : undefined;
  },
  isShellEvent(_hostEvent, toolName) {
    return toolNameIsShell(toolName);
  },
  startContext() {
    return undefined;
  },
  midTurnContext() {
    return undefined;
  },
};
```

- [x] **Step 6: Create the registry**

Create `src/cli/agents/hosts/index.ts`:

```typescript
import type { HookHost } from '../host-hook.js';
import type { HostProfile } from './profile.js';
import { claudeProfile } from './claude.js';
import { codexProfile } from './codex.js';
import { cursorProfile } from './cursor.js';
import { claudeDesktopProfile } from './claude-desktop.js';
import { genericProfile } from './generic.js';

export type { HostIdentity, HostOutput, HostProfile } from './profile.js';

export const HOST_PROFILES: Record<HookHost, HostProfile> = {
  claude: claudeProfile,
  codex: codexProfile,
  cursor: cursorProfile,
  'claude-desktop': claudeDesktopProfile,
  generic: genericProfile,
};

export function hostProfile(host: HookHost): HostProfile {
  const profile = HOST_PROFILES[host];
  if (!profile) throw new Error(`Unsupported hook host: ${host}`);
  return profile;
}

export function isHookHost(value: string): value is HookHost {
  return Object.prototype.hasOwnProperty.call(HOST_PROFILES, value);
}
```

- [x] **Step 7: Run the conformance test**

Run: `npx vitest run tests/cli/hosts/profile-conformance.test.ts`
Expected: PASS.

- [x] **Step 8: Confirm nothing else broke**

Run: `npm test`
Expected: PASS — this task only adds files.

- [x] **Step 9: Commit**

```bash
git add src/cli/agents/hosts tests/cli/hosts
git commit -m "feat(hosts): add a host profile per provider with a conformance suite"
```

---

### Task 2: Route normalization through profiles

**Files:**
- Modify: `src/cli/agents/host-hook.ts`
- Test: `tests/cli/host-hook.test.ts` (existing suite is the gate)

**Interfaces:**
- Consumes: `hostProfile`, `isHookHost` from `src/cli/agents/hosts/index.js`.
- Produces: no signature changes. `normalizeHostHook(host, eventName, raw)` keeps its contract.

- [x] **Step 1: Replace identity extraction**

In `src/cli/agents/host-hook.ts`, delete `externalIds` and `agentIdentity`, and replace the
`AGENT_HOSTS` set with the registry. Add the import:

```typescript
import { hostProfile, isHookHost } from './hosts/index.js';
```

Replace the body of `normalizeHostHookUnchecked`'s opening lines:

```typescript
function normalizeHostHookUnchecked(host: string, eventName: string, raw: Record<string, unknown>): NormalizedHostHook {
  if (!isHookHost(host)) throw new Error(`Unsupported hook host: ${host}`);
  const normalizedHost = host as HookHost;
  const profile = hostProfile(normalizedHost);
  const projectRoot = requireProjectRoot(raw);
  const identity = profile.identity(raw);
  if (!identity.externalSessionId) throw new IncompleteHostHookPayloadError('Host hook payload requires a session id.');
  const ids = { externalSessionId: identity.externalSessionId, externalTurnId: identity.externalTurnId };
  const agent = {
    ...(identity.agentId ? { agentId: identity.agentId } : {}),
    ...(identity.agentType ? { agentType: identity.agentType } : {}),
  };
  const event = profile.normalizedEvent(eventName);
  if (!event) throw new Error(`Unsupported ${normalizedHost} hook event: ${eventName}`);
  if (normalizedHost === 'generic') return normalizeGeneric(event, raw, projectRoot, ids);
  ...
}
```

Delete the `eventMap` ternary entirely — `profile.normalizedEvent` replaces it.

Keep the single `normalizedHost === 'generic'` dispatch to `normalizeGeneric`: the generic
payload contract genuinely differs, and the spec permits this one call. Change
`normalizeGeneric`'s first parameter from a raw event name to the already-normalized
`NormalizedHookEventName`, deleting its internal `allowed` list since
`profile.normalizedEvent` has already validated it.

- [x] **Step 2: Route shell detection through the profile**

In `toolEvent`, replace the `isShell` ternary:

```typescript
  const isShell = hostProfile(host).isShellEvent(eventName, toolName);
```

- [x] **Step 3: Run the hook suite**

Run: `npx vitest run tests/cli/host-hook.test.ts`
Expected: PASS, all 20 tests. Behaviour is unchanged; only the routing moved.

- [x] **Step 4: Confirm the generic and lifecycle suites**

Run: `npx vitest run tests/cli/agent-lifecycle.test.ts tests/store/host-lifecycle.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/cli/agents/host-hook.ts
git commit -m "refactor(hooks): resolve identity and event mapping from host profiles"
```

---

### Task 3: Route lifecycle output through profiles

**Files:**
- Modify: `src/store/host-lifecycle.ts`
- Test: `tests/store/host-lifecycle.test.ts`

**Interfaces:**
- Consumes: `hostProfile` from `src/cli/agents/hosts/index.js`; `renderChangeCard` from `src/cli/agents/change-card.js`.
- Produces: no signature change to `handleHostLifecycleEvent`. `HostLifecycleResult` is unchanged.

This is where Codex and Cursor start receiving the change card.

- [x] **Step 1: Write the failing test**

Append to `tests/store/host-lifecycle.test.ts`:

```typescript
  it('delivers the change card to every host with a mid-turn channel', async () => {
    const hosts: Array<{ host: 'claude' | 'codex' | 'cursor'; expected: (output: any) => void }> = [
      { host: 'claude', expected: o => expect(o.hookSpecificOutput.hookEventName).toBe('PostToolUse') },
      { host: 'codex', expected: o => expect(o.hookSpecificOutput.hookEventName).toBe('PostToolUse') },
      { host: 'cursor', expected: o => expect(o.additional_context).toContain('KNOWL CHANGED') },
    ];

    for (const { host, expected } of hosts) {
      const session = `multi-${host}`;
      await handleHostLifecycleEvent(projectId, hook({
        host, event: 'session-event', type: 'checkpoint', externalSessionId: session,
        externalTurnId: 'turn-1', payload: { summary: `${host} warmup` },
      }));

      await repo.createKnowledgeCommit(projectId, `Sibling for ${host}`, [
        { itemId: `multi-${host}-1`, action: 'insert', after: { id: `multi-${host}-1`, category: 'fact', title: `Fact for ${host}` } },
      ]);

      const result = await handleHostLifecycleEvent(projectId, hook({
        host, event: 'session-event', type: 'checkpoint', externalSessionId: session,
        externalTurnId: 'turn-1', payload: { summary: `${host} second tool` },
      }));

      expect(result.changes?.items.map(item => item.title), host).toEqual([`Fact for ${host}`]);
      expect(result.hostOutput, host).toBeDefined();
      expected(result.hostOutput);
    }
  });

  it('keeps hosts with no mid-turn channel silent while still reporting changes', async () => {
    for (const host of ['generic', 'claude-desktop'] as const) {
      const session = `silent-${host}`;
      await handleHostLifecycleEvent(projectId, hook({
        host, event: 'session-event', type: 'checkpoint', externalSessionId: session,
        externalTurnId: 'turn-1', payload: { summary: `${host} warmup` },
      }));

      await repo.createKnowledgeCommit(projectId, `Sibling for ${host}`, [
        { itemId: `silent-${host}-1`, action: 'insert', after: { id: `silent-${host}-1`, category: 'fact', title: `Quiet fact for ${host}` } },
      ]);

      const result = await handleHostLifecycleEvent(projectId, hook({
        host, event: 'session-event', type: 'checkpoint', externalSessionId: session,
        externalTurnId: 'turn-1', payload: { summary: `${host} second tool` },
      }));

      expect(result.changes?.items.map(item => item.title), host).toEqual([`Quiet fact for ${host}`]);
      expect(result.hostOutput, host).toBeUndefined();
    }
  });
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/store/host-lifecycle.test.ts`
Expected: FAIL — codex and cursor produce no `hostOutput` for the change card.

- [x] **Step 3: Replace `hostContextOutput` with the profile call**

In `src/store/host-lifecycle.ts`, add the import:

```typescript
import { hostProfile } from '../cli/agents/hosts/index.js';
```

Replace `hostContextOutput` entirely:

```typescript
function hostContextOutput(input: NormalizedHostHook, context: string | undefined): Record<string, unknown> | undefined {
  if (!context) return undefined;
  return hostProfile(input.host).startContext(input.event, context);
}
```

- [x] **Step 4: Replace the card and reminder branches**

Replace the trigger block's host checks so delivery is decided by the profile:

```typescript
      let hostOutput: Record<string, unknown> | undefined;
      let changes: ChangeSummary | undefined;
      if (input.event === 'session-event' && input.status !== 'failed') {
        const key = bindingKey(input, 'turn');
        const profile = hostProfile(input.host);
        changes = await evaluateChangeNotification(input, key);
        if (changes) {
          // Change news implies "go query", so it replaces the drift nudge and resets
          // the counter. Hosts with no mid-turn channel get undefined and stay silent.
          await resetHostSuccessfulToolCount(key);
          hostOutput = profile.midTurnContext(renderChangeCard(changes));
        } else if (profile.midTurnContext('') !== undefined) {
          if (input.knowlTool) {
            await resetHostSuccessfulToolCount(key);
          } else {
            const drift = await incrementHostSuccessfulToolCount(key);
            if (drift > 0 && drift % KNOWL_REMINDER_DRIFT === 0) {
              hostOutput = profile.midTurnContext(KNOWL_CLAUDE_CONTINUATION_REMINDER);
            }
          }
        }
      }
      return { accepted: true, sessionId: started.session.id, hostOutput, ...(changes ? { changes } : {}) };
```

Replace the `createClaudeChangeCardOutput` and `createClaudePostToolReminderOutput` imports
with `renderChangeCard` from `../cli/agents/change-card.js` and
`KNOWL_CLAUDE_CONTINUATION_REMINDER` from `../core/knowl-guidance.js`. The envelope now comes
from the profile, so the two Claude-specific output builders are no longer needed here.

- [x] **Step 5: Replace the binding-semantics checks**

Two places test `codex || claude`. Replace both with the profile flag — at the `turn-start`
branch:

```typescript
    if (!sessionBinding && hostProfile(input.host).sharesSessionBinding) {
```

and at the `turn-stop` branch:

```typescript
    if (hostProfile(input.host).sharesSessionBinding && sessionBinding?.id === session.id) {
```

- [x] **Step 6: Run the lifecycle suite**

Run: `npx vitest run tests/store/host-lifecycle.test.ts`
Expected: PASS, including both new multi-host tests.

- [x] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add src/store/host-lifecycle.ts tests/store/host-lifecycle.test.ts
git commit -m "feat(lifecycle): deliver change cards to every host with a mid-turn channel"
```

---

### Task 4: Route hook config, reminder, and CLI through profiles

**Files:**
- Modify: `src/cli/agents/hook-config.ts`, `src/cli/agents/reminder.ts`, `src/index.ts`
- Test: `tests/cli/agent-adapters.test.ts`, `tests/cli/agent-reminder.test.ts` (existing gates)

**Interfaces:**
- Consumes: `hostProfile` from `src/cli/agents/hosts/index.js`.
- Produces: `CLAUDE_HOOK_EVENTS`, `CODEX_HOOK_EVENTS`, and `CURSOR_HOOK_EVENTS` are re-exported from `hook-config.ts` for existing importers, but now sourced from the profiles.

- [x] **Step 1: Source the event lists from profiles**

In `src/cli/agents/hook-config.ts`, replace the three event-list constants with re-exports so
there is one definition per host:

```typescript
import { hostProfile } from './hosts/index.js';

export const CODEX_HOOK_EVENTS = hostProfile('codex').hookEvents;
export const CLAUDE_HOOK_EVENTS = hostProfile('claude').hookEvents;
export const CURSOR_HOOK_EVENTS = hostProfile('cursor').hookEvents;
```

Replace both `host === 'codex' ? CODEX_HOOK_EVENTS : CLAUDE_HOOK_EVENTS` occurrences
(in `mergeNestedHookConfig` and `verifyNestedHookConfig`) with:

```typescript
  const events = hostProfile(host).hookEvents;
```

- [x] **Step 2: Drive the prompt reminder from the profile**

Still in `hook-config.ts`, replace the three `host === 'claude'` prompt-reminder checks with
the profile's `promptEvent`. Define once near the top of `mergeNestedHookConfig`:

```typescript
  const promptEvent = hostProfile(host).promptEvent;
```

then use `promptEvent ? ... : ...` in place of `host === 'claude' ? ... : ...`, and use
`promptEvent ?? CLAUDE_PROMPT_EVENT` as the config key so a host without a prompt event never
writes one. Do the same in `verifyNestedHookConfig`.

- [x] **Step 3: Generalize the reminder builder**

In `src/cli/agents/reminder.ts`, replace the Claude-only guard:

```typescript
export function createAgentReminderOutput(host: string): HostOutput {
  if (!isHookHost(host)) throw new Error(`Unsupported reminder host: ${host}`);
  const profile = hostProfile(host);
  if (!profile.promptEvent) throw new Error(`Unsupported reminder host: ${host}`);
  const output = profile.startContext('turn-start', KNOWL_CLAUDE_PROMPT_REMINDER);
  if (!output) throw new Error(`Unsupported reminder host: ${host}`);
  return output;
}
```

Add `import { hostProfile, isHookHost, HostOutput } from './hosts/index.js';`. The error
message stays byte-identical so `tests/cli/agent-reminder.test.ts` still passes.

- [x] **Step 4: Drive CLI output from the profile**

In `src/index.ts`, replace the `agent-hook` output line:

```typescript
      if (result.hostOutput) console.log(JSON.stringify(result.hostOutput));
      else if (!hostProfile(normalized.host).nativeOutput) console.log(JSON.stringify(result));
```

Add `import { hostProfile } from './cli/agents/hosts/index.js';` to the imports.

- [x] **Step 5: Verify no host conditionals remain in the core**

Run:

```bash
grep -rn "host === '\|host !== '\|normalizedHost === '" src/ | grep -v "src/cli/agents/hosts/" | grep -v "project-adapters.ts"
```

Expected: only the single `normalizedHost === 'generic'` dispatch in `host-hook.ts`, which the
spec permits. Anything else is a miss — fix it before committing.

- [x] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add src/cli/agents/hook-config.ts src/cli/agents/reminder.ts src/index.ts
git commit -m "refactor(hosts): drive hook config, reminders, and CLI output from profiles"
```

---

### Task 5: Codex end to end

**Files:**
- Create: `tests/cli/codex-subagent-notification.test.ts`
- Test: the new file

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: nothing new; this is a verification task.

Codex now registers `SubagentStart`/`SubagentStop` because they are in `codexProfile.hookEvents`,
so `knowl init codex` writes them. This task proves the whole chain works for Codex the way
`tests/cli/claude-subagent-notification.test.ts` proves it for Claude.

- [x] **Step 1: Write the end-to-end test**

Create `tests/cli/codex-subagent-notification.test.ts`:

```typescript
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CODEX_HOOK_EVENTS } from '../../src/cli/agents/hook-config.js';

const TEST_DIR = path.resolve('./.knowl-codex-subagent-notification-test');
const CLI_PATH = path.resolve('./dist/index.js');

function run(args: string[], input?: string): string {
  return execFileSync(process.execPath, [CLI_PATH, ...args], { cwd: TEST_DIR, encoding: 'utf8', input });
}

const post = (sessionId: string, agentId: string | undefined, toolName: string, toolInput: unknown) =>
  run(['agent-hook', 'codex', 'PostToolUse', '--json'], JSON.stringify({
    session_id: sessionId,
    turn_id: 'turn-1',
    cwd: TEST_DIR,
    ...(agentId ? { agent_id: agentId, agent_type: 'reviewer' } : {}),
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: { exit_code: 0 },
  }));

describe('Codex subagent change notification CLI', () => {
  beforeAll(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
    await fs.mkdir(TEST_DIR, { recursive: true });
    run(['init', 'codex', '--yes']);
    run(['decide', 'Codex project uses local memory', 'Knowl stores project memory locally.']);
  }, 120_000);

  afterAll(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it('registers the subagent events for Codex', () => {
    expect(CODEX_HOOK_EVENTS).toContain('SubagentStart');
    expect(CODEX_HOOK_EVENTS).toContain('SubagentStop');
  });

  it('bootstraps a Codex subagent and notifies it of a sibling write', () => {
    run(['agent-hook', 'codex', 'SessionStart', '--json'], JSON.stringify({
      session_id: 'codex-e2e', turn_id: 'turn-1', cwd: TEST_DIR,
    }));

    const bootstrap = run(['agent-hook', 'codex', 'SubagentStart', '--json'], JSON.stringify({
      session_id: 'codex-e2e', turn_id: 'turn-1', cwd: TEST_DIR,
      agent_id: 'codex-agent', agent_type: 'reviewer',
    }));
    expect(JSON.parse(bootstrap).hookSpecificOutput.hookEventName).toBe('SubagentStart');

    expect(post('codex-e2e', 'codex-agent', 'shell', { command: 'ls' })).toBe('');

    run(['decide', 'A sibling decided something for Codex', 'Stored by another agent.']);

    const notified = post('codex-e2e', 'codex-agent', 'read_file', { path: 'README.md' });
    const context = JSON.parse(notified).hookSpecificOutput.additionalContext as string;
    expect(context).toContain('KNOWL CHANGED: 1 item since you last looked.');
    expect(context).toContain('- decision: A sibling decided something for Codex');

    expect(post('codex-e2e', 'codex-agent', 'read_file', { path: 'LICENSE' })).toBe('');
  }, 120_000);

  it('closes the Codex subagent binding on SubagentStop', () => {
    expect(run(['agent-hook', 'codex', 'SubagentStop', '--json'], JSON.stringify({
      session_id: 'codex-e2e', turn_id: 'turn-1', cwd: TEST_DIR,
      agent_id: 'codex-agent', agent_type: 'reviewer',
    }))).toBe('');
  }, 120_000);
});
```

- [x] **Step 2: Build and run it**

Run: `npm run build && npx vitest run tests/cli/codex-subagent-notification.test.ts`
Expected: PASS. If `SubagentStart` returns empty, the payload allowlist in
`src/cli/agents/lifecycle.ts` is dropping a Codex identity field — check `ROOT_FIELDS`
contains `agent_id` and `agent_type`.

- [x] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS.

- [x] **Step 4: Commit**

```bash
git add tests/cli/codex-subagent-notification.test.ts
git commit -m "test(codex): cover subagent bootstrap and change notification end to end"
```

---

### Task 6: Live Codex verification and docs

**Files:**
- Modify: `README.md`, `CHANGELOG.md`
- Create: a scratch project outside the repo for the live run

**Interfaces:**
- Consumes: everything above.
- Produces: documentation matching the shipped behaviour.

- [x] **Step 1: Drive the real Codex CLI**

Create a scratch project, register Knowl for Codex, and run `codex` with a cheap model and a
prompt that forces a tool call. Use `codex exec` for a non-interactive run:

```bash
mkdir -p /tmp/knowl-codex-live && cd /tmp/knowl-codex-live
node <repo>/dist/index.js init codex --yes
node <repo>/dist/index.js decide "Live codex check" "Seeded so bootstrap has content."
codex exec --model gpt-5.4-codex-mini "List the files in this directory using a shell command, then stop."
```

Confirm from the run that Knowl's hooks fired without error. Then verify the effect in the
database rather than by reading model output:

```bash
node -e "
const {createClient}=require('@libsql/client');
(async()=>{const c=createClient({url:'file:.knowl/knowl.db'});
const r=await c.execute(\"SELECT external_turn_id, active, successful_tool_count, seen_commit_rowid FROM host_session_bindings WHERE host='codex'\");
console.table(r.rows);})();
"
```

Expected: at least one active `codex` binding row with a non-zero `seen_commit_rowid`,
proving the watermark path ran under a real Codex session. If `codex exec` rejects the model
name, run `codex --help` and pick the smallest available model.

- [x] **Step 2: Record what the live run proved**

Store the outcome with `knowl_store` as a `fact`, naming which Codex events were observed and
whether the card was accepted. If the live run contradicts the binary evidence, the profile's
`midTurnContext` must return `undefined` for Codex and the README must say so — correctness
outranks the plan.

- [x] **Step 3: Update the README**

In `README.md`, revise the `### Subagent memory & change notification` host-coverage
paragraph. Replace the Codex/Cursor "watermark only" sentence with the verified position:
Claude Code and Codex CLI both receive the card via `hookSpecificOutput.additionalContext`;
Cursor is sent `additional_context` but upstream currently does not surface it; Claude Desktop
and Gemini have no hook channel and stay MCP-only. Keep the paragraph free of version numbers.

Also update `### Agent lifecycle automation` so `SubagentStart` is not described as
Claude-only.

- [x] **Step 4: Update the CHANGELOG**

Add to the `## 2.1.0` entry's `### Added` section:

```markdown
- **Host profiles.** Each supported host is described by one profile in
  `src/cli/agents/hosts/`, so identity extraction, event mapping, and context envelopes are
  declared per host instead of branched on at call sites. Adding a host is adding a file.
- **Change notification beyond Claude.** Codex CLI receives subagent bootstrap and change
  cards through the same `hookSpecificOutput.additionalContext` channel. Cursor is sent
  `additional_context`. Hosts with no hook channel continue to read `changes` from the
  host-neutral JSON result.
```

Add to `### Fixed`:

```markdown
- **`claude-desktop` was routed through Cursor's hook event map.** The event-mapping ternary
  only checked Codex and Claude by name, so every other host fell through to Cursor's
  camelCase events. Each host now declares its own map.
```

- [x] **Step 5: Run the full suite and commit**

```bash
npm test
git add README.md CHANGELOG.md
git commit -m "docs: document host profiles and multi-provider change notification"
```

---

## Spec coverage

| Spec requirement | Task |
| --- | --- |
| `HostProfile` interface, capability by return value | 1 |
| One file per host, registry | 1 |
| Conformance suite across all profiles | 1 |
| `claude-desktop` fallthrough regression test | 1 |
| Identity extraction via profile | 2 |
| Event mapping via profile | 2 |
| Shell-event detection via profile | 2 |
| Start-context envelope via profile | 3 |
| Mid-turn card and reminder via profile | 3 |
| Binding semantics via profile | 3 |
| Hook event lists and prompt reminder via profile | 4 |
| CLI native-output decision via profile | 4 |
| Zero remaining host conditionals in core | 4 (Step 5 verifies) |
| Codex end-to-end coverage | 5 |
| Live Codex run | 6 |
| Cursor emitted despite upstream bug | 1 (`cursor.ts`), 3 (test asserts it) |
| Claude Desktop / Gemini remain MCP-only | 1 |
| `project-adapters.ts` left alone | not implemented, by design |
