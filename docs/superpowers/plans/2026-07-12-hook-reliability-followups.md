# Hook Reliability Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove retired prompt hooks, preserve one-time bootstrap, and make verification reliable.

**Architecture:** Every supported host uses `SessionStart` as the sole context-delivery event. Hook config migration removes only Knowl-owned retired entries. Vitest worker failure is diagnosed separately; do not mask it with a retry.

**Tech Stack:** TypeScript, Vitest, Node.js.

---

### Task 1: Retire stale owned prompt hooks

**Files:** `src/cli/agents/hook-config.ts`, `tests/cli/agent-adapters.test.ts`

- [ ] Add config fixtures with old owned gpt-5.6-terra/Cursor prompt hooks plus non-Knowl hooks.
- [ ] Verify RED: `configureLifecycle` leaves retired Knowl entries.
- [ ] Remove only owned entries from retired event keys; delete an empty key.
- [ ] Verify GREEN with `rtk npm.cmd test -- --maxWorkers=1 tests/cli/agent-adapters.test.ts`.

### Task 2: Make SessionStart sole bootstrap event

**Files:** `src/cli/agents/hook-config.ts`, `tests/cli/agent-adapters.test.ts`, `src/store/host-lifecycle.ts`, `tests/store/host-lifecycle.test.ts`

- [ ] Assert all three host configs omit prompt hooks.
- [ ] Verify RED.
- [ ] Remove Claude `UserPromptSubmit` and Cursor `beforeSubmitPrompt`; tool/stop paths remain capture-only.
- [ ] Verify focused adapter/lifecycle tests.

### Task 3: Prevent prompt-hook fallback regression

**Files:** `src/store/host-lifecycle.ts`, `tests/store/host-lifecycle.test.ts`

- [ ] Assert a missing SessionStart binding on a tool event captures without context.
- [ ] Verify existing behavior is green; no implementation change unless assertion fails.

### Task 4: Diagnose Vitest worker shutdown

**Files:** `vitest.config.*` or `package.json` only if root cause is project configuration.

- [ ] Reproduce full serial suite and inspect exact failing worker/suite.
- [ ] Compare against isolated suite execution.
- [ ] Add only a root-cause fix plus regression verification; otherwise report external runner defect without masking it.
