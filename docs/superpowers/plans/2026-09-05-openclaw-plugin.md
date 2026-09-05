# OpenClaw In-Process Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `knowl init openclaw` installs a plugin that runs *inside* OpenClaw's gateway and imports the Knowl engine directly — so the write gate answers in under a millisecond instead of booting a process, and the impact card reaches the model in the turn that earned it.

**Architecture:** Two halves. Part 1 adds a real library door to this package: an `exports` map plus `src/plugin.ts`, exposing a scoped `ProjectHandle` over `handleHostLifecycleEvent`, `query` and `store`. Part 2 is the plugin itself under `integrations/openclaw/`, a TypeScript package registering six hooks and one tool-result middleware through `api.on(...)`. The CLI's ambient `initDb`/`closeDb` path is untouched; every plugin call runs inside `withProjectScope`.

**Tech Stack:** TypeScript (ESM, tsup, code splitting already on), vitest, OpenClaw plugin SDK (peer dependency), Node ≥22.

**Spec:** `docs/superpowers/specs/2026-09-05-openclaw-plugin-design.md`

**Decision:** `bfb061c8eb094559`

## Global Constraints

- **Never call `initDb`, `initDbPath` or `closeDb` from plugin or library code.** Those own the process-wide context and belong to the CLI. Every handle method body runs inside `withProjectScope`; release maps to `releaseClient`. This is what 5.21.1 shipped for, and ignoring it reintroduces the silent cross-project write that PR #258 fixed.
- **Recall is the fixed orientation card.** `turn-start` → `bootstrapWithHandoff`. Never build a query from prompt text — the defect PR #257 fixed on Hermes. Prompt text may be a signal; it is never the query string.
- **Exactly one hook publishes the card.** `before_prompt_build` carries it; `agent_turn_prepare` and `heartbeat_prompt_contribution` carry nothing. Context additions concatenate, so two publishers duplicate.
- **`before_tool_call` is FAIL-CLOSED on a 15 s host budget**, and a timed-out handler keeps running with no cancellation signal. The gate carries its own shorter deadline and answers "accepted" on it. A stalled engine must never deny a user's write.
- **No handler may float a promise.** Every handler awaits its own work inside its own try/catch. `--unhandled-rejections=throw` is Node's default and a floated rejection kills the gateway. Do **not** install a process-level `unhandledRejection` listener.
- **The payload allowlist ships with the normaliser.** `readLifecyclePayloadObject` enforces `ROOT_FIELDS` / `MAX_RETAINED_STRING` / `MAX_RETAINED_ARRAY_ITEMS`. Without it a plugin can hand the engine unbounded prompt text and break the "never prompts, never transcripts" promise.
- Capability is expressed by return value: a profile member that has not been verified is absent, never a flag set to `true`. Read `src/session/hosts/profile.ts` before writing the profile.
- Verify with `npm run build`, `npm test`, `npx eslint .`, `npm run typecheck`, `npm run docs:check`.
- Branch `feat/openclaw-plugin` (already exists, holds the spec). Commit after every task.
- `CHANGELOG.md` has no `## Unreleased` heading after a release — the release commit consumes it. Task 10 recreates it.

## Already done, do not redo

- **Native coexistence is verified** (spec Verification 1, 2026-09-05). libsql, `node:sqlite` and tree-sitter coexist in one process; both engines opened the same file in WAL and saw each other's rows. Do not re-run as a gate.
- **`openProjectScope` / `withProjectScope` shipped in 5.21.1** (PR #258). Use them; do not rebuild scoping.

---

## File map

| File | Responsibility |
| --- | --- |
| `package.json` (modify) | `exports` map with wildcards, `main` retained |
| `tsup.config.ts` (modify) | add `src/plugin.ts` to `entry` |
| `src/plugin.ts` (create) | the library door: `openProject`, `ProjectHandle`, re-exports |
| `src/cli/agents/lifecycle.ts` (modify) | `readLifecyclePayloadObject` beside the stream reader |
| `src/store/database.ts` (modify) | preserve `SchemaTooNewError` through `initDbPath` |
| `src/session/hosts/openclaw.ts` (create) | the host profile |
| `src/session/hosts/index.ts` (modify) | register it |
| `src/core/host-hook-types.ts` (modify) | `'openclaw'` HookHost |
| `src/cli/agents/types.ts`, `registry.ts` (modify) | `'openclaw'` AgentName + adapter |
| `src/cli/agents/openclaw.ts` (create) | adapter: `openclaw.json` merge, gates, timeout |
| `integrations/openclaw/package.json` (create) | plugin manifest, `openclaw` as **peer** |
| `integrations/openclaw/openclaw.plugin.json` (create) | `activation.onStartup`, contracts |
| `integrations/openclaw/src/index.ts` (create) | `register(api)`, six hooks + middleware |
| `integrations/openclaw/src/engine.ts` (create) | handle cache, deadlines, failure swallowing |
| `tests/cli/plugin-export.test.ts` (create) | imports the BUILT artifact as a consumer |
| `tests/cli/hosts/profile-conformance.test.ts` (modify) | `ALL_HOSTS` |
| `tests/cli/openclaw-adapter.test.ts` (create) | config merge, both gates, timeout |
| `tests/integrations/openclaw/hooks.test.ts` (create) | hook behaviour with a fake `api` |
| `README.md`, `docs/hosts.md`, `CHANGELOG.md` (modify) | docs |

---

### Task 0: Branch and OpenClaw checkout

- [ ] **Step 1:** `feat/openclaw-plugin` already exists off `main` and holds the spec (`8a9bda4`, `3858e29`). Confirm `main` is merged in so 5.21.1's `openProjectScope` is present.
- [ ] **Step 2:** OpenClaw source at `D:/coding/openclaw` (shallow clone) for SDK types. `pnpm install` there; `pnpm@12` is installed. The plugin builds against `openclaw/plugin-sdk/*` types.

---

### Task 1: `readLifecyclePayloadObject` — the allowlist, without a stream

**Files:** modify `src/cli/agents/lifecycle.ts`; test `tests/cli/lifecycle-payload-object.test.ts`

**Interfaces:**
- Produces: `readLifecyclePayloadObject(raw: unknown): LifecyclePayload` — the same filtering `readLifecyclePayload` applies after parsing, extracted so a non-stdin caller reaches it.

**Why first:** every later task depends on it, and it is the privacy boundary.

- [ ] **Step 1: Write the failing test.** Assert an object with a 5,000-character `prompt` field and a 200-item array comes back truncated to `MAX_RETAINED_STRING` / `MAX_RETAINED_ARRAY_ITEMS`, and that a field outside `ROOT_FIELDS` is dropped entirely. Read the existing constants first; do not restate them as literals.
- [ ] **Step 2:** Refactor `readLifecyclePayload` so the stream reader parses and then delegates to the new function. One allowlist, two entry points — `hook-over-mcp.ts:118` explains why a second copy is forbidden.
- [ ] **Step 3:** `npm test -- lifecycle`. Commit.

---

### Task 2: Preserve `SchemaTooNewError` across the library boundary

**Files:** modify `src/store/database.ts`; test `tests/store/schema-error-class.test.ts`

`initDbPath` catches everything and rethrows `DatabaseError`, so the class is lost and a consumer can only string-match.

- [ ] **Step 1: Failing test** — stamp a scratch db `user_version` above `KNOWL_SCHEMA_VERSION`, open it, assert the thrown error is `instanceof SchemaTooNewError` (or carries it as `cause`).
- [ ] **Step 2:** Preserve the cause. Do not change the CLI's message — `doctor` and `status` render it and their tests assert on it.
- [ ] **Step 3:** `npm test -- schema`. Commit.

---

### Task 3: The library door — `exports` map and `src/plugin.ts`

**Files:** modify `package.json`, `tsup.config.ts`; create `src/plugin.ts`; test `tests/cli/plugin-export.test.ts`

**Interfaces:**
- Produces: `openProject(cwd): Promise<ProjectHandle | null>` — `null` on `ProjectNotFoundError`, **throws** on `MissingKnowledgeDatabaseError`. Two different answers, deliberately.
- Produces: `ProjectHandle { lifecycle, query, store, release }`, every body inside `withProjectScope`, `release` → `releaseClient`.
- Produces: re-exported `normalizeHostHook`, `readLifecyclePayloadObject`, `KNOWL_MIGRATION_LEVEL`.

- [ ] **Step 1: The exports map must not break the Cline path.** Before writing it, enumerate what resolves today. The verified minimum:
  ```json
  { ".": "./dist/index.js", "./plugin": "./dist/plugin.js",
    "./package.json": "./package.json",
    "./integrations/*": "./integrations/*", "./dist/*": "./dist/*" }
  ```
  Keep `main`. `integrations/cline/knowl-plugin.mjs` is documented in `docs/hosts.md:138`, `docs/reference.md:2390` and `CHANGELOG.md:985` — a three-entry map breaks it.
- [ ] **Step 2: Failing test that imports the BUILT artifact**, not the source. Pack and install into a scratch dir with OpenClaw's exact flags (`--omit=dev --omit=peer --legacy-peer-deps --ignore-scripts --no-audit --no-fund`), then `import('@dat999zx/knowl/plugin')`. Assert all five paths above still resolve.
- [ ] **Step 3:** Write `src/plugin.ts`. It must not import the CLI program — check the built chunk does not pull `commander`.
- [ ] **Step 4: The multi-project regression, at this layer.** Open two projects, write through the first, assert the row landed in the first's file. This is PR #258's test one level up; it is the reason this design is safe.
- [ ] **Step 5:** `npm run build`, verify `dist/plugin.js` exists and `dist/index.js` still prints the version. Commit.

---

### Task 4: The OpenClaw host profile

**Files:** create `src/session/hosts/openclaw.ts`; modify `src/session/hosts/index.ts`, `src/core/host-hook-types.ts`; test `tests/cli/hosts/profile-conformance.test.ts`

Read `src/session/hosts/hermes.ts` first — its event-map docblock is the model for explaining *why* each mapping is what it is.

- [ ] **Step 1:** Event map: `before_prompt_build` → `turn-start`; `before_tool_call` → `tool-precheck`; `after_tool_call` → `session-event`; `before_compaction` → `checkpoint`; `session_end`/`agent_end` → `turn-stop`; `gateway_stop` → `session-stop`; `session_start` binds.
- [ ] **Step 2:** No `hookEvents` — like Cline and Hermes, this host has no hook file. Say so in the docblock.
- [ ] **Step 3:** Add to `ALL_HOSTS`; conformance test passes. Commit.

---

### Task 5: The plugin package skeleton

**Files:** create `integrations/openclaw/{package.json,openclaw.plugin.json,tsconfig.json,src/index.ts}`

- [ ] **Step 1:** `package.json` — `@dat999zx/knowl` as a real **`dependencies`** entry (`--omit=peer` would skip a peer), and `openclaw` as a **`peerDependency`** (the host refuses a second registry copy and relinks it itself). Both, deliberately.
- [ ] **Step 2:** `openclaw.plugin.json` with `activation.onStartup` and `contracts.agentToolResultMiddleware` listing both runtimes.
- [ ] **Step 3:** `register(api)` **synchronous**, handlers registered with `api.on(...)` — never `api.registerHook`, which warns and never fires for typed names. Settings from `api.pluginConfig` in the closure.
- [ ] **Step 4:** Evaluate `openclaw.release.bundleRuntimeDependencies: false` — the documented opt-out native-heavy packages use so npm resolves per-platform binaries at install. Record the decision either way.

---

### Task 6: The engine wrapper — handles, deadlines, and swallowing

**Files:** create `integrations/openclaw/src/engine.ts`; test `tests/integrations/openclaw/engine.test.ts`

The single most important file. Every failure mode the spec accepts is contained here.

- [ ] **Step 1:** A per-workspace handle cache keyed by resolved root, opened at `session_start` (**warm, never lazily inside the gate**), released on `gateway_stop`.
- [ ] **Step 2:** `withDeadline(ms, work, fallback)` — every engine call goes through it. The gate's deadline is well under the host's 15 s fail-closed budget and its fallback is *accept*.
- [ ] **Step 3:** `safely(fn)` — awaits inside its own try/catch, logs through the host logger, never rethrows, never floats.
- [ ] **Step 4:** Migration-level guard. Read `KNOWL_MIGRATION_LEVEL` off the file; if it exceeds the bundled engine's, disable the plugin with a readable reason. `SchemaTooNewError` cannot be the guard — `KNOWL_SCHEMA_VERSION` has moved once in 16 levels.
- [ ] **Step 5: Test the failure modes, not the happy path.** A throwing engine, a hanging engine (assert the gate still accepts), a stale migration level, and a floated rejection caught by `safely`.

---

### Task 7: The recall card

**Files:** modify `integrations/openclaw/src/index.ts`; test `tests/integrations/openclaw/hooks.test.ts`

- [ ] **Step 1:** `before_prompt_build` → `turn-start` → returns `{ prependContext: card }`.
- [ ] **Step 2: The regression test for #257, one host over.** Two different prompts in one session produce the **same** card. Assert no prompt substring reaches the engine payload.
- [ ] **Step 3:** Assert `agent_turn_prepare` and `heartbeat_prompt_contribution` are not registered — one publisher only.
- [ ] **Step 4:** Requires both `allowConversationAccess` and `allowPromptInjection`. Missing gates are **not** silent: OpenClaw rejects the registration with a `warn` diagnostic, surfaced by `openclaw plugins inspect`. Ship no bespoke doctor line.

---

### Task 8: The write gate

- [ ] **Step 1:** `before_tool_call` with `opts.matcher` on canonical ids (`exec`, `apply_patch`, `spawn_agent`) — wildcards are invalid, and matching keeps a non-write from starting work at all.
- [ ] **Step 2:** Return `{ block: true, blockReason }` on refusal. `block: false` is *no decision*, not an allow — return nothing to abstain.
- [ ] **Step 3: Never return `params`.** Codex relays reject rewrites and fail closed, killing the call.
- [ ] **Step 4:** `event.derivedPaths` is documented as possibly incomplete or over-approximate — a hint, never the sole basis for a refusal.
- [ ] **Step 5: Test that a stalled engine accepts.** The deadline fires, the gate returns accept, the write proceeds. This is the fail-closed trap, and it is the test that matters most in this task.

---

### Task 9: The impact card and capture

- [ ] **Step 1:** `api.registerAgentToolResultMiddleware(...)` — async, runtime-neutral, and it runs *before* output is fed back to the model. **Not `tool_result_persist`**, which only rewrites the transcript copy; the first draft of the spec got this wrong and the card would never have reached the model.
- [ ] **Step 2:** Card text goes in `content`, never only `details` — `details` is stripped before provider replay and compaction.
- [ ] **Step 3:** `after_tool_call` → `session-event` for capture. Observe kind: return value ignored, so it must still `await` inside `safely`.
- [ ] **Step 4:** `before_compaction` → `checkpoint`, **bounded** — it has a 30 s per-handler timeout and in the Codex harness runs on the serialized notification queue, where a hang freezes `turn/completed`.
- [ ] **Step 5:** `session_end` closes the turn. It shares a **2-second total drain budget** across all sessions and handlers, so nothing durable may depend on finishing there.

---

### Task 10: `knowl init openclaw`

**Files:** create `src/cli/agents/openclaw.ts`; modify `src/cli/agents/{types,registry}.ts`, `src/cli/program.ts`; test `tests/cli/openclaw-adapter.test.ts`

- [ ] **Step 1:** Merge into `openclaw.json`, never overwrite. Unparseable file → report and leave alone.
- [ ] **Step 2:** Write the plugin entry, **both** permission gates, and an explicit `plugins.entries.knowl.hooks.timeouts.before_tool_call` rather than inheriting the 15 s default.
- [ ] **Step 3:** Test that a config with unrelated user keys keeps them.

---

### Task 11: Docs and changelog

- [ ] **Step 1:** `docs/hosts.md` — the OpenClaw row, and that this host runs in-process while the others shell out.
- [ ] **Step 2:** `README.md` host list.
- [ ] **Step 3:** `CHANGELOG.md` — create `## Unreleased` (the last release consumed it) above the newest version heading.
- [ ] **Step 4:** `npm run docs:check`.

---

### Task 12: Full verification

- [ ] **Step 1:** `npm run build`, `npm test`, `npx eslint .`, `npm run typecheck`, `npm run docs:check`.
- [ ] **Step 2: Install the real way** — `openclaw plugins install npm-pack:<tgz>`, not `--link`. Only that path exercises the managed `--ignore-scripts` install.
- [ ] **Step 3:** `openclaw plugins inspect knowl --runtime --json` — every hook registered, **no blocked registrations**.
- [ ] **Step 4: Live gateway checks**, against a real session:
  - the card appears **once** in the built prompt;
  - the card is identical for two different prompts in one session;
  - a blocked write is refused and `blockReason` is visible to the model;
  - **two workspaces open in one gateway write to their own databases** (PR #258's regression at the plugin layer);
  - a stalled engine does not deny a write.
- [ ] **Step 5:** Measure the gate in situ and compare against the 0.68 ms / 118 ms figures in the spec. If the real number is materially worse, that is a finding, not a rounding error — record it.

---

## Risks

| Risk | Mitigation |
| --- | --- |
| libsql abort takes the gateway | Accepted, not mitigated. Native segfault is uncontainable; recorded in the spec. |
| Engine stall denies a user's write | Task 6 deadline + Task 8 Step 5. The single highest-value test in the plan. |
| Cross-project write | 5.21.1 scoping + Task 3 Step 4 + Task 12 Step 4. |
| Version skew on a shared file | Task 6 Step 4 migration-level guard. |
| `exports` map breaks Cline | Task 3 Step 1 wildcards + Step 2 resolution test. |
| Prompt text reaching the engine | Task 1 allowlist + Task 7 Step 2. |
