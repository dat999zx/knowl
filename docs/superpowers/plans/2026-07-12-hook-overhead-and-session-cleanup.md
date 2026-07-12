# Hook Overhead and Session Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove avoidable per-prompt hook work, make lifecycle sessions terminate predictably, and prevent repeated bootstrap when host identity fields vary.

**Architecture:** SessionStart remains the sole automatic context-delivery event. Prompt hooks become optional capture boundaries rather than context providers; turn capture can begin at the first tool event/stop event. Host identity normalization accepts only stable session identifiers, with explicit fallback precedence and regression coverage. Cleanup remains bounded and transactional.

**Current status:** `AGENTS.md` is already refreshed: lifecycle bootstrap is primary; `knowl_recent` is fallback/refresh-only. Do not change guidance unless a test proves it regresses.

**Tech Stack:** TypeScript, MCP stdio hooks, Drizzle/libSQL SQLite, Vitest.

---

### Task 1: Confirm the post-upgrade no-duplicate retrieval contract

**Files:**
- Test: `tests/cli/cli.test.ts`
- Test: `tests/cli/agent-lifecycle.test.ts`

- [ ] **Step 1: Add a guidance assertion**

Assert the generated Knowl section contains `Call \`knowl_recent\` only when hooks are unavailable or an explicit refresh is needed` and does not contain the old unconditional session-start instruction.

- [ ] **Step 2: Run the focused test**

Run: `rtk npm.cmd test -- --maxWorkers=1 tests/cli/cli.test.ts tests/cli/agent-lifecycle.test.ts`

Expected: PASS against the upgraded `AGENTS.md`/guidance.

- [ ] **Step 3: Record the result**

If this passes, no guidance code change is needed. If it fails, update only the generated Knowl section through `src/core/agents-guidance.ts`, then rerun the same command.

### Task 2: Remove redundant UserPromptSubmit process/DB work

**Files:**
- Modify: `src/cli/agents/hook-config.ts`
- Modify: `src/cli/agents/host-hook.ts`
- Modify: `src/store/host-lifecycle.ts`
- Test: `tests/cli/agent-adapters.test.ts`
- Test: `tests/store/host-lifecycle.test.ts`
- Test: `tests/cli/agent-lifecycle.test.ts`

- [ ] **Step 1: Write the failing behavior test**

Configure a gpt-5.6-sol project and assert lifecycle config does not install a `UserPromptSubmit` entry. Assert the first `PostToolUse`/`PostToolUseFailure` event still creates or finds the turn binding, captures the event, and `Stop` finalizes it. Assert `SessionStart` still emits one bootstrap context.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `rtk npm.cmd test -- --maxWorkers=1 tests/cli/agent-adapters.test.ts tests/store/host-lifecycle.test.ts tests/cli/agent-lifecycle.test.ts`

Expected: FAIL because the current config installs `UserPromptSubmit` and the current event flow assumes turn-start first.

- [ ] **Step 3: Implement the minimal event-flow change**

Remove `UserPromptSubmit` from the verified gpt-5.6-sol hook event arrays and config generation. Keep normalization support for backward compatibility. On `session-event`, `checkpoint`, or `turn-stop`, lazily create a turn binding when absent with `includeContext: false`; never call recent-context composition from those paths.

- [ ] **Step 4: Verify the tradeoff explicitly**

Document in the test name/comments: prompt-only turns without tool events produce no durable session candidate; this is intentional because prompt bodies are discarded and context is delivered by SessionStart.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: PASS; no prompt hook process, no prompt-hook context, tool/stop capture preserved.

### Task 3: Stabilize host session/turn identity normalization

**Files:**
- Modify: `src/cli/agents/host-hook.ts`
- Test: `tests/cli/host-hook.test.ts`
- Test: `tests/store/host-lifecycle.test.ts`
- Test: `tests/cli/agent-lifecycle.test.ts`

- [ ] **Step 1: Write failing identity tests**

Cover payloads where `session_id`/`turn_id` are present, plus the supported host fallback fields. Send two prompt/tool events with the same stable fallback session identity and assert only the first can produce bootstrap context. Assert missing all session identity fields still fails closed with a clear validation error.

- [ ] **Step 2: Run tests and verify RED**

Run: `rtk npm.cmd test -- --maxWorkers=1 tests/cli/host-hook.test.ts tests/store/host-lifecycle.test.ts tests/cli/agent-lifecycle.test.ts`

Expected: FAIL for fallback identity payloads.

- [ ] **Step 3: Add explicit fallback precedence**

Use host-specific stable fields only:

```ts
session: session_id -> conversation_id -> thread_id
turn: turn_id -> generation_id
```

Do not use a generation/turn identifier as a session identifier. Preserve current length bounds and validation.

- [ ] **Step 4: Run tests and verify GREEN**

Run the command from Step 2. Expected: PASS; stable identity prevents fallback bootstrap repetition.

### Task 4: Bound lifecycle-session cleanup

**Files:**
- Modify: `src/store/host-lifecycle.ts`
- Modify: `src/store/host-session-bindings.ts`
- Modify: `src/store/session-repository.ts` (only if cleanup query belongs there)
- Test: `tests/store/host-lifecycle.test.ts`
- Test: `tests/store/host-session-bindings.test.ts`

- [ ] **Step 1: Write failing cleanup tests**

Create an active host binding whose memory session is terminal or older than the abandonment threshold. Run the next SessionStart/recovery path and assert the binding is inactive, stale rows are not reused, and current-session bootstrap remains available.

- [ ] **Step 2: Run tests and verify RED**

Run: `rtk npm.cmd test -- --maxWorkers=1 tests/store/host-lifecycle.test.ts tests/store/host-session-bindings.test.ts`

Expected: FAIL because stale bindings are only invalidated when individually looked up and Codex has no configured SessionEnd event.

- [ ] **Step 3: Implement bounded cleanup**

Add one transactional cleanup operation invoked during SessionStart/recovery: deactivate bindings whose referenced session is terminal or expired, without deleting audit rows. Keep the existing two-hour abandoned-session policy; do not shorten it or promote recovered sessions.

- [ ] **Step 4: Decide SessionEnd support from verified host behavior**

If the host’s verified hook schema supports SessionEnd, add it to the host event list and test terminal cleanup. Otherwise leave it unconfigured and rely on the bounded SessionStart cleanup path; do not add an unverified hook event solely for symmetry.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: PASS; stale bindings cannot cause context duplication or unbounded active-session growth.

### Task 5: Integration verification and rollout

**Files:**
- Modify: `README.md` only if behavior wording needs correction.
- Test: `tests/performance/token-budget.test.ts`

- [ ] **Step 1: Add end-to-end assertions**

Measure a real configured project: one SessionStart response contains bounded `additionalContext`; repeated prompt/tool events contain no `additionalContext`; hook invocation count excludes UserPromptSubmit after Task 2; session cleanup leaves no reusable stale binding.

- [ ] **Step 2: Run verification**

Run:

```text
rtk npm.cmd test -- --maxWorkers=1
rtk npm.cmd run build
rtk git diff --check
```

Expected: all tests pass, build exit `0`, no whitespace errors.

- [ ] **Step 3: Rollout check**

Run `knowl init`/upgrade for existing projects, verify generated hook config, then start a new trusted Codex session. Existing running sessions cannot retroactively receive SessionStart configuration changes.
