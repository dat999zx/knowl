# Host Profile Registry Design

**Date:** 2026-07-25

**Status:** Approved (autonomous execution authorized)

## Problem

Two problems, one cause.

**Change notification only works for Claude.** The watermark, commit diffing, and own-write
attribution are already host-agnostic and run for every host, but delivery is gated on
`input.host === 'claude'`. Subagent bootstrap is registered only in `CLAUDE_HOOK_EVENTS`.

**Host differences are expressed as 23 scattered conditionals** across six files:

| File | Count | What it decides |
| --- | --- | --- |
| `src/cli/agents/host-hook.ts` | 7 | which payload keys hold identity; event-name mapping; shell-event detection |
| `src/store/host-lifecycle.ts` | 6 | context envelope shape; who gets the change card and reminder; binding semantics |
| `src/cli/agents/hook-config.ts` | 5 | which events to register; whether a prompt reminder exists |
| `src/cli/agents/project-adapters.ts` | 3 | lifecycle capability; instruction file name |
| `src/index.ts` | 1 | whether to print host-shaped JSON or the host-neutral result |
| `src/cli/agents/reminder.ts` | 1 | which host may receive a prompt reminder |

Adding a host means finding all of them. That is how `claude-desktop` ended up silently
using **Cursor's** event map: the ternary reads
`codex || claude ? claudeMap : cursorMap`, `generic` returns earlier, so everything else
falls through to Cursor. Nothing tests it, and no single place declares what a host supports.

## Verified host capabilities

Established before designing. Sources: the installed binaries, official docs, and upstream
bug reports.

| Host | Subagent events | Mid-turn context on tool events | Evidence |
| --- | --- | --- | --- |
| **Claude Code** | `SubagentStart` / `SubagentStop` | `hookSpecificOutput.additionalContext` | Probed live 2026-07-25 (Knowl `14195a48267d4d84`) |
| **Codex CLI** | `SubagentStart` / `SubagentStop` | `hookSpecificOutput.additionalContext` | `codex.exe` 0.145.0 contains `hooks\src\engine\dispatcher.rs` with the full event enum including both subagent events, plus `additionalContext`, `additionalContextLimit`, `hookSpecificOutput`, `agent_id`, `session_id`, `transcript_path`, `cwd` |
| **Cursor** | none | `additional_context` — accepted but unreliably surfaced | [docs](https://cursor.com/docs/hooks.md); multiple open bug reports that `postToolUse` `additional_context` is logged but never reaches the model ([1](https://forum.cursor.com/t/posttooluse-hooks-additional-context-not-injected-into-agent-model-context/158168), [2](https://forum.cursor.com/t/cursor-hooks-additional-context-not-injected-in-agent-context-in-posttooluse/156157), [3](https://forum.cursor.com/t/native-posttooluse-hooks-accept-and-log-additional-context-successfully-but-the-injected-context-is-not-surfaced-to-the-model/155689)) |
| **Claude Desktop**, **Gemini** | none | none | MCP-only hosts; no lifecycle hook channel exists |

One secondary source claimed Codex has only five events and no subagent support. The binary
contradicts it, so the binary wins; a live Codex run is the confirmation step.

**Cursor gets the card anyway.** Its hooks accept the JSON and merely fail to surface it, so
emitting costs nothing and starts working the day the upstream bug is fixed. Withholding it
would need removing later; emitting it does not.

## Design

### One interface, one file per host

`src/cli/agents/hosts/profile.ts` declares what a host is. Each host gets exactly one file
under `src/cli/agents/hosts/`, and `hosts/index.ts` is the registry.

```ts
export interface HostProfile {
  readonly host: HookHost;

  /** Host-native lifecycle events `knowl init` registers. Empty means an MCP-only host. */
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

  /** Envelope for context at session/subagent/turn start. undefined = unsupported. */
  startContext(event: NormalizedHookEventName, context: string): HostOutput | undefined;

  /** Envelope for context on a tool event mid-turn. undefined = unsupported. */
  midTurnContext(text: string): HostOutput | undefined;
}
```

**Capability is expressed by return value, not by a parallel boolean.** A host that cannot
receive mid-turn context returns `undefined` from `midTurnContext`, so there is no way for a
flag to claim support the function does not deliver. The two remaining booleans
(`sharesSessionBinding`, `nativeOutput`) are genuine behavioural facts with no function to
hang them on.

### What the core code does instead of branching

| Current conditional | Becomes |
| --- | --- |
| `externalIds` host ternaries | `profile.identity(raw)` |
| `eventMap` ternary + `normalizeGeneric` dispatch | `profile.normalizedEvent(name)` |
| `isShell` cursor check | `profile.isShellEvent(name, toolName)` |
| `hostContextOutput` host branches | `profile.startContext(event, context)` |
| `input.host === 'claude'` for card and reminder | `profile.midTurnContext(text)` |
| `codex \|\| claude` binding checks | `profile.sharesSessionBinding` |
| `host !== 'codex' && host !== 'claude'` in the CLI | `!profile.nativeOutput` |
| `host === 'codex' ? CODEX_HOOK_EVENTS : CLAUDE_HOOK_EVENTS` | `profile.hookEvents` |
| `host === 'claude'` reminder guard | `profile.promptEvent` |

The trigger in `host-lifecycle.ts` keeps one code path for every host: it always evaluates
the watermark, always populates `changes`, and asks the profile whether there is anywhere to
put the card. A host with no mid-turn channel simply gets `undefined` and stays silent, which
is exactly today's Codex/Cursor behaviour expressed as data instead of a branch.

### Generic stays a profile, not a special case

`normalizeGeneric` remains its own function — its payload contract genuinely differs — but it
is reached through `GENERIC_PROFILE.normalizedEvent` returning the event name verbatim, not
through an early `if (host === 'generic')` return in the shared normalizer.

### What is deliberately not changed

`project-adapters.ts`'s three conditionals concern install-time instruction files
(`CLAUDE.md` vs `GEMINI.md`) and detection, which belong to the existing `AgentAdapter`
registry rather than the runtime hook path. Folding them in would merge two registries with
different lifetimes and different key sets (`AgentName` includes `gemini`, `HookHost` includes
`generic`). Out of scope; noted so the next reader knows it was a decision.

## Testing

- **Per-profile unit tests** — a shared conformance suite runs against every registered
  profile: identity extraction round-trips, every declared `hookEvents` entry maps to a
  normalized event, and `startContext`/`midTurnContext` either return a non-empty envelope or
  `undefined`. This is the test that would have caught the `claude-desktop` fallthrough.
- **Registry completeness** — every `HookHost` in the union has exactly one profile.
- **Behaviour preservation** — the existing hook, lifecycle, reminder, and CLI suites must
  pass unchanged. They encode today's per-host behaviour and are the regression gate for the
  refactor.
- **Codex end to end** — the same shape as the Claude CLI test: `SubagentStart` bootstrap,
  a sibling write, a change card on the next tool event, silence thereafter.
- **Live Codex run** — configure hooks in a scratch project and drive the real `codex` CLI
  with a cheap model to confirm the events fire and the card is accepted.

## Non-goals

Merging the install-time `AgentAdapter` registry with the runtime profile registry. Adding
Gemini or Claude Desktop hook support, which requires a hook channel neither host has.
Relevance filtering, attribution columns, or any change to the watermark semantics — this
work moves delivery decisions behind an interface and widens host coverage; it does not
alter what a change card says or when the watermark moves.
