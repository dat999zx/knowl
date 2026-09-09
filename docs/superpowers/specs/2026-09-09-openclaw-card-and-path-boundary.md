# OpenClaw plugin: the card must reach the model, and a workspace is a path, not a prefix

Date: 2026-09-09. Findings N1 and N2 of `docs/research` 2026-09-08 ultimate run, §3.1. Both
re-verified in this tree at `8e16c55`.

## What is broken

### N2 — the session-start card is spent on an event that cannot carry it

`integrations/openclaw/src/index.ts:454-477` registers `session_start` and maps it to the
engine's `session-start`. That event binds the session and composes the bootstrap card. OpenClaw
discards `session_start`'s return value, so the card goes nowhere. The next
`before_prompt_build` (`turn-start`) finds the session already bound and takes the
`bootstrapWithHandoff(…, 'turn', false, …)` branch at `src/session/host-lifecycle.ts:1083` —
`includeContext=false` — so it composes nothing.

Measured in this worktree with a scratch `knowl init` project: `session_start` then
`before_prompt_build` → `prependContext` length **0**. Without the `session_start` call the same
prompt hook returns a card (the existing #257 test at `tests/integrations/openclaw/hooks.test.ts:56`
proves this — it never fires `session_start`).

Net: every real OpenClaw session gets zero engine memory. The plugin is dead for its main purpose.

### N1 — workspace lookup matches by string prefix

`integrations/openclaw/src/engine.ts:131`:
```ts
this.handles.values()).find((h) => cwd.startsWith(h.projectRoot))
```
and the same shape at `:185` in `releaseWorkspace`. `C:/Code/knowl-cloud` starts with
`C:/Code/knowl`. Whichever warms first captures the other: a hook in knowl-cloud reads knowl's
atoms, and — since the handle carries the write gate and capture — writes capture rows into
knowl's store and reports success.

## The fix

### N2: follow Hermes

Hermes hit this exact bug and the fix is recorded at `src/session/hosts/hermes.ts:9-16` and
CHANGELOG 5.2x ("The Hermes bootstrap card was being thrown away"): **do not map the
session-start event.** Let the first `turn-start` bind the session and carry the card — the
`!sessionBinding && sharesSessionBinding` branch at `host-lifecycle.ts:1071` does exactly that,
and `openclawProfile.sharesSessionBinding` is already `true`.

Concretely:
- `src/session/hosts/openclaw.ts`: remove `session_start` from `OPENCLAW_EVENT_MAP`. Update the
  docblock the way Hermes' does — say why it is absent.
- `integrations/openclaw/src/index.ts`: the `session_start` handler keeps
  `manager.warmWorkspace(cwd)` (the cold-open warm is real and cheap) and **stops calling
  `handle.lifecycle`**. Nothing else changes.

Not the fix: "assign the result of `withDeadline`". There is nowhere to deliver it — OpenClaw
ignores that hook's return. Assigning it would be dead code.

### N1: path boundary

Replace both `startsWith` matches with a boundary check. `path.relative` already exists in this
file's neighbour (`index.ts:110`, `toRepoRelativePath`) and is the shape the repo uses:

```ts
function isWithin(root: string, cwd: string): boolean {
  const rel = path.relative(root, cwd);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
```

Use it at `engine.ts:131` and `:185`. One helper, two callers, no new dependency.

## Out of scope

N3–N7 from the same table (session-id fallback, migration fail-open, `process.cwd()` fallback,
validation options, write-gate matcher). Each is its own PR per the research doc's grouping.

## Acceptance

1. A test that fires `session_start` then `before_prompt_build` on the same session and asserts a
   non-empty `prependContext`. **Fails on `8e16c55`, passes after.**
2. A test that warms `<tmp>/knowl` then asks `getHandle('<tmp>/knowl-cloud')` (a second
   initialised project) and asserts the returned handle's `projectRoot` is `<tmp>/knowl-cloud`.
   **Fails on `8e16c55`, passes after.**
3. `tests/cli/hosts/hermes-profile.test.ts:11` has the profile-level assertion for Hermes; add the
   same for OpenClaw: `openclawProfile.normalizedEvent('session_start')` is `undefined` and
   `OPENCLAW_PLUGIN_EVENTS` does not contain `'session_start'` (it is derived from the map, so
   this follows). The plugin still registers the `session_start` hook for warming — that is
   fine; `pluginEvents` documents what the *engine* sees, not what the host fires.
4. Existing `session_start warms workspace and gateway_stop releases all handles` test still passes.
5. Full gate: `npm run build && npm run typecheck && npm run lint && npm test`.
