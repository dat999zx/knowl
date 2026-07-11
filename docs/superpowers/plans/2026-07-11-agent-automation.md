# Agent Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make session capture and context bootstrap automatic for agents with lifecycle hooks while preserving a tested `knowl task run` fallback everywhere else.

**Architecture:** Extend the existing MCP-only agent adapters with a capability interface. Each adapter either installs/verifies an exact host hook configuration or reports `unsupported`; no adapter claims support from a guessed file format. All hooks invoke one small `knowl agent-event` entrypoint, which delegates to the Plan 4/5 session services.

**Tech Stack:** TypeScript, Commander, JSON/TOML adapter files, existing MCP registration, session services, Vitest.

---

### Task 1: Define lifecycle capability and hook command contracts

**Files:**
- Modify: `src/cli/agents/types.ts`
- Create: `src/cli/agents/lifecycle.ts`
- Modify: `src/index.ts`
- Test: `tests/cli/agent-lifecycle.test.ts`

- [ ] **Step 1: Write failing capability tests**

Assert adapters can report `supported`, `unsupported`, or `degraded`; hook events validate against `session-start`, `session-event`, `session-stop`, and `session-recover`; malformed payloads return a safe non-zero result without exposing secrets.

- [ ] **Step 2: Run focused test and verify failure**

Run: `rtk npm.cmd test -- tests/cli/agent-lifecycle.test.ts`

Expected: FAIL because lifecycle types/command do not exist.

- [ ] **Step 3: Add capability types and entrypoint**

Extend `AgentAdapter` with optional methods:

```ts
type LifecycleCapability = 'supported' | 'unsupported' | 'degraded';
type LifecycleEvent = 'session-start' | 'session-event' | 'session-stop' | 'session-recover';

interface AgentLifecycleAdapter {
  lifecycleCapability(projectRoot: string): Promise<LifecycleCapability>;
  configureLifecycle(projectRoot: string): Promise<AgentIntegrationResult>;
  verifyLifecycle(projectRoot: string): Promise<boolean>;
}
```

Register `knowl agent-event <event>` with `--session`, structured flags, and stdin support for a bounded JSON payload. Delegate to session capture/finalizer services; return success even for best-effort event loss, but return non-zero for invalid configuration or secret rejection.

- [ ] **Step 4: Run focused test and commit**

Run: `rtk npm.cmd test -- tests/cli/agent-lifecycle.test.ts`

Expected: PASS.

```bash
rtk git add src/cli/agents/types.ts src/cli/agents/lifecycle.ts src/index.ts tests/cli/agent-lifecycle.test.ts
rtk git commit -m "feat: add agent lifecycle event contract"
```

### Task 2: Implement exact host adapters with safe fallback

**Files:**
- Modify: `src/cli/agents/project-adapters.ts`
- Modify: `src/cli/agents/desktop-adapter.ts`
- Modify: `src/cli/agents/files.ts`
- Create: `src/cli/agents/lifecycle-config.ts`
- Test: `tests/cli/agent-adapters.test.ts`

- [ ] **Step 1: Add fixture-driven adapter tests**

For every supported host configuration, start with an exact fixture containing unrelated settings. Assert lifecycle configuration is additive/idempotent, backups are created before mutation, unrelated settings survive, and verification rejects malformed/partial hook entries. For a host without a verified hook schema, assert `unsupported` and no file mutation.

- [ ] **Step 2: Run focused test and verify failure**

Run: `rtk npm.cmd test -- tests/cli/agent-adapters.test.ts`

Expected: FAIL because lifecycle configuration methods do not exist.

- [ ] **Step 3: Implement adapter capability reporting**

Keep current MCP registration unchanged. Add only host formats confirmed by fixture tests and local documentation. Store the command as a platform-safe absolute/entrypoint invocation of `knowl agent-event`; never embed project secrets in configuration. Unsupported adapters return a clear fallback message.

- [ ] **Step 4: Verify and commit**

Run: `rtk npm.cmd test -- tests/cli/agent-adapters.test.ts`

Expected: PASS.

```bash
rtk git add src/cli/agents/project-adapters.ts src/cli/agents/desktop-adapter.ts src/cli/agents/files.ts src/cli/agents/lifecycle-config.ts tests/cli/agent-adapters.test.ts
rtk git commit -m "feat: add safe agent lifecycle adapters"
```

### Task 3: Integrate lifecycle setup into `knowl init` and doctor

**Files:**
- Modify: `src/cli/init-flow.ts`
- Modify: `src/cli/agents/registry.ts`
- Modify: `src/cli/doctor-report.ts`
- Modify: `src/index.ts`
- Test: `tests/cli/init-flow.test.ts`
- Test: `tests/cli/cli.test.ts`

- [ ] **Step 1: Write failing setup tests**

Assert plain `knowl init` shows MCP and lifecycle statuses separately, explicit agent initialization is additive/idempotent, unsupported lifecycle adapters still configure MCP, and doctor reports the wrapper fallback rather than failing readiness.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `rtk npm.cmd test -- tests/cli/init-flow.test.ts tests/cli/cli.test.ts`

Expected: FAIL because init/doctor only know MCP configuration.

- [ ] **Step 3: Implement additive orchestration**

Run lifecycle configuration after successful MCP configuration. Preserve existing confirmation rules for global files. A lifecycle configuration failure must report the agent result and leave MCP configuration intact. Reruns compare exact entries and do not duplicate hooks.

- [ ] **Step 4: Verify and commit**

Run: `rtk npm.cmd test -- tests/cli/init-flow.test.ts tests/cli/cli.test.ts`; `rtk npm.cmd run build`

Expected: PASS.

```bash
rtk git add src/cli/init-flow.ts src/cli/agents/registry.ts src/cli/doctor-report.ts src/index.ts tests/cli/init-flow.test.ts tests/cli/cli.test.ts
rtk git commit -m "feat: report and install agent lifecycle automation"
```

### Task 4: Make automatic context bootstrap host-neutral

**Files:**
- Create: `src/store/context-bootstrap.ts`
- Modify: `src/index.ts`
- Modify: `src/mcp/resources.ts`
- Modify: `src/core/agents-guidance.ts`
- Test: `tests/store/context-bootstrap.test.ts`
- Test: `tests/cli/cli.test.ts`

- [ ] **Step 1: Write failing bootstrap tests**

Assert bootstrap starts/reuses a session, calls recent/context retrieval once, writes only bounded text, and is idempotent for the same session ID. Assert it falls back to existing `knowl_recent` output when the advanced context composer is not installed yet.

- [ ] **Step 2: Run focused test and verify failure**

Run: `rtk npm.cmd test -- tests/store/context-bootstrap.test.ts tests/cli/cli.test.ts`

Expected: FAIL because the bootstrap module does not exist.

- [ ] **Step 3: Implement bootstrap service and CLI hook**

Expose `bootstrapAgentSession({ title, query, agent, sessionId? })`. It creates/reuses the session, obtains compact recent context, and returns a bounded machine-readable payload for host hooks. Do not append large context to `AGENTS.md`.

- [ ] **Step 4: Shorten generated guidance**

Keep `AGENTS.md` instructions as fallback: explain that `knowl init` installs automation and `knowl task run` is the manual fallback. Remove repetitive requirements that the model call every lifecycle operation, while retaining security rules for direct conversation.

- [ ] **Step 5: Verify and commit**

Run: `rtk npm.cmd test -- tests/store/context-bootstrap.test.ts tests/cli/cli.test.ts`; `rtk npm.cmd run build`; `rtk git diff --check`

Expected: PASS.

```bash
rtk git add src/store/context-bootstrap.ts src/index.ts src/mcp/resources.ts src/core/agents-guidance.ts tests/store/context-bootstrap.test.ts tests/cli/cli.test.ts
rtk git commit -m "feat: bootstrap agent sessions and context automatically"
```

### Task 5: Validate end-to-end fallback behavior

**Files:**
- Modify: `tests/cli/cli.test.ts`
- Modify: `tests/mcp/server.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Add end-to-end cases**

Cover a supported hook, an unsupported host using `knowl task run`, a hook process crash, duplicate init, and a secret-rejected event. Assert the agent task still receives its original exit code and the next session can recover unfinished state.

- [ ] **Step 2: Run complete verification**

Run: `rtk npm.cmd test`; `rtk npm.cmd run build`; `rtk git diff --check`

Expected: PASS.

- [ ] **Step 3: Document capability reporting**

Document that hook support is host-specific, unsupported agents remain fully usable through the wrapper, and no hook stores raw transcripts.

- [ ] **Step 4: Commit and store outcome**

```bash
rtk git add tests/cli/cli.test.ts tests/mcp/server.test.ts README.md
rtk git commit -m "docs: document automatic agent lifecycle fallback"
```

Store the supported/degraded/unsupported behavior and verification commit in Knowl.
