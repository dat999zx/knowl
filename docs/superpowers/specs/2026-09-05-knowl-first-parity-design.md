# Knowl-first parity: making every host actually use Knowl, and correctly

Date: 2026-09-05
Status: draft for review
Branch: `worktree-knowl-first-parity`
Worktree: `.claude/worktrees/knowl-first-parity`

Governed by: constraint `6676fd41b5dc410c` — recall is the turn-start hook's fixed orientation
card, never a query built from the user's prompt text. Nothing here adds a second recall path.

Corrects, and supersedes the current state of: `3f1fa7ebec504083` (host-parity audit,
2026-08-22), whose Copilot finding is still unfixed four months on — which is itself evidence
for Phase 1.

## The ask

> "fix it for all providers, everything. like ensure every harness, cli use knowl first and use
> it correctly"

Two verbs, and they fail differently. **"Use Knowl first"** is a *retrieval* property: the agent
queries before acting. **"Use it correctly"** is a *write* property: what it stores lands where
it belongs and retires what it replaces. Today the first has no working enforcement channel on
10 of 12 hosts, and the second is broken in any session without a project folder.

## How this was found, which is the shortest argument for the whole document

In one session, working in this repository, an agent (me):

1. Read a `state` atom asserting Hermes runs the Knowl dev build. It was stale — `npm publish`
   had rewired the binary a day earlier. Acted on it before verifying.
2. Ran ~20 consecutive non-Knowl tool calls across two turns while diagnosing that. The drift
   reminder — which exists, defaults to 12, and was written for exactly this — never fired.
3. Cited a constraint from atom `23a4b0c2491d468a` ("`withDbPath` races, do not spread it")
   to argue *against* the correct fix. That atom describes v2.17.0; `withDbPath` has been
   `AsyncLocalStorage`-scoped since. The advice was inverted.
4. Was told by the user, correctly, that it had not used Knowl at all.

Every one of those is a failure this codebase already has a mechanism for. None of the
mechanisms could fire. That is the thesis: **the machinery exists and is not connected.**

## Root causes

### RC1 — the mid-turn slot has one delivery path, and it is stubbed on 6 of 12 hosts

`src/session/host-lifecycle.ts:1259` gates the entire mid-turn branch on
`profile.midTurnContext('') !== undefined`. A profile whose `midTurnContext` returns `undefined`
receives **none** of:

- the change card (`:1242`)
- the destructive-command lesson card (`:1243`)
- the fleet card (`:1251`)
- skill capture / skill use nudges (`:1294`, `:1296`)
- the turn-capture prompt (`:1298`)
- **the drift reminder** (`:1334`)

Six subsystems, one chokepoint. Measured across all 12 profiles at `src/session/hosts/*.ts`:

| host | promptEvent | midTurnContext | midTurnDeliveryVerified |
| --- | --- | --- | --- |
| claude | `UserPromptSubmit` | impl | **true** |
| codex | `UserPromptSubmit` | impl | **true** |
| copilot | `userPromptSubmitted` | impl | false |
| openhands | `user_prompt_submit` | impl | false |
| antigravity | none | impl | false |
| cursor | none | impl | false |
| **hermes** | `pre_llm_call` | **STUB** | false |
| **openclaw** | `before_prompt_build` | **STUB** | false |
| windsurf | none | STUB | false |
| claude-desktop | none | STUB | false |
| cline | none | STUB | false |
| generic | none | STUB | false |

Two hosts have a verified mid-turn channel. The two stubs that matter most are **hermes** and
**openclaw**: both deliver the turn-start recall card successfully, so the agent gets memory at
turn start and can never be corrected for the rest of the turn.

**The MCP path cannot cover this, and that is structural.** `src/mcp/change-notice.ts:272`
gates on `state.reads < MIN_MCP_READS` where `reads` counts *Knowl* tool calls — which is
correct for what that function is: `consumeCaptureNudge` is the **capture** nudge ("you have
consulted memory five times and stored nothing"), the MCP twin of the hook path's turn-capture
prompt, not of the drift reminder.

There is no MCP twin of the drift reminder and there cannot be one. An MCP server receives only
calls to its own tools; `read_file`, `terminal` and the rest never reach it. Silence is exactly
what it cannot observe, so "count consecutive non-Knowl calls" has nothing to count. The
docblock at `:205-212` states this already: *"That signal does not exist here — an MCP server
sees only its own tool calls."*

So for a genuinely MCP-only host (claude-desktop, cline, generic), the drift reminder is out of
reach by construction, and the fix for those hosts is a hook channel, not a smarter counter.

### RC2 — namespace resolution is per-handler, so global sessions read the wrong database

`globalStorePath()` appears at exactly 4 sites in `src/mcp/tools.ts` — `knowl_state:580`,
`knowl_recent:605`, `knowl_store:654`, `knowl_query:928`. The other ~30 handlers pass
`projectId!` bare and resolve against the ambient project database.

Confirmed consequences, all reproduced:

**(a) Fetch-by-id can never reach the global store.** `tools.ts:776-787` calls
`getKnowledgeItem(id)` against the project DB, then falls back to a *workspace* lookup (linked
repos) — never global. The global branch at `:912-928` is in the **search** path, after the
`if (id)` early return. So `knowl_query` finds a global atom and `knowl_query id=<that id>`
reports it does not exist. `tool-definitions.ts` documents the opposite: *"To read a truncated
item in full, call again with `id`."*

**(b) `knowl_timeline` returns `[]` for a global item.** Reproduced this session: timeline on
`48e9758641ca41fc` returned `[]` while `sqlite3 ~/.knowl/global.db` shows assertion row
`a4d18a5a3be6414f` for that item.

**(c) `knowl_update --supersedeId` cannot retire a global atom at all.** `tools.ts:1548`:

```ts
if (!(await readItem(supersedeId))) {
  throw new Error(`No knowledge item "${supersedeId}" to supersede. Nothing was updated.`);
}
```

`readItem` is the bare project-DB read. Retiring a global item refuses with "does not exist"
for an item that does. **This is the user's original "bad at superseding" report.** The atom in
question *was* retired — but only because it went through `knowl_store` with `supersedes:`,
the one write path that is namespace-routed.

**The old objection is void.** Atom `23a4b0c2491d468a` says `withDbPath` mutates process-global
state and misroutes concurrent writes. That was v2.17.0. `src/store/database.ts:31` is now
`const scopedContext = new AsyncLocalStorage<DbContext>()`, and the docblock narrates the race
in the past tense. `openProjectScope` (`:257`) and `withRepoRoot` (`:184`) are the same pattern
already in production. The fix is cheap and the seam exists.

### RC3 — the conformance test checks the wrong direction, so a stub is invisible

`tests/cli/hosts/profile-conformance.test.ts` is substantially better than review atom
`728ca4879c2b444e` reports — that atom describes an earlier state and is itself stale. The file
is 200+ lines and pins real invariants: the prompt-event-in-hookEvents trap, the stdin
allowlist round-trip, Codex's event list against the shipped binary, `writeTools` vs
`writesFiles` exclusivity.

The gap is narrower and more specific than "the test asserts a literal". Both mid-turn
assertions are **one-directional, and both point away from the defect**:

```ts
// :148 — verified implies envelope
if (profile().midTurnDeliveryVerified) expect(profile().midTurnContext('x')).toBeDefined();

// :158 — envelope implies tool event
if (profile().midTurnContext('x') !== undefined) expect(hasToolEvent).toBe(true);
```

Read them together: *verified → envelope → tool event*. Every implication starts from having a
capability. **Nothing starts from registering a tool event and demands the envelope.** A host
that maps `post_tool_call → session-event` and returns `undefined` from `midTurnContext`
satisfies both assertions vacuously, because both are `if (capability)` guards and the stub has
no capability to trigger them.

That is exactly hermes and openclaw. Both map a tool event — `hermes.ts:29` maps
`post_tool_call → session-event`, `openclaw.ts:35` maps `after_tool_call → session-event` — and
both return `undefined`. Both pass.

**And there is a second layer, found only by running the check.** The first attempt at this
assertion keyed on `profile.hookEvents`, which is empty for both hosts (`hermes.ts:116`,
`openclaw.ts:54`). `hookEvents` means *"events `knowl init` writes into a config file"* — stated
in `hermes.ts:42` — and a plugin host has no such file: its events reach the engine through the
plugin. So an assertion asking `hookEvents` whether the host has a tool event gets `false` for
precisely the two hosts it was written to catch, returns early, and passes 109/109.

That is the same defect one level down: a check that cannot fire, written to catch checks that
cannot fire. `hookEvents` never appears in `src/session/host-lifecycle.ts` at all — it is
install-time metadata, and reading it as a runtime capability is a category error.

The fix is a `pluginEvents` declaration on the profile plus a `hostSendsNormalizedEvent(profile,
event)` helper that asks the union. The pre-existing assertion at `:158` needs the same
treatment, and urgently: it reads `hookEvents` too, so the moment Phase 2 gives Hermes a real
envelope, `envelope ⇒ tool event` inverts and **fails** on a host that genuinely has one.

The missing assertion is the converse of `:151`:

> a host that sends a `session-event` tool event MUST return a mid-turn envelope, or declare in
> the profile why it cannot.

The escape hatch matters: `claude-desktop` legitimately has neither (pinned separately at
`:170`), and `cursor` deliberately has an envelope with unverified delivery so the MCP fallback
keeps talking to it. The rule is not "every host must deliver" — it is **"a host that has
somewhere to put a card must either put one there or say why not."**

This reframes Phase 1. The work is not writing a conformance suite from nothing; it is adding
the one implication that closes the loop, fixing the predicate both sides depend on, plus the
vendor-event fixtures that the Copilot finding (`3f1fa7ebec504083`) shows are still missing. The
existing Codex assertion at `:89` is the model to copy — it pins event names against a dated
inspection of the shipped binary, which is precisely the check Copilot never got.

## What this does not do

- **No new recall path.** Constraint `6676fd41b5dc410c` stands; turn-start keeps sole ownership
  of the orientation card. Everything here is *mid-turn correction* and *write routing*.
- **No prompt-derived queries.** The drift reminder is a fixed string. The impact card queries
  by *file path*, which is not prompt text.
- **No new host integrations.** Twelve profiles exist; this connects the ones that are dark.
- **No behavioural change for claude/codex.** They already work. They are the reference
  fixtures the conformance test measures the others against.

## Design

### Phase 1 — make the gap visible and keep it visible

A conformance test that measures **behaviour**, not literals. For every profile in
`hostProfiles`:

1. If `promptEvent` is non-null, `midTurnContext('x')` MUST return a defined envelope.
   Rationale: a host that can be told something at turn start but never mid-turn is precisely
   the failure mode of hermes and openclaw, and it is silent.
2. `midTurnDeliveryVerified: true` MUST be accompanied by a fixture in
   `tests/cli/hosts/fixtures/<host>-midturn.json` recording an observed delivery. The flag
   becomes evidence-backed rather than self-asserted.
3. Every string in `hookEvents` and `promptEvent` MUST appear in that host's vendor event list
   at `tests/cli/hosts/fixtures/<host>-events.json`, committed from vendor docs with a source
   URL and date. This is the check that would have caught Copilot in August.

Plus `knowl doctor --hosts`: print the matrix above from live profile data, so the gap is
visible without reading source.

**Deliberately first.** Phases 2 and 3 are ordinary bug fixes; this is the part that makes them
stay fixed.

### Phase 2 — unstub the mid-turn slot

**Hermes.** The channel is already proven in production: `transform_tool_result`
(`integrations/hermes/knowl/__init__.py`) appends the impact card to tool results today. The
blocker is that `post_tool_call` is `fire_async(...) -> None`, so the engine's `hostOutput` is
discarded, and the impact card is computed independently in Python — bypassing
`host-lifecycle.ts` entirely. Work: route `post_tool_call` through the synchronous `fire()`
path, carry `hostOutput` back, and append it in `transform_tool_result` alongside the existing
card. Then `midTurnContext` returns a real envelope and `midTurnDeliveryVerified` becomes
true with a fixture.

**OpenClaw.** Same shape, already in TypeScript:
`api.registerAgentToolResultMiddleware` (`integrations/openclaw/src/index.ts:253`) runs *before
output is fed back to the model* and appends to `content` — the comment at `:249-252` states it
deliberately avoids `tool_result_persist` because that only rewrites the transcript copy. This
is a working mid-turn delivery channel with a stubbed profile sitting on top of it.

**MCP-only hosts** (claude-desktop, cline, generic, windsurf): invert `MIN_MCP_READS`. Count
consecutive **non-Knowl** tool calls, matching the hook path's drift semantics, rather than
Knowl reads. A host with no hook channel at all then still gets the reminder that a silent
agent earns.

Per the harness skill's governing rule, openclaw/cursor/windsurf/antigravity hook catalogs get
re-read at source before their tasks are written. Hermes and openclaw are verified as of today.

### Phase 3 — resolve the store once per request

`callTool` (`src/mcp/tools.ts:511`) already carries the pattern: `actingAs` recomputes
`{projectId, projectRoot, config}` for another repo and, per its docblock, *"a handler cannot
tell the difference and none of them had to be changed."* Extend that to namespace:

- resolve `{dbPath, projectId, projectRoot}` once from `projectRoot` + `namespace` at entry,
- wrap the whole dispatch in the existing scope helper,
- delete the four ad-hoc `globalStorePath()` sites; handlers stop knowing namespaces exist.

**Ordering constraint:** `assertOwnedTargets` returns early on `!projectRoot`
(`tools.ts:418`), so ownership checks must run *inside* the resolved scope or global writes
will keep skipping them. Getting this backwards silently disables a security check — it is
called out here because it is the one part of Phase 3 that is not mechanical.

Fixes (a), (b), (c) and ~30 handlers in one change.

### Phase 4 — correctness sweep

- Copilot event names against the committed vendor fixture from Phase 1.
- Supersede the two atoms that misled this session: `23a4b0c2491d468a` (withDbPath race — fixed
  by ALS) and `6cff969fb6924e10` (supersede writes no commit row — fixed at `tools.ts:1573-1577`
  via `supersedeKnowledgeItemWithCommit`).
- Reconcile `docs/hosts.md` and `README` with the Phase 1 matrix.

## A note on Phase 4 that belongs in the design

Both stale atoms carried `pathsChanged: "3 of 3 affectedPaths modified since this was stored"`
in the query result that returned them. The staleness signal **worked**. It was read and
overridden.

So the honest scope of "use it correctly" includes a case no code change in this document
fixes: an agent that receives a correct staleness warning and uses the content anyway. Phase 1's
conformance test and Phase 2's channel restore the *mechanisms*; whether a warning that is
delivered is also **heeded** is a prompt-and-guidance question. It is named here rather than
quietly folded into a task, because a spec that claims to fix it would be overclaiming.

## Verification

Every phase must pass the repository's full gate, not a subset:

```bash
npm.cmd run build                 # REQUIRED before tests -- see below
npm.cmd test                      # ~360s, 415 files / ~3910 tests. Background it; never kill early.
npx eslint .
npm.cmd run typecheck
npm.cmd run docs:check
node scripts/check-version-sync.mjs
```

**`npm run build` is a hard prerequisite of `npm test`, and there is no `pretest` hook to
enforce it.** Tests such as `tests/store/retention.test.ts:175` spawn
`process.execPath ./dist/index.js` as a subprocess. In a fresh worktree with no `dist/`, those
tests fail with `expected 1 to be +0` on a spawn exit code — a failure that looks like broken
logic and is really a missing build. Observed on this branch: 84 failures across 27 files, all
resolved by building first. Any task in this plan that reports test failures MUST confirm
`dist/index.js` exists before investigating anything else.

Phase 2 additionally ships a **live** check: the drift reminder firing in a real Hermes session
after 12 consecutive non-Knowl tool calls. That is the only proof that matters. Per the harness
skill, *"trusting an installer's 'registered successfully' as proof"* is the recurring failure
mode of this class of work, and a green unit test asserting a profile returns an envelope is
not evidence that the envelope reached a model.

Documentation is generated and checked: `docs/hosts.md` and `README` changes in Phase 4 must
keep `npm.cmd run docs:check` green rather than being hand-edited into drift.

### Baseline at branch point (`1f50d19`)

Established on `worktree-knowl-first-parity` after `npm install` and `npm run build`:

| check | result |
| --- | --- |
| `tsc --noEmit` | clean |
| `npx eslint .` | clean (exit 0) |
| `docs:check` | "Generated documentation regions are current" |
| `check-version-sync.mjs` | all four files match 5.21.1 |
| `npm test` | pending clean re-run; first run was invalid (raced `npm install`, no `dist/`) |

`CHANGELOG.md` currently HAS a `## Unreleased` heading at line 6, so entries for this work
append there rather than creating one.

### Known CI flake, not to be confused with a regression

`tests/cli/claude-subagent-notification.test.ts` has been seen failing on `windows-latest` with
a spawned CLI exiting `3221225477` (0xC0000005) *after* emitting complete, correct stdout — a
native crash at teardown. Confirm by rerunning; do not treat it as caused by these changes
without establishing that first.

## Risks

| risk | mitigation |
| --- | --- |
| Phase 3 ordering error silently disables ownership checks | explicit test: global write with `supersedes` targeting a foreign item must refuse |
| Hermes sync `fire()` adds latency to every tool call | measure first; `pre_tool_call` already fails closed at 30s, `post_tool_call` has no such gate |
| Mid-turn cards become noisy once six subsystems can suddenly deliver | backoff already exists (`driftBackoff`, 12→24→48→96) and the slot is single-occupancy by construction |
| Vendor event fixtures rot | fixture carries source URL + date; `doctor --hosts` surfaces age |
