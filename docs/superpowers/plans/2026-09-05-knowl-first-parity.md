# Knowl-First Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every harness Knowl supports can correct an agent mid-turn, and every write lands in the namespace it names — so "use Knowl first, and use it correctly" is enforced by the code rather than requested by a prompt.

**Architecture:** Three independent seams. (1) A conformance assertion that runs in the missing direction — *registers a tool event ⇒ must return a mid-turn envelope* — plus dated vendor-event fixtures. (2) Two host profiles unstubbed onto result-rewrite channels that already ship, and the MCP fallback counter inverted to count silence instead of use. (3) Namespace resolved once per MCP request at `callTool`, so ~30 handlers stop resolving against the wrong database.

**Tech Stack:** TypeScript (ESM, tsup), vitest, Python 3 (Hermes plugin), Node ≥22.

**Spec:** `docs/superpowers/specs/2026-09-05-knowl-first-parity-design.md`

**Branch:** `worktree-knowl-first-parity` (worktree at `.claude/worktrees/knowl-first-parity`, spec committed at `38f5be1`)

## Global Constraints

- **Recall stays the turn-start card.** Constraint `6676fd41b5dc410c`. Nothing here adds a second recall path, and no query is ever built from prompt text. The impact card queries by *file path*, which is not prompt text.
- **Capability is expressed by return value.** A profile member that has not been verified is absent, never a flag set `true`. Read `src/session/hosts/profile.ts:31-40` before touching any profile — it explains why `midTurnDeliveryVerified` must not be inferred from an envelope existing.
- **Never call `initDb`, `initDbPath` or `closeDb` from MCP request code.** Those own the process-wide context and belong to process entry points. Inside a request, reach another database with `withDbPath` / `withRepoRoot` / `withProjectScope`.
- **No handler may float a promise.** Every hook handler awaits its own work in its own try/catch.
- **`npm run build` is a hard prerequisite of `npm test`.** There is no `pretest` hook. Tests such as `tests/store/retention.test.ts:175` spawn `./dist/index.js`; without `dist/` they fail on a spawn exit code and it reads like broken logic. If tests fail, confirm `dist/index.js` exists **before** investigating anything else.
- Verification gate, all of it, every task: `npm.cmd run build`, `npm.cmd test` (~360s, background it, never kill early), `npx eslint .`, `npm.cmd run typecheck`, `npm.cmd run docs:check`, `node scripts/check-version-sync.mjs`.
- Docblocks explain WHY in prose, naming the failure that motivated the code. Match the density of `src/store/database.ts`.
- Test roots: `path.resolve('./.knowl-<name>-test')`, a fresh root per test. On Windows libSQL holds `-shm`/`-wal` sidecars, so a shared root cleaned in `beforeEach` silently keeps the previous test's rows.
- Commit after every task. Lowercase conventional commit subjects; body written for someone reading it in a year.
- `CHANGELOG.md` HAS a `## Unreleased` heading at line 6 as of this writing. Append there; do not create a second one.

## Prerequisite: baseline must be green before Task 1 — RESOLVED

The worktree originally branched from `1f50d19`, which was **red for the OpenClaw suite**. That
is fixed and landed: `07dd150` on `feat/openclaw-plugin` ("fix(tests): the openclaw suite passed
only where openclaw was installed"), and this branch is rebased onto it.

The cause is worth carrying, because it is the same shape as the defects this plan fixes.
`openclaw` is a **peer dependency**, correctly absent from a clean checkout — the host refuses a
second registry copy of itself inside a managed plugin project and relinks its own
`node_modules/openclaw` after install. So the suite passed on the developer's machine, where a
live-install experiment had left a repo-local and a global copy behind, and died on CI's ubuntu
and macOS legs with `ERR_MODULE_NOT_FOUND`. `07dd150` aliases the specifier to a committed stub
in `vitest.config.ts`, and bumps `plugin-export.test.ts` to 300s because that hook runs a real
`npm pack` + `npm install` and was timing out under parallel load.

**A green suite that is green only on one machine is exactly the failure class of RC1 and RC3.**
A capability nothing checks and everything assumes: there, an installed peer; here, a mid-turn
channel. Both pass locally, both are absent in the environment that matters, and neither
announces itself.

Baseline confirmed on the rebased branch (`3dcd1b1`), full gate, single run with no concurrent
vitest process:

| check | result |
| --- | --- |
| `npm test` | **415 files, 3925 passed, 5 skipped, 0 failed** (263s) |
| `tsc --noEmit` | clean |
| `npx eslint .` | clean (exit 0) |
| `docs:check` | "Generated documentation regions are current" |
| `check-version-sync.mjs` | all four sites match 5.21.1 |

`tests/cloud/send-transfer.test.ts:250` — which timed out at 30s in an earlier run — **passes
here**. The earlier failure was contention: three vitest processes were running concurrently
against a suite whose config already caps `maxWorkers: 4` for exactly this reason (its docblock
notes extra workers "starve vitest's own worker RPC on a busy machine"). Not a fourth defect,
and not something to design around. The operational lesson is narrower and worth obeying during
execution: **run the suite once, alone.** A red result obtained under self-inflicted load is
indistinguishable from a regression, and this plan's whole argument is that a signal nobody can
trust is the same as no signal.

## Already established, do not re-litigate

- **`withDbPath` no longer races.** `src/store/database.ts:31` is `AsyncLocalStorage`-scoped; its docblock narrates the old process-global race in the past tense. Atom `23a4b0c2491d468a` describes v2.17.0 and is obsolete — Task 10 retires it. Do not use it to argue against Task 8.
- **Both stubbed hosts already have a working result-rewrite channel**, verified 2026-09-05: Hermes `transform_tool_result` (`integrations/hermes/knowl/__init__.py`) and OpenClaw `api.registerAgentToolResultMiddleware` (`integrations/openclaw/src/index.ts:253`). Phase 2 is wiring, not invention.
- **The conformance test is good.** It pins the prompt-event trap, the stdin allowlist round-trip, and Codex's events against the shipped binary. Do not rewrite it; add to it.

---

## File map

| File | Responsibility |
| --- | --- |
| `tests/cli/hosts/profile-conformance.test.ts` (modify) | the converse assertion + fixture-backed verification |
| `tests/cli/hosts/fixtures/<host>-events.json` (create ×3) | dated vendor event lists, copied from vendor docs |
| `src/session/hosts/profile.ts` (modify) | `midTurnUnavailableReason` — the declared escape hatch |
| `src/session/hosts/hermes.ts` (modify) | real `midTurnContext`, verified flag |
| `src/session/hosts/openclaw.ts` (modify) | real `midTurnContext`, verified flag |
| `src/session/hosts/{claude-desktop,cline,generic,windsurf}.ts` (modify) | declare why they cannot |
| `integrations/hermes/knowl/__init__.py` (modify) | sync `post_tool_call`, carry `hostOutput` into `transform_tool_result` |
| `integrations/openclaw/src/index.ts` (modify) | carry lifecycle `hostOutput` through the middleware |
| `src/mcp/change-notice.ts` (modify) | count non-Knowl calls, not Knowl calls |
| `src/mcp/tools.ts` (modify) | resolve namespace once at `callTool`; delete 4 ad-hoc sites |
| `src/cli/doctor-report.ts` (modify) | `--hosts` channel matrix |

---

### Task 1: The conformance assertion that runs in the missing direction

**Files:**
- Modify: `src/session/hosts/profile.ts:40` (add `midTurnUnavailableReason`)
- Modify: `tests/cli/hosts/profile-conformance.test.ts:151-159`
- Modify: `src/session/hosts/{claude-desktop,cline,generic,windsurf}.ts`

**Interfaces:**
- Produces: `HostProfile.midTurnUnavailableReason?: string` — consumed by Tasks 2, 3 and 7.

**Why this exists.** Both current mid-turn assertions are `if (capability)` guards: *verified ⇒ envelope* (`:148`) and *envelope ⇒ tool event* (`:158`). Every implication starts from having a capability, so a host that registers `post_tool_call → session-event` and returns `undefined` satisfies both **vacuously**. That is precisely hermes (`hermes.ts:29`) and openclaw (`openclaw.ts:35`). The missing rule is the converse: a host with somewhere to put a card must either put one there or say why not.

- [ ] **Step 1: Write the failing test**

Add to `tests/cli/hosts/profile-conformance.test.ts`, inside the `describe.each(ALL_HOSTS)` block:

```ts
it('registers a tool event only when it can put a card on it', () => {
  // The converse of the assertion above, and the one that was missing. Both existing
  // mid-turn checks are `if (capability)` guards, so a profile with NO capability passes
  // them without ever being asked anything -- which is how hermes and openclaw registered
  // `session-event` and returned undefined from midTurnContext for months while the change
  // card, the lesson card, the fleet card, both skill nudges, the turn-capture prompt and
  // the drift reminder were all silently undeliverable on them.
  //
  // The escape hatch is deliberate and must stay: a host may genuinely have no channel
  // (claude-desktop), and cursor deliberately keeps an unverified envelope so the MCP
  // fallback goes on talking to it. The rule is not "every host delivers" -- it is
  // "a host that has somewhere to put a card either puts one there or says why not".
  const profile = hostProfile(host);
  const hasToolEvent = profile.hookEvents.some(e => profile.normalizedEvent(e) === 'session-event');
  if (!hasToolEvent) return;
  const explained = typeof profile.midTurnUnavailableReason === 'string'
    && profile.midTurnUnavailableReason.length > 0;
  expect(
    profile.midTurnContext('x') !== undefined || explained,
    `${host} registers a session-event tool event but returns no mid-turn envelope and `
      + 'declares no midTurnUnavailableReason',
  ).toBe(true);
});
```

- [ ] **Step 2: Run it to confirm it fails, and on the right hosts**

Run: `npx vitest run tests/cli/hosts/profile-conformance.test.ts`
Expected: FAIL for `hermes` and `openclaw`. Every other host passes — `claude-desktop`/`cline`/`generic` register no `session-event`, and `windsurf` must be checked: if it registers one, it fails too and gets a reason in Step 4.

- [ ] **Step 3: Add the escape hatch to the profile type**

In `src/session/hosts/profile.ts`, directly after `midTurnDeliveryVerified` (`:40`):

```ts
/**
 * Why this host registers a tool event but cannot carry a mid-turn card.
 *
 * Required by the conformance suite for exactly that combination, because the alternative
 * is what shipped for months: a profile returning `undefined` from `midTurnContext` while
 * mapping a tool event, which reads as "nothing to deliver here" and is indistinguishable
 * from an oversight. A sentence costs one line and makes the gap answerable.
 *
 * Absent means the host delivers. It is not a way to opt out of delivering.
 */
readonly midTurnUnavailableReason?: string;
```

- [ ] **Step 4: Declare reasons for hosts that genuinely cannot**

For any host failing Step 2 that is NOT hermes or openclaw (check windsurf), add a one-sentence `midTurnUnavailableReason` naming the vendor limitation. Do **not** add one to hermes or openclaw — Tasks 2 and 3 give those real envelopes, and adding a reason here would let them pass while staying broken.

- [ ] **Step 5: Verify the test now fails only for hermes and openclaw**

Run: `npx vitest run tests/cli/hosts/profile-conformance.test.ts`
Expected: exactly two failures, `hermes` and `openclaw`. This red state is the contract Tasks 2 and 3 close.

- [ ] **Step 6: Verify the test against mutants**

Break it three ways and confirm each fails differently:
1. Change `!== undefined` to `=== undefined` → every delivering host fails.
2. Delete the `if (!hasToolEvent) return;` guard → `claude-desktop` fails, proving the guard is load-bearing.
3. Set `midTurnUnavailableReason: 'x'` on hermes → hermes passes while broken, proving the hatch is real and must not be handed to a host that has a channel.

Restore after each. A test that never failed proves nothing.

- [ ] **Step 7: Commit**

```bash
git add src/session/hosts/profile.ts tests/cli/hosts/profile-conformance.test.ts src/session/hosts/
git commit -m "test(hosts): assert a registered tool event carries a mid-turn card"
```

---

### Task 2: Unstub Hermes

**Files:**
- Modify: `src/session/hosts/hermes.ts:140-142`
- Modify: `integrations/hermes/knowl/__init__.py` (`post_tool_call`, `transform_tool_result`)
- Test: `tests/cli/hosts/hermes-profile.test.ts`

**Interfaces:**
- Consumes: `midTurnUnavailableReason` from Task 1 (must NOT be set here).
- Produces: `hermesProfile.midTurnContext(text)` returning a defined envelope.

**Why the channel exists already.** `transform_tool_result` appends the impact card to tool results in production today. The blocker is that `post_tool_call` is `fire_async(...) -> None`, so the engine's `hostOutput` is discarded, and the impact card is computed independently in Python — bypassing `host-lifecycle.ts` entirely.

- [ ] **Step 1: Write the failing profile test**

In `tests/cli/hosts/hermes-profile.test.ts`:

```ts
it('carries a mid-turn card on the tool-result channel', () => {
  // Hermes reads a bare string from transform_tool_result and appends it to the tool
  // result the model is about to see. That is a real mid-turn delivery channel, proven by
  // the impact card already shipping on it -- so returning undefined here cost this host
  // every card the mid-turn slot carries.
  const output = hostProfile('hermes').midTurnContext('remember to store that');
  expect(output).toBeDefined();
  expect(JSON.stringify(output)).toContain('remember to store that');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/cli/hosts/hermes-profile.test.ts`
Expected: FAIL — `expected undefined to be defined`.

- [ ] **Step 3: Implement the envelope**

Replace `src/session/hosts/hermes.ts:140-142`:

```ts
  midTurnContext(text) {
    // `context` is the same key startContext uses, because the plugin hands both to the
    // model the same way: a bare string appended to what the model is about to read. Proven
    // by the impact card, which has been riding transform_tool_result in production since
    // the plugin shipped -- this profile returning undefined is what kept the ENGINE's
    // cards off a channel the plugin was already using for its own.
    return { context: text };
  },
```

Leave `midTurnDeliveryVerified: false` for now. Step 7 flips it, after the delivery is observed rather than assumed.

- [ ] **Step 4: Run both tests to verify they pass**

Run: `npx vitest run tests/cli/hosts/hermes-profile.test.ts tests/cli/hosts/profile-conformance.test.ts`
Expected: PASS for hermes. `openclaw` still fails conformance — Task 3 owns it.

- [ ] **Step 5: Carry `hostOutput` through the Python plugin**

In `integrations/hermes/knowl/__init__.py`, change `post_tool_call` from `fire_async` to the synchronous `fire()`, cache the returned `hostOutput` keyed by `(session_id, tool_name)` in a bounded `OrderedDict` mirroring `impact_seen` / `IMPACT_SEEN_MAX`, and have `transform_tool_result` read that cache and append the card **after** the impact card.

The cache is required, not stylistic: `transform_tool_result` must stay cheap and synchronous, and the async work belongs in the neighbouring observe hook. Bounded because a Desktop backend is a long-lived process serving many sessions.

- [ ] **Step 6: Measure the latency the sync switch adds**

`post_tool_call` currently returns immediately. Measure the sync path over 20 tool calls and record the median in the commit body. Hermes bounds `pre_tool_call` at 30s **fail-closed**, but `post_tool_call` has no such gate — so a slow handler degrades the session rather than failing it. If the median exceeds ~150ms, stop and report rather than shipping a per-tool-call tax.

- [ ] **Step 7: Verify live, then flip the flag**

In a real Hermes Desktop session in a Knowl project: run 12 consecutive non-Knowl tool calls and confirm the continuation reminder appears in the tool result. Save the observed card to `tests/cli/hosts/fixtures/hermes-midturn.json` with the date. Only then set `midTurnDeliveryVerified: true`.

This is the only proof that matters. A green unit test asserting the profile returns an envelope is not evidence the envelope reached a model — per the harness skill, trusting "registered successfully" is the recurring failure of this class of work.

- [ ] **Step 8: Commit**

```bash
git add src/session/hosts/hermes.ts integrations/hermes/knowl/__init__.py tests/cli/hosts/
git commit -m "feat(hermes): deliver mid-turn cards on the tool-result channel"
```

---

### Task 3: Unstub OpenClaw

**Files:**
- Modify: `src/session/hosts/openclaw.ts:79-81`
- Modify: `integrations/openclaw/src/index.ts:253` (middleware)
- Test: `tests/integrations/openclaw/hooks.test.ts`

**Interfaces:**
- Consumes: `midTurnUnavailableReason` from Task 1 (must NOT be set here).
- Produces: `openclawProfile.midTurnContext(text)` returning a defined envelope.

**Why the channel exists already.** `api.registerAgentToolResultMiddleware` runs *before output is fed back to the model* and appends to `content`. The comment at `index.ts:249-252` records that it deliberately avoids `tool_result_persist`, which only rewrites the transcript copy. This is a verified mid-turn channel with a stubbed profile on top of it.

**Blocked on:** the vitest alias prerequisite. This suite cannot run until `openclaw/plugin-sdk/plugin-entry` resolves.

- [ ] **Step 1: Write the failing test**

```ts
it('carries a mid-turn card through the tool-result middleware', () => {
  const output = hostProfile('openclaw').midTurnContext('store that finding');
  expect(output).toBeDefined();
  expect(JSON.stringify(output)).toContain('store that finding');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/integrations/openclaw/hooks.test.ts`
Expected: FAIL — `expected undefined to be defined`.

**Do not expect a resolution error.** `openclaw` is a peer dependency and is *correctly absent*
from this repository: OpenClaw refuses a second registry copy of the host inside a managed
plugin project and relinks its own `node_modules/openclaw` after install. `07dd150` aliases
`openclaw/plugin-sdk/plugin-entry` to `tests/integrations/openclaw/plugin-entry-stub.ts` in
`vitest.config.ts` so the suite runs on a clean machine. If you see
`Cannot find package 'openclaw/plugin-sdk/plugin-entry'`, you are on a branch below `07dd150` —
rebase rather than installing OpenClaw, because installing it is what hid this on the original
developer's box while CI's ubuntu and macOS legs stayed red.

**What the stub does and does not cover.** `definePluginEntry` is stubbed as identity. These
tests drive `register(api)` directly with a fake `api`, so nothing exercises the host's side of
the registration contract. That is faithful for Steps 1-4, which only ask what the *profile*
returns. It is **not** coverage of Step 5: whether the gateway actually delivers what the
middleware appends is not observable under the stub, which is why Step 6 requires a live
gateway session and not a green suite.

- [ ] **Step 3: Implement the envelope**

Replace `src/session/hosts/openclaw.ts:79-81`:

```ts
  midTurnContext(text) {
    // `appendContent` rather than `prependContext`: the turn-start card orients a turn that
    // has not begun, while this one corrects a turn already in flight, and the middleware
    // appends to `content` for a documented reason -- `details` is stripped before provider
    // replay and compaction, so a card written there is one the model never reads twice.
    return { appendContent: text };
  },
```

Match the key to whatever the middleware actually consumes — read `integrations/openclaw/src/index.ts:253-300` and use its field name, not this one, if they differ.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/integrations/openclaw/hooks.test.ts tests/cli/hosts/profile-conformance.test.ts`
Expected: PASS. Task 1's conformance test is now green for every host.

- [ ] **Step 5: Carry lifecycle `hostOutput` through the middleware**

In `integrations/openclaw/src/index.ts`, have the middleware append the lifecycle `hostOutput` alongside the existing impact card. Both may be present; the impact card comes first. Reuse the existing `withDeadline` bound — the middleware sits in front of the model and must not stall a turn.

- [ ] **Step 6: Verify live, then flip the flag**

Same protocol as Task 2 Step 7, in a real OpenClaw gateway session. Fixture to `tests/cli/hosts/fixtures/openclaw-midturn.json`. Only then set `midTurnDeliveryVerified: true`.

- [ ] **Step 7: Commit**

```bash
git add src/session/hosts/openclaw.ts integrations/openclaw/src/index.ts tests/
git commit -m "feat(openclaw): deliver mid-turn cards through the result middleware"
```

---

### Task 4: Invert the MCP fallback counter

**Files:**
- Modify: `src/mcp/change-notice.ts:213` (`MIN_MCP_READS`), `:265-278`
- Test: `tests/mcp/change-notice.test.ts`

**Interfaces:**
- Produces: unchanged signature; only the counting semantics change.

**Why.** `change-notice.ts:272` gates on `state.reads < MIN_MCP_READS`, where `reads` counts **Knowl tool calls**. The nudge fires after five Knowl reads with no write. An agent that never calls Knowl never increments it. **The fallback for "the agent is ignoring Knowl" requires the agent to already be using Knowl** — which is why a 20-call silent run in this repo produced nothing. The hook path counts the opposite thing (`incrementHostSuccessfulToolCount` on non-Knowl calls, reset on Knowl calls); this brings MCP into line.

- [ ] **Step 1: Write the failing test**

```ts
it('nudges an agent that is ignoring Knowl entirely', async () => {
  // The case the old counter could not see. It counted Knowl reads, so silence -- the
  // condition the nudge exists for -- looked identical to a session that had not started.
  const state = freshState();
  for (let i = 0; i < 12; i++) {
    await recordNonKnowlToolCall(state, 'read_file');
  }
  expect(await maybeNudge(state)).toContain('memory');
});

it('stays silent for an agent that is using Knowl', async () => {
  const state = freshState();
  for (let i = 0; i < 12; i++) {
    await recordNonKnowlToolCall(state, 'read_file');
    await recordKnowlToolCall(state);          // resets, exactly as the hook path does
  }
  expect(await maybeNudge(state)).toBeUndefined();
});
```

Adapt the helper names to the module's actual exports — read the file first.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mcp/change-notice.test.ts`
Expected: FAIL — the first test gets `undefined` because nothing counts non-Knowl calls.

- [ ] **Step 3: Invert the counter**

Rename `reads` to `nonKnowlCalls`, increment on any non-Knowl tool call, reset to 0 on any Knowl tool call, and rename `MIN_MCP_READS` to `MIN_SILENT_CALLS`. Align the default with `DEFAULT_DRIFT_REMINDER_EVERY` (12) so the two channels agree; record in the docblock that they are deliberately the same number and why.

- [ ] **Step 4: Run to verify both pass**

Run: `npx vitest run tests/mcp/change-notice.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm the hook path still owns the nudge where it should**

`hookChannelOwnsTheNudge` must still suppress the MCP nudge for a host with a live binding and a working channel — otherwise Tasks 2 and 3 produce two nudges on hermes and openclaw. Add an assertion for that.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/change-notice.ts tests/mcp/change-notice.test.ts
git commit -m "fix(mcp): nudge on silence, not on use"
```

---

### Task 5: Vendor event fixtures

**Files:**
- Create: `tests/cli/hosts/fixtures/{copilot,openhands,antigravity}-events.json`
- Modify: `tests/cli/hosts/profile-conformance.test.ts`

**Why.** Audit `3f1fa7ebec504083` (2026-08-22) found `copilot.ts` registering `stop` and `userPromptSubmit` — names GitHub never fires. It survived four months behind a green suite. The Codex assertion at `:89` is the model: it pins event names against a dated inspection of the shipped binary. Copilot never got one.

Per the harness skill's governing rule, **re-read each vendor's current hook catalog at source**; the August audit is four months stale and that staleness is the defect being fixed.

- [ ] **Step 1: Read each vendor's hook catalog at source and record it**

For copilot, openhands, antigravity: read the vendor's *full catalog listing*, not the summary table. Write `tests/cli/hosts/fixtures/<host>-events.json`:

```json
{
  "source": "https://<vendor-doc-url>",
  "readAt": "2026-09-05",
  "events": ["...", "..."],
  "promptEvents": ["..."]
}
```

- [ ] **Step 2: Write the failing test**

```ts
it.each(['copilot', 'openhands', 'antigravity'])(
  '%s declares only events its vendor actually fires',
  async host => {
    // Copilot shipped `stop` and `userPromptSubmit` for months. Neither is a GitHub event
    // name. Nothing caught it because nothing compared the profile to the vendor.
    const fixture = JSON.parse(await fs.readFile(`tests/cli/hosts/fixtures/${host}-events.json`, 'utf8'));
    const profile = hostProfile(host as HookHost);
    for (const event of profile.hookEvents) {
      expect(fixture.events, `${host} registers ${event}, absent from ${fixture.source}`).toContain(event);
    }
    if (profile.promptEvent) {
      expect(fixture.promptEvents, `${host} prompt event ${profile.promptEvent}`).toContain(profile.promptEvent);
    }
  },
);
```

- [ ] **Step 3: Run it**

Run: `npx vitest run tests/cli/hosts/profile-conformance.test.ts`
Expected: whatever the vendor docs say. If a host fails, that is a **real defect found** — record it in the commit body and fix the profile in Task 9 rather than editing the fixture to match the code.

- [ ] **Step 4: Commit**

```bash
git add tests/cli/hosts/fixtures/ tests/cli/hosts/profile-conformance.test.ts
git commit -m "test(hosts): pin registered events against dated vendor catalogs"
```

---

### Task 6: `knowl doctor --hosts`

**Files:**
- Modify: `src/cli/doctor-report.ts`, `src/cli/program.ts`
- Test: `tests/cli/doctor-hosts.test.ts` (create)

**Why.** The matrix in the spec was assembled by hand from twelve source files. Nobody will redo that, so it will drift. Generating it from live profile data makes the gap answerable in one command — and is what would have surfaced the hermes stub without a source read.

- [ ] **Step 1: Write the failing test**

```ts
it('reports each host\'s real channel state', async () => {
  const report = await renderHostMatrix();
  expect(report).toContain('claude');
  expect(report).toMatch(/hermes.*verified/);
  // A host that cannot deliver must print its declared reason, not a blank cell -- a blank
  // reads as "unknown" and unknown is what let two stubs sit unnoticed.
  expect(report).not.toMatch(/\|\s*\|\s*\|/);
});
```

- [ ] **Step 2: Run to verify it fails** — `renderHostMatrix` does not exist.

- [ ] **Step 3: Implement**

Read `HOST_PROFILES` and emit one row per host: promptEvent, mid-turn envelope yes/no, `midTurnDeliveryVerified`, `midTurnUnavailableReason` when present, fixture age from Task 5's `readAt`. Wire to `knowl doctor --hosts`.

- [ ] **Step 4: Run to verify it passes.**

- [ ] **Step 5: Regenerate docs**

Run `npm.cmd run docs:check`. Documentation is generated — if it fails, regenerate rather than hand-editing, or Task 9's doc reconciliation will fight it.

- [ ] **Step 6: Commit**

```bash
git add src/cli/doctor-report.ts src/cli/program.ts tests/cli/doctor-hosts.test.ts docs/
git commit -m "feat(doctor): report the per-host channel matrix"
```

---

### Task 7: Resolve the namespace once per MCP request

**Files:**
- Modify: `src/mcp/tools.ts:511` (`callTool`), and the 4 ad-hoc sites at `:580`, `:605`, `:654`, `:928`
- Test: `tests/mcp/namespace-routing.test.ts` (create)

**Interfaces:**
- Consumes: `withDbPath` / `globalStorePath` / `globalOnlyNamespaces`, all existing.
- Produces: no signature change. Handlers stop knowing namespaces exist.

**Why.** `globalStorePath()` appears at 4 of ~35 handlers; the rest resolve against the ambient project database. `callTool` already carries the pattern — `actingAs` recomputes `{projectId, projectRoot, config}` for another repo, and its docblock states *"a handler cannot tell the difference and none of them had to be changed."*

**⚠ The one non-mechanical part.** `assertOwnedTargets` returns early on `!projectRoot` (`tools.ts:418`). Move resolution without care and ownership checks silently stop running for global writes — a security check that fails open. Task 8 pins this; do not skip it.

- [ ] **Step 1: Write the three failing tests**

```ts
it('fetches a global item by id', async () => {
  // knowl_query finds it; knowl_query with its id said it did not exist. The id branch at
  // :776 reads the project DB, then falls back to WORKSPACE peers -- never global -- while
  // the global branch lives in the search path below the early return.
  const id = await storeGlobalAtom({ title: 'personal default' });
  const result = await callTool({ params: { name: 'knowl_query', arguments: { id } } });
  expect(textOf(result)).toContain('personal default');
  expect(result.isError).toBeFalsy();
});

it('reads the timeline of a global item', async () => {
  const id = await storeGlobalAtom({ title: 'personal default' });
  const result = await callTool({ params: { name: 'knowl_timeline', arguments: { itemId: id } } });
  expect(JSON.parse(textOf(result))).not.toEqual([]);
});

it('retires a global item through knowl_update', async () => {
  // The reported "bad at superseding". readItem at :1548 is the bare project read, so
  // retiring a global atom refused with "does not exist" for an item that does.
  const stale = await storeGlobalAtom({ title: 'old' });
  const fresh = await storeGlobalAtom({ title: 'new' });
  const result = await callTool({
    params: { name: 'knowl_update', arguments: { id: fresh, supersedeId: stale } },
  });
  expect(textOf(result)).toContain(`retired ${stale}`);
  expect((await readGlobalItem(stale)).status).toBe('superseded');
});
```

- [ ] **Step 2: Run to verify all three fail**

Run: `npx vitest run tests/mcp/namespace-routing.test.ts`
Expected: FAIL — "No knowledge item", `[]`, and "No knowledge item ... to supersede. Nothing was updated." respectively. These three messages are the bug in the user's own words; confirm you see them before changing anything.

- [ ] **Step 3: Resolve once at the entry**

In `callTool`, after `projectId`/`projectRoot`/`config` are resolved and before the handler chain, compute the effective database path from `projectRoot` plus the request's `namespace` argument (default `project`), and wrap the entire dispatch in `withDbPath` when it differs from the ambient. Use `withDbPath`, never `initDbPath`/`closeDb` — those own the process-wide context.

- [ ] **Step 4: Delete the four ad-hoc sites**

Remove the `globalStorePath()` conditionals at `:580`, `:605`, `:654`, `:928`. They are now redundant; leaving them means two mechanisms resolving the same thing.

- [ ] **Step 5: Run to verify all three pass, then run the full suite**

Run: `npx vitest run tests/mcp/` then the full gate. The full suite matters here more than anywhere else in this plan — this touches every handler.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools.ts tests/mcp/namespace-routing.test.ts
git commit -m "fix(mcp): resolve the store once per request"
```

---

### Task 8: Pin the ownership guard against the Task 7 ordering trap

**Files:**
- Test: `tests/mcp/namespace-routing.test.ts` (extend)

**Why a separate task.** It is a different reviewer's gate: Task 7 is "does the routing work", this is "did the routing quietly disable a security check". Both green in one commit hides which one you verified.

- [ ] **Step 1: Write the failing-open test**

```ts
it('still refuses to retire an item this repo does not own', async () => {
  // assertOwnedTargets returns early on !projectRoot (:418). Resolve the namespace in the
  // wrong order and every global write skips ownership entirely -- a check that fails OPEN,
  // which is invisible until someone retires a linked repo's knowledge from here.
  const foreign = await storeAtomInLinkedRepo({ title: 'theirs' });
  const result = await callTool({
    params: { name: 'knowl_store', arguments: { category: 'fact', title: 'mine', content: 'x', supersedes: foreign } },
  });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toMatch(/own|owner/i);
});
```

- [ ] **Step 2: Run it against Task 7's implementation**

Expected: PASS if the ordering is right. **If it passes trivially, prove it can fail:** temporarily move the `assertOwnedTargets` call after the scope wrapper and confirm it goes red. A guard test that never failed proves nothing.

- [ ] **Step 3: Commit**

```bash
git add tests/mcp/namespace-routing.test.ts
git commit -m "test(mcp): pin the ownership guard across the namespace scope"
```

---

### Task 9: Correctness sweep and docs

**Files:**
- Modify: `src/session/hosts/copilot.ts` (only if Task 5 found a mismatch)
- Modify: `docs/hosts.md`, `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Fix any profile Task 5 proved wrong.** Change the profile, never the fixture.
- [ ] **Step 2: Reconcile the docs with the Task 6 matrix.** Every ✅ must correspond to a channel the suite proves. Where docs claimed a channel that cannot fire, say what it actually does.
- [ ] **Step 3: Run `npm.cmd run docs:check`.** Regenerate rather than hand-edit.
- [ ] **Step 4: Add a CHANGELOG entry under the existing `## Unreleased` at line 6.** Do not create a second heading.
- [ ] **Step 5: Full gate.**
- [ ] **Step 6: Commit** — `docs: reconcile host capability tables with the enforced matrix`

---

### Task 10: Retire the memory that misled this work

**Files:** none — knowledge store only.

**Why this is a task and not a footnote.** Two stale atoms were read *this session* and both changed a decision: `23a4b0c2491d468a` was used to argue against Task 7's approach, and `6cff969fb6924e10` describes a bug fixed at `tools.ts:1573-1577`. Leaving them active means the next session repeats both errors.

- [ ] **Step 1: Retire the withDbPath race atom**

```
knowl_store category=fact
  title="withDbPath is AsyncLocalStorage-scoped and no longer misroutes concurrent writes"
  content="<what database.ts:31 does now, why the v2.17.0 finding no longer holds, and that
           openProjectScope/withRepoRoot are the same pattern in production>"
  affectedPaths=["src/store/database.ts"]
  provenance=observed
  supersedes="23a4b0c2491d468a"
```

- [ ] **Step 2: Retire the supersede-commit atom** the same way, superseding `6cff969fb6924e10`, citing `supersedeKnowledgeItemWithCommit` at `tools.ts:1573-1577`.

- [ ] **Step 3: Store what this work established** — one atom per finding: the inverted MCP counter, the conformance direction gap, and the Task 7 ordering trap. Cite `affectedPaths` so the next reader reaches the source instead of searching.

- [ ] **Step 4: Confirm** `knowl_query "withDbPath race"` returns the correction, not the retired atom.

---

## What this plan does not fix, and says so

Both stale atoms arrived carrying `pathsChanged: "3 of 3 affectedPaths modified since this was stored"`. **The staleness signal worked.** It was read and overridden anyway.

No task here changes that. Phase 1 restores the enforcement, Phase 2 restores the channel, Task 10 corrects the specific facts — but whether a delivered warning is *heeded* is a prompt-and-guidance question, and a plan claiming to fix it would be overclaiming. It is named here so the next reader knows it was considered rather than missed.

## Self-review

**Spec coverage.** RC1 → Tasks 1-4; RC2 → Tasks 7-8; RC3 → Tasks 1, 5, 6. Phase 4 → Tasks 9-10. The MCP-only host fallback is Task 4. Every spec section has a task.

**Placeholders.** None. Every code step carries the actual code. Task 5's fixture contents are necessarily read from vendor docs at execution time — that is the task's work, not a placeholder, and the shape is given.

**Type consistency.** `midTurnUnavailableReason` is introduced in Task 1 Step 3 and consumed by the same name in Tasks 1, 2, 3 and 6. `midTurnContext(text)` returns `HostOutput | undefined` throughout. `MIN_MCP_READS` → `MIN_SILENT_CALLS` renamed once, in Task 4, and not referenced afterwards.

**One gap worth naming:** Task 3's envelope key (`appendContent`) is a best guess from the middleware's shape. Step 3 instructs reading `index.ts:253-300` and using the real field name. Flagged rather than asserted.
