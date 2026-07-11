# Host-Neutral Agent Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for inline implementation. Do not dispatch subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install project-local lifecycle hooks that automatically capture, validate, and promote useful memory for Codex CLI, Claude Code, Cursor, and any host using Knowl's generic stdin-JSON contract.

**Architecture:** Vendor adapters only install and verify documented hook files. A shared `agent-hook` translator normalizes vendor JSON into one bounded lifecycle event, correlates external session/turn IDs with internal Knowl sessions, and delegates to existing bootstrap, capture, finish, recovery, and promotion services. Hosts without verified hooks remain MCP-only and are reported honestly.

**Tech Stack:** TypeScript, Commander, JSON hook files, SQLite/libSQL, existing Knowl session services, Vitest.

---

### Task 1: Define and normalize the host-neutral hook contract

**Files:**
- Create: `src/cli/agents/host-hook.ts`
- Modify: `src/cli/agents/types.ts`
- Test: `tests/cli/host-hook.test.ts`

- [x] **Step 1: Write failing normalization tests**

Create fixtures for documented Codex, Claude Code, Cursor, and generic payloads. Assert they produce the same internal shape:

```ts
expect(normalizeHostHook('codex', 'UserPromptSubmit', {
  session_id: 'session-1',
  turn_id: 'turn-1',
  cwd: ROOT,
  prompt: 'Fix authentication',
})).toMatchObject({
  host: 'codex',
  event: 'turn-start',
  externalSessionId: 'session-1',
  externalTurnId: 'turn-1',
  projectRoot: ROOT,
  title: 'Agent turn',
});

expect(normalizeHostHook('cursor', 'afterShellExecution', {
  conversation_id: 'session-2',
  generation_id: 'turn-2',
  workspace_roots: [ROOT],
  command: 'npm test',
  exit_code: 0,
})).toMatchObject({
  event: 'session-event',
  type: 'command',
  payload: { command: 'npm test', exitCode: 0 },
});
```

Also assert unknown fields, prompt bodies, transcripts, stdout/stderr, environment variables, and oversized values are not returned.

- [x] **Step 2: Run test and verify RED**

Run: `rtk npm.cmd test -- tests/cli/host-hook.test.ts --maxWorkers=1`

Expected: FAIL because `host-hook.ts` does not exist.

- [x] **Step 3: Implement the minimal contract**

Add:

```ts
export type HookHost = AgentName | 'generic';
export type NormalizedHookEventName =
  | 'session-start'
  | 'turn-start'
  | 'session-event'
  | 'checkpoint'
  | 'turn-stop'
  | 'session-stop';

export interface NormalizedHostHook {
  host: HookHost;
  event: NormalizedHookEventName;
  externalSessionId: string;
  externalTurnId?: string;
  projectRoot: string;
  title?: string;
  status?: 'finished' | 'failed';
  type?: SessionEventType;
  payload: Record<string, unknown>;
}
```

Implement explicit event maps:

```ts
const CODEX_EVENTS = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'turn-start',
  PostToolUse: 'session-event',
  PostToolUseFailure: 'session-event',
  PreCompact: 'checkpoint',
  Stop: 'turn-stop',
} as const;

const CLAUDE_EVENTS = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'turn-start',
  PostToolUse: 'session-event',
  PostToolUseFailure: 'session-event',
  PreCompact: 'checkpoint',
  Stop: 'turn-stop',
  StopFailure: 'turn-stop',
  SessionEnd: 'session-stop',
} as const;

const CURSOR_EVENTS = {
  sessionStart: 'session-start',
  beforeSubmitPrompt: 'turn-start',
  afterShellExecution: 'session-event',
  postToolUse: 'session-event',
  postToolUseFailure: 'session-event',
  afterFileEdit: 'session-event',
  preCompact: 'checkpoint',
  stop: 'turn-stop',
  sessionEnd: 'session-stop',
} as const;
```

All strings are bounded before validation; only allowlisted metadata enters `payload`.

- [x] **Step 4: Verify GREEN and commit**

Run: `rtk npm.cmd test -- tests/cli/host-hook.test.ts --maxWorkers=1`

Expected: PASS.

```powershell
rtk git add src/cli/agents/host-hook.ts src/cli/agents/types.ts tests/cli/host-hook.test.ts
rtk git commit -m "feat: normalize agent host lifecycle events"
```

### Task 2: Persist external-host session correlation

**Files:**
- Modify: `src/store/bootstrap.ts`
- Modify: `src/store/schema.ts`
- Modify: `src/store/session-repository.ts`
- Create: `src/store/host-session-bindings.ts`
- Test: `tests/store/host-session-bindings.test.ts`

- [x] **Step 1: Write failing binding tests**

Assert `(host, project root, external session, external turn)` resolves idempotently to one active internal session, `turn-stop` closes the binding, the next turn gets a new session, and abandoned bindings recover safely.

```ts
const first = await getOrCreateHostSession({
  projectId,
  projectRoot: ROOT,
  host: 'generic',
  externalSessionId: 's1',
  externalTurnId: 't1',
  title: 'Agent turn',
});
const reused = await getOrCreateHostSession({
  projectId,
  projectRoot: ROOT,
  host: 'generic',
  externalSessionId: 's1',
  externalTurnId: 't1',
  title: 'ignored',
});
expect(reused.session.id).toBe(first.session.id);
```

- [x] **Step 2: Run test and verify RED**

Run: `rtk npm.cmd test -- tests/store/host-session-bindings.test.ts --maxWorkers=1`

Expected: FAIL because binding storage does not exist.

- [x] **Step 3: Add schema and repository**

Add idempotent schema:

```sql
CREATE TABLE IF NOT EXISTS host_session_bindings (
  host TEXT NOT NULL,
  project_root TEXT NOT NULL,
  external_session_id TEXT NOT NULL,
  external_turn_id TEXT NOT NULL DEFAULT '',
  memory_session_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (host, project_root, external_session_id, external_turn_id),
  FOREIGN KEY (memory_session_id) REFERENCES memory_sessions(id) ON DELETE CASCADE
);
```

Expose `getOrCreateHostSession`, `findHostSession`, `closeHostSessionBinding`, and `closeHostSessionBindings`. Use existing `bootstrapAgentSession` for creation/reuse; never accept an external ID as the internal primary key.

- [x] **Step 4: Verify GREEN and commit**

Run: `rtk npm.cmd test -- tests/store/host-session-bindings.test.ts --maxWorkers=1`

Expected: PASS.

```powershell
rtk git add src/store/database.ts src/store/host-session-bindings.ts tests/store/host-session-bindings.test.ts
rtk git commit -m "feat: correlate host turns with memory sessions"
```

### Task 3: Execute normalized hooks through existing memory services

**Files:**
- Create: `src/store/host-lifecycle.ts`
- Modify: `src/index.ts`
- Test: `tests/store/host-lifecycle.test.ts`
- Modify: `tests/cli/agent-lifecycle.test.ts`

- [x] **Step 1: Write failing orchestration tests**

Feed a sequence of normalized events and assert:

1. `session-start` recovers abandoned sessions and returns bounded context.
2. `turn-start` creates/reuses a binding.
3. command/test/git/error/checkpoint events use `captureMemorySessionEvent`.
4. `turn-stop` calls `finishMemorySession`, `finalizeMemorySession`, closes the binding, and is retry-safe.
5. secret payloads fail before any session/event row is written.

Expected response for context-capable hosts:

```ts
expect(result.hostOutput).toEqual({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: expect.stringContaining('KNOWL'),
  },
});
```

- [x] **Step 2: Run tests and verify RED**

Run: `rtk npm.cmd test -- tests/store/host-lifecycle.test.ts tests/cli/agent-lifecycle.test.ts --maxWorkers=1`

Expected: FAIL because orchestration and `agent-hook` CLI do not exist.

- [x] **Step 3: Implement orchestration and CLI**

Expose:

```ts
export async function handleHostLifecycleEvent(
  projectId: string,
  input: NormalizedHostHook,
): Promise<HostLifecycleResult>
```

Register:

```text
knowl agent-hook <host> <event> --json
```

The command reads one bounded JSON object from stdin, normalizes it, resolves the project from `cwd`, initializes the local DB, delegates to `handleHostLifecycleEvent`, and prints JSON only. Existing `knowl agent-event` remains available for compatibility.

Codex and Claude context output uses `hookSpecificOutput.hookEventName/additionalContext`. Cursor/generic output includes `{ accepted, sessionId, context? }` without vendor-specific control fields.

- [x] **Step 4: Verify GREEN and commit**

Run: `rtk npm.cmd test -- tests/store/host-lifecycle.test.ts tests/cli/agent-lifecycle.test.ts --maxWorkers=1`

Expected: PASS.

```powershell
rtk git add src/store/host-lifecycle.ts src/index.ts tests/store/host-lifecycle.test.ts tests/cli/agent-lifecycle.test.ts
rtk git commit -m "feat: process automatic agent lifecycle hooks"
```

### Task 4: Install verified project-local hooks

**Files:**
- Modify: `src/cli/agents/files.ts`
- Create: `src/cli/agents/hook-config.ts`
- Modify: `src/cli/agents/project-adapters.ts`
- Modify: `src/cli/agents/cursor.ts`
- Test: `tests/cli/agent-adapters.test.ts`

- [ ] **Step 1: Replace unsupported fixture test with failing supported-host tests**

Assert exact project-local files:

- Codex: `.codex/hooks.json`
- Claude Code: `.claude/settings.local.json`
- Cursor: `.cursor/hooks.json`
- Claude Desktop: remains `unsupported` because it has no verified project lifecycle hook surface

For every supported file, assert unrelated entries survive, `.backup` is created before updates, repeated initialization is unchanged, and partial/wrong Knowl entries fail verification.

- [ ] **Step 2: Run test and verify RED**

Run: `rtk npm.cmd test -- tests/cli/agent-adapters.test.ts --maxWorkers=1`

Expected: FAIL because adapters report lifecycle `unsupported`.

- [ ] **Step 3: Implement merge helpers and entries**

Add a JSON hook merge helper that owns entries tagged with a stable command prefix:

```ts
export function knowlHookCommand(platform: NodeJS.Platform, host: HookHost, event: string) {
  const executable = platform === 'win32' ? 'knowl.cmd' : 'knowl';
  return `${executable} agent-hook ${host} ${event} --json`;
}
```

Install only bounded capture events:

- Codex: `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `PreCompact`, `Stop`.
- Claude Code: same plus `StopFailure`, `SessionEnd`.
- Cursor: `sessionStart`, `beforeSubmitPrompt`, `afterShellExecution`, `postToolUse`, `postToolUseFailure`, `afterFileEdit`, `preCompact`, `stop`, `sessionEnd`.

Do not install pre-tool blocking hooks, transcript readers, response/thought capture, or global configuration.

- [ ] **Step 4: Verify GREEN and commit**

Run: `rtk npm.cmd test -- tests/cli/agent-adapters.test.ts --maxWorkers=1`

Expected: PASS.

```powershell
rtk git add src/cli/agents/files.ts src/cli/agents/hook-config.ts src/cli/agents/project-adapters.ts src/cli/agents/cursor.ts tests/cli/agent-adapters.test.ts
rtk git commit -m "feat: install project-local agent hooks"
```

### Task 5: Integrate setup, upgrade, and diagnostics

**Files:**
- Modify: `src/cli/init-flow.ts`
- Modify: `src/cli/doctor-report.ts`
- Modify: `tests/cli/init-flow.test.ts`
- Modify: `tests/cli/cli.test.ts`

- [ ] **Step 1: Write failing init/doctor tests**

Assert:

- `knowl init codex claude cursor` configures MCP and hooks separately.
- Plain interactive init configures detected hosts.
- Rerunning init upgrades an old `.knowl` project without replacing its DB.
- Doctor reports each host as supported/configured, supported/missing, unsupported, or degraded.
- Missing hooks produce `WARN` with `run knowl init <host>`; verified hooks produce `OK`.

- [ ] **Step 2: Run tests and verify RED**

Run: `rtk npm.cmd test -- tests/cli/init-flow.test.ts tests/cli/cli.test.ts --maxWorkers=1`

Expected: FAIL because init/doctor still report all lifecycle adapters unsupported.

- [ ] **Step 3: Implement exact reporting**

Keep MCP success independent from hook success. A supported-but-unconfigured hook is a warning, not a reason to corrupt or remove MCP configuration. `knowl upgrade` continues schema/config maintenance; `knowl init` is the operation that detects and installs host integrations.

- [ ] **Step 4: Verify GREEN and commit**

Run: `rtk npm.cmd test -- tests/cli/init-flow.test.ts tests/cli/cli.test.ts --maxWorkers=1`

Expected: PASS.

```powershell
rtk git add src/cli/init-flow.ts src/cli/doctor-report.ts tests/cli/init-flow.test.ts tests/cli/cli.test.ts
rtk git commit -m "feat: diagnose automatic host memory capture"
```

### Task 6: Document generic-host integration and verify end-to-end

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-07-11-host-neutral-agent-hooks.md`
- Modify: `tests/cli/agent-lifecycle.test.ts`

- [ ] **Step 1: Add end-to-end CLI coverage**

In a temporary old Knowl project:

1. Run `init codex claude cursor` with fixture adapters.
2. Pipe documented JSON to `agent-hook generic turn-start`, event, and turn-stop.
3. Verify a session is finalized and a durable item/evidence link is promoted.
4. Repeat stop and assert no duplicate item.
5. Pipe a secret and assert no DB mutation plus no secret echo.
6. Simulate stale active state and verify session-start recovery.

- [ ] **Step 2: Document human setup**

Document only user-facing setup:

```powershell
knowl init
knowl doctor
```

Also document explicit setup:

```powershell
knowl init codex claude cursor
```

Explain that a trusted project and new host session may be required. Document the generic contract as an integration API for unsupported hosts, not a normal user command.

- [ ] **Step 3: Run focused and full verification**

Run:

```powershell
rtk npm.cmd test -- tests/cli/agent-lifecycle.test.ts --maxWorkers=1
rtk npm.cmd test -- --maxWorkers=1
rtk npm.cmd run build
rtk git diff --check
rtk node dist/index.js doctor
```

Expected: all tests pass, build exits 0, diff check is clean, doctor reports verified lifecycle support for configured local fixtures/current host.

- [ ] **Step 4: Commit and store durable outcome**

```powershell
rtk git add README.md tests/cli/agent-lifecycle.test.ts docs/superpowers/plans/2026-07-11-host-neutral-agent-hooks.md
rtk git commit -m "docs: document automatic agent memory setup"
```

Store one concise Knowl atom describing supported hosts, generic adapter behavior, setup command, security boundary, and verification commit.
