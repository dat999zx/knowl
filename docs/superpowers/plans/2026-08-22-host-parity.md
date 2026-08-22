# Host Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every AI coding host Knowl can reach gets every capability that host's wire actually supports, with the Claude-only capabilities (`denyToolCall`, `stopContext`, prompt card) extended to every host that has a channel for them.

**Architecture:** `HostProfile` already routes host differences through one file per provider and core never branches on host name. This plan widens it along two axes the contract cannot express (refusal by process exit status, hook-config file shape), corrects the Codex profile against the shipped binary, adds four profiles and two MCP-only adapters, and makes the MCP `instructions` card host-aware.

**Tech Stack:** TypeScript (ESM, NodeNext), SQLite via `better-sqlite3`, Vitest, MCP SDK.

**Spec:** Knowl memory `966420b49e2447b8` (roadmap), corrected by the fact-check and correctness reviews of 2026-08-22 recorded alongside it. **This revision supersedes the first draft; five of its six external host claims were wrong.** Read the "Corrections" section below before any task.

## Global Constraints

- **Capability is expressed by return value, not a parallel boolean.** A host that cannot receive something returns `undefined`. Never add a flag that can claim support the envelope does not deliver.
- **`midTurnDeliveryVerified` is true only when an upstream release is confirmed to surface the envelope to the model.** Vendor documentation asserting delivery is evidence about the schema, not about delivery.
- **Never declare a `hookEvent` a host does not implement.** A name the host does not know is a dead entry in its config file. This plan removes two such entries and must not add more.
- **An event may be in `hookEvents` **or** be the `promptEvent`, never both.** See Correction 7 — the merge writes the lifecycle handler and then overwrites that same key with the reminder, and `verifyNestedHookConfig` then fails forever in a way re-running `knowl init` cannot clear.
- **The hook process exits 0 on hosts that read a stdout verdict, and never exits 1 on a host that treats any non-zero status as a refusal.** Both directions fail silently and in opposite ways.
- **Every failure in the write gate allows the write** — except where the host makes that impossible (Copilot), which Task 4 handles explicitly rather than by hoping.
- Verification for every task: `npm.cmd run typecheck && npm.cmd run lint && npm.cmd test`.

## Corrections applied to the first draft

Established 2026-08-22 by direct inspection and by primary-source review. Each of these invalidated a task as originally written.

1. **OpenHands hooks are `.openhands/hooks.json` — JSON, not YAML.** The `yaml-matcher` config style and `mergeYamlHookConfig` are deleted from this plan; they had exactly one intended user and it does not use YAML. OpenHands also accepts a JSON verdict `{"decision":"deny","reason":…}` which *overrides* the exit code, so it gets both channels.
2. **Antigravity's file shape is one level deeper than Claude's**: `{"<hook-name>": {"PreToolUse": [{"matcher":…, "hooks":[…]}]}}` at `.agents/hooks.json` (workspace) or `~/.gemini/config/hooks.json` (global). It has 5 events — `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop` — and denies with `{"decision":"deny","reason":…}`, not `permissionDecision`. Reusing `nested-json` would have written a file Antigravity cannot read.
3. **Windsurf (now Devin Desktop) has 12 snake_case events of its own vocabulary** — `pre_run_command`, `pre_write_code`, `pre_mcp_tool_use`, `pre_user_prompt`, `post_cascade_response` and others — at `.windsurf/hooks.json`. It denies on **exit code 2 only**, with no JSON verdict, and **has no stop event at all**.
4. **Cline cannot be a `HookHost`.** It has no hooks file and no shell-command channel: hooks are TypeScript objects (`AgentPlugin` from `@cline/sdk`, methods `beforeRun`/`afterRun`/`beforeModel`/`afterModel`/`beforeTool`/`afterTool`/`onEvent`) loaded into its runtime. Integrating would mean publishing an npm plugin, which is a separate product decision. Cline gets an MCP adapter and no profile.
5. **Copilot is camelCase, has no `SubagentStart`, and its hooks file needs `"version": 1`.** Its MCP config is `.mcp.json` / `.github/mcp.json` / `~/.copilot/mcp-config.json` — `.github/copilot/mcp.json` does not exist. **Critically: Copilot treats any non-zero exit other than 2 as a denial.** A crashed `knowl agent-hook` would block the user's edit.
6. **Cursor is unchanged.** `additional_context` on `postToolUse` is still not surfaced to the model (vendor ticket T-C20310, reconfirmed 2026-06-15). `midTurnDeliveryVerified` stays `false`.
7. **`hookEvents` + `promptEvent` collide.** In `mergeNestedHookConfig`, the event loop writes `nextHooks[event]`, then the prompt block overwrites `nextHooks[promptEvent]` with an array rebuilt from the *original* `hooks` map — dropping the lifecycle handler. Claude escapes only because `CLAUDE_HOOK_EVENTS` deliberately omits `UserPromptSubmit`. Every new host must do the same.
8. **The prompt reminder command is hardcoded to Claude.** `reminderEntry` builds `agent-reminder claude` and `ownsReminderCommand` matches only `' agent-reminder claude '`, so a second host with a prompt event writes a command Knowl cannot later recognise as its own.
9. **Nothing removes retired hook events.** `mergeNestedHookConfig` copies unknown keys through and `verifyNestedHookConfig` only checks for presence, so `PostToolUseFailure`/`StopFailure` survive in every existing `.codex/hooks.json`. The mechanism already exists one file over: `RETIRED_CURSOR_EVENTS`.
10. **`verifyNestedHookConfig` reads `CLAUDE_PROMPT_EVENT` instead of the host's own `promptEvent`** — a live bug for any host whose prompt event is named differently.
11. **The MCP capture nudge cannot fire and is cut.** `capture_outcomes.turns` is incremented only from the hook path, and the MCP channel has no `externalSessionId` to build a `conversationKey` from. On a genuinely MCP-only host the row never exists. It would also have added a second suppression predicate beside `midTurnDeliveryVerified` in the same file — the exact trap that flag was created to close.
12. **`equalEntry` compares MCP args positionally**, so adding `--host` to `commandEntry` reports every existing install as unconfigured. Task 9 tolerates a trailing `--host` pair instead.
13. **Ordering.** `hookConfigStyle` must land in Task 1, not Task 3, or Task 2's profile literal fails the excess-property check.

## Verified facts about Codex

By string inspection of the shipped `codex.exe` (codex-cli 0.147.0, win32-x64) on 2026-08-22:

- Present: `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `permissionDecision`, `permissionDecisionReason`, `hookSpecificOutput`, `additionalContext`.
- **Absent: `PostToolUseFailure`, `StopFailure`** — both currently declared, both dead in every config Knowl has written.
- Codex normalises PascalCase to snake_case for its own trust keys (`~/.codex/config.toml` `[hooks.state.'…:post_tool_use:0:0']`), so PascalCase registration is correct.
- Codex hooks are behind `[features].codex_hooks = true` and are **not available on Windows**, so the deny/stop paths are declared from the binary's symbols, not an end-to-end run.

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/core/host-hook-types.ts` | `HookHost` union | Modify — `+copilot, openhands, antigravity, windsurf` |
| `src/session/hosts/profile.ts` | Capability contract | Modify — `denyExitCode`, `refusesOnAnyNonZeroExit`, `hookConfigStyle` |
| `src/session/hosts/claude.ts` | Claude profile + shared Anthropic envelopes | Modify — export `anthropicDenyToolCall`/`anthropicStopContext` |
| `src/session/hosts/codex.ts` | Codex profile | Modify — correct event list, add deny/stop/prompt |
| `src/session/hosts/copilot.ts` | Copilot profile | Create |
| `src/session/hosts/openhands.ts` | OpenHands profile | Create |
| `src/session/hosts/antigravity.ts` | Antigravity profile | Create |
| `src/session/hosts/windsurf.ts` | Windsurf profile | Create |
| `src/session/hosts/index.ts` | Profile registry | Modify |
| `src/session/host-lifecycle.ts` | Lifecycle engine | Modify — `denied?: string` |
| `src/cli/agent-hook.ts` | Hook process entry | Modify — exit-code refusal, fail-open guard |
| `src/cli/agents/hook-config.ts` | Config merge/verify | Modify — style routing, retired events, host-generic reminder |
| `src/cli/agents/types.ts`, `registry.ts`, `project-adapters.ts` | Adapters | Modify — add 5, drop gemini |
| `src/mcp/server.ts`, `src/cli/program.ts`, `src/core/knowl-guidance.ts` | Host-aware instructions | Modify |
| `docs/hosts.md` | Capability matrix + ACP deferral | Create |

---

### Task 1: Widen the profile contract

Three fields, all optional or defaulted, none changing existing behaviour. They land together because Task 2's profile literal needs `hookConfigStyle` and the excess-property check does not care that a later task was going to add it.

**Files:** Modify `src/session/hosts/profile.ts`, `src/session/host-lifecycle.ts`, `src/cli/agent-hook.ts`, all five existing profiles. Test: `tests/cli/hosts/profile-conformance.test.ts`.

**Interfaces:**
- Produces: `HostProfile.denyExitCode?: number`, `HostProfile.refusesOnAnyNonZeroExit?: true`, `HostProfile.hookConfigStyle`, `HostLifecycleResult.denied?: string`.

- [ ] **Step 1: Write the failing test**

```ts
it('a profile that refuses by exit status also renders a reason', () => {
  for (const profile of Object.values(HOST_PROFILES)) {
    if (profile.denyExitCode === undefined) continue;
    expect(profile.denyExitCode).toBeGreaterThan(0);
    expect(typeof profile.denyToolCall).toBe('function');
  }
});

it('a host that registers hook handlers declares the shape of the file they go in', () => {
  for (const profile of Object.values(HOST_PROFILES)) {
    // `generic` declares events so third-party callers can send them, but `knowl init`
    // never writes a file for it -- it is invoked directly, never installed.
    const installs = profile.hookEvents.length > 0 && profile.host !== 'generic';
    expect(profile.hookConfigStyle === 'none').toBe(!installs);
  }
});
```

- [ ] **Step 2: Run it, watch it fail** — `npm.cmd test -- tests/cli/hosts/profile-conformance.test.ts`. Expected: tsc errors, properties do not exist.

- [ ] **Step 3: Add the three fields to `HostProfile`**

```ts
  /**
   * The shape of the file `knowl init` writes this host's handlers into.
   *
   * A shape, not a host name: Claude and Codex share one, and Copilot, Antigravity and
   * Windsurf each need a different one for reasons that are about the file rather than about
   * the vendor -- Copilot wants a `version` key, Antigravity nests a hook *name* above the
   * event, Windsurf takes a flat command list. Keying the merge here is what keeps adding a
   * host to one file; the alternative is a widening union in three function signatures.
   *
   * `none` is a real value rather than `undefined` so a profile that simply forgot to declare
   * a shape fails conformance instead of silently registering nothing.
   */
  readonly hookConfigStyle: 'claude-nested' | 'copilot-nested' | 'antigravity-nested' | 'cursor-flat' | 'openhands-flat' | 'windsurf-flat' | 'none';

  /**
   * The process exit status this host reads as a refusal, when its deny channel is the exit
   * code rather than stdout.
   *
   * Two conventions, opposite rules, both failing silently. Claude Code and Codex read a
   * `PreToolUse` verdict from stdout **only on exit 0** -- a non-zero exit reads as a crashed
   * hook and the verdict is discarded, so the tool runs. Windsurf has no stdout verdict at all
   * and blocks on **exit 2**, so returning JSON and exiting 0 there allows the write while
   * reporting a block. OpenHands accepts both and lets the JSON win.
   */
  readonly denyExitCode?: number;

  /**
   * True when this host treats *any* unexpected non-zero exit as a refusal.
   *
   * Copilot does: its reference states a non-zero exit other than 2 denies the tool call. That
   * inverts this codebase's default failure direction -- everywhere else a broken hook allows
   * the write, and here a broken hook blocks the user's edit with no reason attached. The hook
   * entry reads this to suppress its own error exit, so a crash degrades to "Knowl recorded
   * nothing this call" instead of "you cannot edit this file".
   */
  readonly refusesOnAnyNonZeroExit?: true;
```

Add `hookConfigStyle` to all five existing profiles: `claude`/`codex` → `'claude-nested'`, `cursor` → `'cursor-flat'`, `claude-desktop`/`generic` → `'none'`.

- [ ] **Step 4: Carry the reason, not a boolean, on the result**

In `src/session/host-lifecycle.ts` add to `HostLifecycleResult`:

```ts
  /**
   * The refusal text, present only when this result *is* a deliverable refusal.
   *
   * The reason rather than a flag, so a host whose deny channel carries no JSON renders the
   * same string the envelope carries and the two channels cannot drift. Set only when
   * `denyToolCall` actually produced an envelope: a host that declines to produce one degrades
   * to allowing the write, and a bare boolean would have turned that documented degradation
   * into a block with an invented reason.
   */
  denied?: string;
```

and in `runWriteGate` replace the refusal return with:

```ts
    const envelope = denyToolCall(decision.reason);
    if (!envelope) return { accepted: true, sessionId: session.id };
    return { accepted: true, sessionId: session.id, denied: decision.reason, hostOutput: envelope };
```

- [ ] **Step 5: Teach the hook entry both exit conventions**

In `src/cli/agent-hook.ts`, **keeping the existing comment block about `anthropics/claude-code#37210` verbatim** (it is the reason the exit-0 rule survives refactors), replace the output block with:

```ts
    const profile = hostProfile(normalized.host);
    if (result.hostOutput) console.log(JSON.stringify(result.hostOutput));
    else if (!profile.nativeOutput) console.log(JSON.stringify(result));
    await closeDb();

    // The deny channel the host declared, rather than one assumed for all of them.
    if (result.denied !== undefined && profile.denyExitCode !== undefined) {
      console.error(result.denied);
      process.exitCode = profile.denyExitCode;
    }
    return;
```

and in the `catch`, before the existing `process.exit(1)`:

```ts
    // A host that reads any non-zero status as a refusal must never see one from a crash --
    // that turns a Knowl bug into a block on somebody's edit, with no reason attached. The
    // error still goes to stderr; only the status is suppressed.
    if (isHookHost(host) && hostProfile(host).refusesOnAnyNonZeroExit) return;
```

- [ ] **Step 6: Run** — `npm.cmd run typecheck && npm.cmd test -- tests/cli/hosts tests/store/write-gate.test.ts`. Expected: PASS.

- [ ] **Step 7: Commit** — `git commit -am "feat(hosts): declare hook-config shape and refusal-by-exit-status on the profile"`

---

### Task 2: Correct the Codex profile against the shipped binary

**Files:** Modify `src/session/hosts/claude.ts`, `src/session/hosts/codex.ts`, `src/cli/agents/hook-config.ts`. Test: `tests/cli/tool-precheck.test.ts`, `tests/cli/agent-adapters.test.ts`, `tests/cli/hosts/profile-conformance.test.ts`.

**Interfaces:**
- Produces: `anthropicDenyToolCall(reason)`, `anthropicStopContext(reason)`, `PASCAL_EVENT_MAP_WITH_PRETOOL` — consumed by Task 4.

**Note the three tests this task invalidates** (all assert the old, wrong behaviour and must be rewritten, not worked around):
`tests/cli/tool-precheck.test.ts:183-190` (`expect(config.hooks.PreToolUse).toBeUndefined()` for codex), `tests/cli/tool-precheck.test.ts:127-132` (codex listed among hosts with no refusal channel), `tests/cli/agent-adapters.test.ts:200` (`expect(codexHooks.hooks.UserPromptSubmit).toBeUndefined()`).

- [ ] **Step 1: Write the failing test**

```ts
it('codex declares exactly the lifecycle events codex 0.147.0 implements', () => {
  expect([...hostProfile('codex').hookEvents]).toEqual([
    'SessionStart', 'SubagentStart', 'PreToolUse', 'PostToolUse',
    'PreCompact', 'Stop', 'SubagentStop', 'SessionEnd',
  ]);
  // The prompt event is registered by the reminder block, never as a lifecycle handler.
  expect(hostProfile('codex').hookEvents).not.toContain('UserPromptSubmit');
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
```

> `PostCompact` is **deliberately not registered** even though Codex has it: it maps to the same normalized `checkpoint` as `PreCompact`, and registering both writes two checkpoint rows per compaction. `PermissionRequest` is likewise **not** registered — it would normalize to `tool-precheck` and be answered with an envelope naming `hookEventName: "PreToolUse"`, so the write would land while the caller was told it was blocked.

- [ ] **Step 2: Run it, watch it fail** — event list mismatch, `denyToolCall` undefined.

- [ ] **Step 3: Extract the shared envelopes in `claude.ts`**

Add `PASCAL_EVENT_MAP_WITH_PRETOOL = { ...PASCAL_EVENT_MAP, PreToolUse: 'tool-precheck' }`, and:

```ts
/** Claude Code's documented refusal envelope, shared by every host that reuses the route. */
export function anthropicDenyToolCall(reason: string): HostOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason,
    },
  };
}

/** Claude Code's documented Stop shape: top-level decision/reason, not `hookSpecificOutput`. */
export function anthropicStopContext(reason: string): HostOutput {
  return { decision: 'block', reason };
}
```

Rewrite `claudeProfile.denyToolCall`/`stopContext` as delegations, **keeping their existing doc comments in place**. Replace the `CLAUDE_EVENT_MAP` comment, which asserts codex has no `PreToolUse` — true at 0.145.0, false at 0.147.0 — with a note recording both.

- [ ] **Step 4: Rewrite `codex.ts`** with `hookEvents` as in Step 1, `promptEvent: 'UserPromptSubmit'`, `hookConfigStyle: 'claude-nested'`, `normalizedEvent` on `PASCAL_EVENT_MAP_WITH_PRETOOL`, `denyToolCall: anthropicDenyToolCall`, `stopContext: anthropicStopContext`, and a header comment recording the binary inspection, the two removed events, and the Windows/feature-flag caveats.

- [ ] **Step 5: Retire the dead events from existing configs**

In `hook-config.ts`, generalise the cursor mechanism:

```ts
/**
 * Events Knowl used to register and no longer does, per host.
 *
 * The merge copies unknown keys through and `verify` only checks that declared events are
 * present, so a handler for an event we stopped declaring survives every re-init and every
 * `doctor --fix` -- silently, because nothing looks for extras. `PostToolUseFailure` and
 * `StopFailure` were declared for codex for years and have never existed in any codex build.
 */
const RETIRED_HOOK_EVENTS: Partial<Record<HookHost, readonly string[]>> = {
  cursor: ['beforeSubmitPrompt'],
  codex: ['PostToolUseFailure', 'StopFailure'],
};
```

and strip them in `mergeNestedHookConfig` the way `mergeCursorHookConfig` already does, with `verifyNestedHookConfig` asserting their absence.

- [ ] **Step 6: Make the prompt reminder host-generic**

`knowlReminderCommand(platform, host: HookHost)` and `ownsReminderCommand(value, host)` take the host; `reminderEntry(platform, host)` passes it through. Confirm `src/cli/agents/reminder.ts` already accepts a host argument (it does) and that `program.ts` registers `agent-reminder <host>`.

- [ ] **Step 7: Fix `verifyNestedHookConfig`'s prompt-event key**

It reads `CLAUDE_PROMPT_EVENT`; make it read `hostProfile(host).promptEvent`. Independent of everything else in this task and a live bug for cursor today.

- [ ] **Step 8: Run** — `npm.cmd run typecheck && npm.cmd run lint && npm.cmd test`. Rewrite the three tests named above; do not exempt them.

- [ ] **Step 9: Verify against the real file** — `node dist/index.js init codex && cat .codex/hooks.json`. Expected: no `PostToolUseFailure`; `PreToolUse` and `SessionEnd` present; `UserPromptSubmit` holds exactly one `agent-reminder codex` handler and no lifecycle handler.

- [ ] **Step 10: Commit** — `git commit -am "fix(codex): declare the events codex 0.147.0 has, retire the two it never had"`

---

### Task 3: Route hook-config on the declared shape

**Files:** Modify `src/cli/agents/hook-config.ts`, `src/cli/agents/project-adapters.ts`, `src/cli/agents/cursor.ts`.

**Interfaces:**
- Produces: `mergeHookConfig(configPath, platform, host)`, `verifyHookConfig(configPath, platform, host)` for any `HookHost`.

- [ ] **Step 1: Write the failing test** — assert `mergeHookConfig` writes a `version: 1` key for `copilot` and a bare `hooks` object for `codex`, into a temp dir.

- [ ] **Step 2: Run it, watch it fail** — function does not exist.

- [ ] **Step 3: Widen `mergeNestedHookConfig`/`verifyNestedHookConfig`/`nestedEntry` from `host: 'codex' | 'claude'` to `host: HookHost`.** The bodies already read `hostProfile(host)`.

- [ ] **Step 4: Guard the prompt block**

Wrap the whole prompt-entry section in `if (hostProfile(host).promptEvent) { … }` — **not an early `return`**, which would skip `writeWithBackup` and register no handlers at all. Delete the `CLAUDE_PROMPT_EVENT` fallback: with the constraint that no host declares its prompt event in `hookEvents`, a host without a `promptEvent` must not have Claude's name substituted. Keep the legacy-handler cleanup by moving those event names into `RETIRED_HOOK_EVENTS`.

- [ ] **Step 5: Add the dispatchers**

```ts
export async function mergeHookConfig(configPath: string, platform: NodeJS.Platform, host: HookHost): Promise<MergeStatus> {
  switch (hostProfile(host).hookConfigStyle) {
    case 'none': return 'unchanged';
    case 'cursor-flat': return mergeCursorHookConfig(configPath, platform);
    case 'copilot-nested': return mergeNestedHookConfig(configPath, platform, host, { version: 1 });
    case 'antigravity-nested': return mergeAntigravityHookConfig(configPath, platform, host);
    case 'openhands-flat': return mergeFlatCommandHookConfig(configPath, platform, host);
    case 'windsurf-flat': return mergeFlatCommandHookConfig(configPath, platform, host);
    default: return mergeNestedHookConfig(configPath, platform, host);
  }
}
```

`verifyHookConfig` mirrors it. The two `*-flat` writers are added by Tasks 5 and 7; until then those cases are unreachable because no profile declares them.

- [ ] **Step 6: Repoint callers** — `project-adapters.ts` (two sites) and `cursor.ts` call the dispatchers.

- [ ] **Step 7: Run** — full suite. **Step 8: Commit** — `git commit -am "refactor(hosts): route hook-config on the profile's declared shape"`

---

### Task 4: GitHub Copilot

**Files:** Create `src/session/hosts/copilot.ts`. Modify `host-hook-types.ts`, `hosts/index.ts`, `agents/types.ts`, `registry.ts`, `project-adapters.ts`, `hook-config.ts`. Test: `profile-conformance.test.ts`.

**Interfaces:** Consumes Task 1's fields and Task 2's envelopes.

- [ ] **Step 1: Write the failing test**

```ts
it('copilot uses camelCase events, fails closed, and reuses the Anthropic verdict', () => {
  const profile = hostProfile('copilot');
  expect([...profile.hookEvents]).toEqual([
    'sessionStart', 'preToolUse', 'postToolUse', 'stop', 'sessionEnd',
  ]);
  expect(profile.hookEvents).not.toContain('SubagentStart');  // documented camelCase only
  expect(profile.refusesOnAnyNonZeroExit).toBe(true);
  expect(profile.hookConfigStyle).toBe('copilot-nested');
  expect(profile.denyToolCall?.('x')).toMatchObject({
    hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'x' },
  });
});
```

- [ ] **Step 2: Run it, watch it fail** — `Unsupported hook host: copilot`.

- [ ] **Step 3: Add `'copilot'` to `HookHost` and `AgentName`; add it to the conformance test's `ALL_HOSTS` array** (hardcoded at `tests/cli/hosts/profile-conformance.test.ts:5` and asserted equal to `Object.keys(HOST_PROFILES)`; every host task must update it).

- [ ] **Step 4: Create the profile** with `promptEvent: 'userPromptSubmit'`, `midTurnDeliveryVerified: false`, `denyExitCode: 2`, `refusesOnAnyNonZeroExit: true`, a camelCase event map, and a header comment recording that GitHub documents delivery of `additionalContext` but that no observed run confirms it, and that the fail-closed semantics are why `refusesOnAnyNonZeroExit` exists.

- [ ] **Step 5: Adapter.** Give Copilot its own adapter beside `createCodexAdapter` rather than widening `createJsonProjectAdapter` — that generalisation needs `hostProfile(name as HookHost)`, which throws for `gemini`, an `AgentName` that is not a `HookHost`. MCP at `.mcp.json`, hooks at `.github/hooks/knowl.json`.

- [ ] **Step 6: Run** — full suite. **Step 7: Commit**

---

### Task 5: OpenHands

**Files:** Create `src/session/hosts/openhands.ts`, add `mergeFlatCommandHookConfig` to `hook-config.ts`, plus registry/types/index/adapters.

- [ ] **Step 1: Write the failing test** — snake_case map, `denyExitCode: 2`, `denyToolCall('x')` returns `{ decision: 'deny', reason: 'x' }`, `hookConfigStyle: 'openhands-flat'`.
- [ ] **Step 2: Run it, watch it fail.**
- [ ] **Step 3: Create the profile.** Events `session_start`, `pre_tool_use`, `post_tool_use`, `stop`, `session_end`; `promptEvent: 'user_prompt_submit'` (**not** in `hookEvents`). `startContext`/`midTurnContext` return `{ additionalContext: text }` — the docs state it is injected into the agent's prompt — but `midTurnDeliveryVerified` stays `false` until observed. **`stopContext` is absent**: `stop` blocks, but its `reason` is documented as shown in the UI, not to the model, so declaring it would spend the capture nudge's one-shot on a message nobody sees.
- [ ] **Step 4: Add `mergeFlatCommandHookConfig`** writing `.openhands/hooks.json` as `{"hooks": {"<event>": [{"matcher": "*", "hooks": [{"command": …, "timeout": 30}]}]}}`, preserving foreign entries exactly as the nested writer does.
- [ ] **Step 5: Adapter** — detect on `openhands` command, MCP config at `.openhands/mcp.json`.
- [ ] **Step 6: Run. Step 7: Commit.**

---

### Task 6: Antigravity

**Files:** Create `src/session/hosts/antigravity.ts`, add `mergeAntigravityHookConfig`, plus registry/types/index/adapters.

- [ ] **Step 1: Write the failing test** — 5 events `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`; `denyToolCall('x')` returns `{ decision: 'deny', reason: 'x' }`; `stopContext('y')` returns `{ decision: 'continue', reason: 'y' }`; config written to `.agents/hooks.json` nests under a `"knowl"` hook name above the event key.
- [ ] **Step 2: Run it, watch it fail.**
- [ ] **Step 3: Create the profile.** No prompt event exists — leave `promptEvent` undefined. `midTurnDeliveryVerified: false`; context injection is via `injectSteps` on `PreInvocation`/`PostInvocation`, which is a different mechanism and is not wired here.
- [ ] **Step 4: Add `mergeAntigravityHookConfig`** for the one-level-deeper shape, owning only the `"knowl"` key so foreign hooks at sibling keys are untouched.
- [ ] **Step 5: Adapter** — workspace `.agents/hooks.json`, detect on `antigravity` command.
- [ ] **Step 6: Run. Step 7: Commit.**

---

### Task 7: Windsurf

**Files:** Create `src/session/hosts/windsurf.ts`, plus registry/types/index/adapters. Reuses `mergeFlatCommandHookConfig`.

- [ ] **Step 1: Write the failing test** — events include `pre_run_command`, `pre_write_code`, `pre_mcp_tool_use`, `post_cascade_response`; `denyExitCode: 2`; `denyToolCall('x')` returns `{ reason: 'x' }`; **`stopContext` absent and `promptEvent` absent** — Windsurf has no stop event, and `pre_user_prompt` fires before the prompt is processed rather than carrying a reminder slot.
- [ ] **Step 2: Run it, watch it fail. Step 3: Create the profile** with a header comment recording that Windsurf is now Devin Desktop, that the Devin CLI's `.devin/` hooks are a *separate* integration target not covered here, and that stderr on exit 2 is documented as reaching Cascade but not confirmed to reach the model.
- [ ] **Step 4: Map `pre_write_code` and `pre_run_command` to `tool-precheck`** and the rest to `session-event`. **Step 5: Adapter** at `.windsurf/hooks.json`, MCP at `~/.codeium/windsurf/mcp_config.json`. **Step 6: Run. Step 7: Commit.**

---

### Task 8: Cline — MCP adapter only, and the reason written down

Cline has no shell-command hook channel. Its hooks are `AgentPlugin` objects from `@cline/sdk` loaded into its runtime, so a `HostProfile` cannot reach them; integrating would mean publishing and maintaining an npm plugin.

- [ ] **Step 1:** Add a `cline` **agent adapter only** — `AgentName`, registry entry, MCP config at `.cline/mcp.json`, detect on the `cline` command. **No `HookHost`, no profile.**
- [ ] **Step 2:** Record the reason in `docs/hosts.md` (Task 10) so the next person does not re-derive it.
- [ ] **Step 3: Run. Step 4: Commit.**

---

### Task 9: Host-aware MCP instructions

The capture-nudge half of the original Task 7 is cut — see Correction 11.

- [ ] **Step 1: Write the failing test**

```ts
it('a host whose hooks own the lifecycle is told so without a conditional', () => {
  const card = mcpServerInstructions(null, 'claude');
  expect(card).toContain('hooks own lifecycle');
  expect(card).not.toContain('when active');
});
it('an MCP-only host is told it owns the manual loop, unconditionally', () => {
  const card = mcpServerInstructions(null, 'claude-desktop');
  expect(card).not.toContain('when active');
  expect(card).toContain('knowl_task_start');
});
it('no host, or an unknown one, keeps the host-neutral card', () => {
  expect(mcpServerInstructions(null)).toBe(KNOWL_MCP_SERVER_INSTRUCTIONS);
});
```

> Test 2 asserts the *absence* of the conditional, not the presence of the word "manual" — `KNOWL_HOST_NEUTRAL_MODE_LINE` already contains "manual fallback", so an implementation ignoring the host parameter would pass that.

- [ ] **Step 2: Run it, watch it fail.**
- [ ] **Step 3: `mcpServerInstructions(config, host?)`** picks the mode line from the profile: `hookEvents.length > 0` gets the hooks-own-lifecycle line (this is what finally delivers `KNOWL_CLAUDE_OPERATIONAL_CARD`, currently built and tested but never sent), `'none'` gets an unconditional manual-loop line, absent or unknown keeps today's conditional.
- [ ] **Step 4: `serve --host <host>`** in `program.ts` → `startMcpServer({ host })` → `createMcpServer`. `commandEntry` becomes `args: ['serve', '--host', name]`, and `desktop-adapter.ts`'s own `entry()` gets the same treatment — it is the host Test 2 targets.
- [ ] **Step 5: Keep existing installs configured.** Change `equalEntry` (and the duplicate in `files.ts`) to accept a stored `args` that is a prefix of the expected one when the remainder is exactly a `--host <name>` pair, so `knowl doctor` does not report every existing user as unconfigured. Add a test for the upgrade case.
- [ ] **Step 6: Run. Step 7: Commit.**

---

### Task 10: Retire Gemini, then document

- [ ] **Step 1:** `grep -rn "gemini" src/ tests/ docs/`. Remove `createGeminiAdapter`, the registry entry, the `AgentName` member, the `'gemini'` `NativeInstructionHost`. Leave any existing `GEMINI.md` on disk — deleting a user's file on upgrade is not ours to do.
- [ ] **Step 2:** Test: `expect(SUPPORTED_AGENT_NAMES).not.toContain('gemini')` and `parseAgentNames(['gemini'])` throws.
- [ ] **Step 3:** Write `docs/hosts.md`: the capability matrix, why Cline has no profile, why Windsurf has no stop, why Cursor's mid-turn stays unverified, and the ACP lane — Zed, JetBrains, Neovim, Kiro, Factory Droid — deferred because `session/request_permission` runs agent→client and needs Knowl to sit as a proxy, which is a new long-lived component rather than a profile.
- [ ] **Step 4:** `npm.cmd run docs:check`. **Step 5: Commit.**

---

## Self-Review

**Spec coverage.** Codex (2), Copilot (4), OpenHands (5), Antigravity (6), Windsurf (7), Cline (8, adapter-only with a written reason), Cursor (unchanged, Correction 6), OpenCode (absent — upstream has not shipped hooks), MCP floor (9), gemini (10), ACP (10 step 3, deferred).

**Placeholder scan.** Tasks 5–8 give shapes and constraints rather than complete file bodies; each is bounded by an exact test in its own Step 1 and by the global constraints. They are the tasks a reviewer should push hardest on.

**Type consistency.** `denyExitCode`, `refusesOnAnyNonZeroExit`, `hookConfigStyle`, `denied?: string`, `mergeHookConfig`/`verifyHookConfig`, `mergeFlatCommandHookConfig`, `mergeAntigravityHookConfig`, `anthropicDenyToolCall`/`anthropicStopContext`, `RETIRED_HOOK_EVENTS` each defined once and referenced by the same name after.

**Ordering.** 1 → 2 → 3 → (4, 5, 6, 7 independent) → 8 → 9 → 10. Task 3's dispatcher names two writers created in 5 and 7; those cases are unreachable until their profiles exist, so 3 typechecks only if the functions are stubbed there or 5/7 precede it — stub them in 3.

**Known risk.** None of these hosts is installed on the build machine and Codex hooks do not run on Windows at all, so every profile is written to the rule that an unverified capability is an absent one. The failure mode is "Knowl captures and notifies over MCP", never a broken gate. A profile claiming a capability without a cited source is the defect to catch.
