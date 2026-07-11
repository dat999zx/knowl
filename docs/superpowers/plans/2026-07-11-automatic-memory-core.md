# Automatic Memory Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture bounded project-session activity independently of model write-back, with expiring scratch records and deterministic crash recovery.

**Architecture:** A session is a state machine (`active`, `finished`, `failed`, `abandoned`, `recovered`). `session_events` stores bounded metadata, not transcripts. Capture APIs are synchronous enough for CLI use and best-effort for hooks; event loss never blocks the agent task.

**Tech Stack:** TypeScript, SQLite/libSQL, Drizzle schema/bootstrap, Commander, Git CLI, Vitest.

---

### Task 1: Add session and event schema

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/store/schema.ts`
- Modify: `src/store/bootstrap.ts`
- Test: `tests/store/session-schema.test.ts`

- [ ] **Step 1: Write failing schema tests**

Assert fresh/idempotent creation of `memory_sessions` and `memory_session_events`, indexes on status/heartbeat/expiry, foreign-key cascade from session to events, and allowed event/session statuses at the repository boundary.

- [ ] **Step 2: Run focused test and verify failure**

Run: `rtk npm.cmd test -- tests/store/session-schema.test.ts`

Expected: FAIL because the tables/types do not exist.

- [ ] **Step 3: Define types and SQL**

Add:

```ts
export type SessionStatus = 'active' | 'finished' | 'failed' | 'abandoned' | 'recovered';
export type SessionEventType = 'start' | 'command' | 'test' | 'error' | 'git' | 'decision' | 'checkpoint' | 'stop';

export interface MemorySession {
  id: string;
  agent?: string | null;
  title: string;
  query?: string | null;
  status: SessionStatus;
  startedAt: string;
  lastHeartbeatAt: string;
  finishedAt?: string | null;
  baselineCommit?: string | null;
  expiresAt: string;
}

export interface MemorySessionEvent {
  id: string;
  sessionId: string;
  type: SessionEventType;
  payload: Record<string, unknown>;
  observedAt: string;
  expiresAt: string;
}
```

Create tables with JSON payload text, status indexes, and foreign keys. Keep the existing compact project scope; do not add a `project_id` column.

- [ ] **Step 4: Run focused test and commit**

Run: `rtk npm.cmd test -- tests/store/session-schema.test.ts`

Expected: PASS.

```bash
rtk git add src/core/types.ts src/store/schema.ts src/store/bootstrap.ts tests/store/session-schema.test.ts
rtk git commit -m "feat: add session and scratch event schema"
```

### Task 2: Implement bounded session repository APIs

**Files:**
- Create: `src/store/session-repository.ts`
- Create: `src/store/session-capture.ts`
- Test: `tests/store/session-repository.test.ts`

- [ ] **Step 1: Write failing repository tests**

Cover start, heartbeat, append event, finish, fail, list active, recover stale sessions, purge expired events, and idempotent finish. Assert payloads are truncated, secret-validated through Plan 1, and raw transcript-shaped fields are rejected.

- [ ] **Step 2: Run focused test and verify failure**

Run: `rtk npm.cmd test -- tests/store/session-repository.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement session state transitions**

Expose:

```ts
startMemorySession(input: { title: string; query?: string; agent?: string; ttlHours?: number }): Promise<MemorySession>;
heartbeatMemorySession(id: string): Promise<MemorySession>;
appendMemorySessionEvent(id: string, type: SessionEventType, payload: Record<string, unknown>): Promise<MemorySessionEvent>;
finishMemorySession(id: string, status: 'finished' | 'failed', summary?: string): Promise<MemorySession>;
recoverAbandonedSessions(now?: string): Promise<MemorySession[]>;
purgeExpiredSessionEvents(now?: string): Promise<number>;
```

Use one transaction per state transition. Reject events for terminal sessions, except a single recovery/stop marker. Set default event TTL to 48 hours and session TTL to seven days.

- [ ] **Step 4: Add capture normalization**

`session-capture.ts` accepts only bounded fields: command name/exit code, test command/result, error code/message summary, changed paths, diff stat, commit ID, and explicit decision text. Strip stdout/stderr bodies unless the caller supplies a short safe excerpt.

- [ ] **Step 5: Run focused tests and commit**

Run: `rtk npm.cmd test -- tests/store/session-repository.test.ts`

Expected: PASS.

```bash
rtk git add src/store/session-repository.ts src/store/session-capture.ts tests/store/session-repository.test.ts
rtk git commit -m "feat: add bounded session event capture"
```

### Task 3: Add session CLI commands

**Files:**
- Modify: `src/index.ts`
- Test: `tests/cli/session-cli.test.ts`

- [ ] **Step 1: Write failing CLI tests**

Test:

```text
knowl session start "Implement search" --query "retrieval"
knowl session event <id> command --exit-code 1 --summary "test command failed"
knowl session finish <id> --status failed --summary "failure recorded"
knowl session recover
```

Assert JSON mode returns stable IDs/statuses and text mode never prints event payload secrets.

- [ ] **Step 2: Run focused test and verify failure**

Run: `rtk npm.cmd test -- tests/cli/session-cli.test.ts`

Expected: FAIL because commands are not registered.

- [ ] **Step 3: Implement Commander commands**

Reuse existing project discovery and database initialization. `session start` prints the ID and compact recent context only when requested. `session event` validates the event type and accepts structured options rather than arbitrary JSON by default. `session recover` reports recovered count and purged event count.

- [ ] **Step 4: Run focused tests and commit**

Run: `rtk npm.cmd test -- tests/cli/session-cli.test.ts`

Expected: PASS.

```bash
rtk git add src/index.ts tests/cli/session-cli.test.ts
rtk git commit -m "feat: add session lifecycle CLI commands"
```

### Task 4: Integrate existing work loops and verify recovery

**Files:**
- Modify: `src/store/work-loop.ts`
- Modify: `src/index.ts`
- Modify: `src/mcp/tools.ts`
- Test: `tests/store/work-loop.test.ts`
- Test: `tests/cli/cli.test.ts`

- [ ] **Step 1: Add failing integration tests**

Assert `knowl task run` starts a memory session, appends command success/failure events, finishes or fails the session, and preserves the child exit code. Assert manual MCP task tools append the same event shape. Simulate an abandoned active session and verify the next start recovers it.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `rtk npm.cmd test -- tests/store/work-loop.test.ts tests/cli/cli.test.ts`

Expected: FAIL because work loops currently write only state atoms/commits.

- [ ] **Step 3: Integrate without changing existing work-loop output**

Start the session alongside the existing work-loop item, write bounded events at command start/exit/checkpoint, and finish/fail both records. If session capture fails, preserve the existing work-loop behavior and print one warning to stderr.

- [ ] **Step 4: Verify and commit**

Run: `rtk npm.cmd test -- tests/store/work-loop.test.ts tests/cli/cli.test.ts`; `rtk npm.cmd run build`; `rtk git diff --check`

Expected: PASS.

```bash
rtk git add src/store/work-loop.ts src/index.ts src/mcp/tools.ts tests/store/work-loop.test.ts tests/cli/cli.test.ts
rtk git commit -m "feat: capture work-loop lifecycle events"
```

### Task 5: Plan completion checkpoint

**Files:**
- Modify: `README.md`
- Modify: `src/cli/doctor-report.ts`

- [ ] **Step 1: Document scratch TTL, event bounds, and recovery behavior**

Explain that session events are temporary and not equivalent to a transcript archive. Doctor reports schema readiness and stale active sessions.

- [ ] **Step 2: Run full verification**

Run: `rtk npm.cmd test`; `rtk npm.cmd run build`; `rtk git diff --check`

Expected: PASS.

- [ ] **Step 3: Store the completed-plan outcome in Knowl**

Record schema names, state transitions, TTLs, work-loop integration, and verification commit.
