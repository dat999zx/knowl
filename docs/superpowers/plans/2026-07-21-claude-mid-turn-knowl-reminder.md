# Claude Mid-Turn Knowl Reminder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-inject a compact Knowl workflow reminder during long Claude responses after every eight accepted successful tool calls.

**Architecture:** Reuse Claude's existing `PostToolUse` lifecycle process. Store an atomic per-turn successful-tool counter on `host_session_bindings`, and return Claude `additionalContext` only when the counter is divisible by eight; the full prompt-time operational card remains unchanged.

**Tech Stack:** TypeScript, Commander, libSQL/SQLite, Drizzle schema metadata, Vitest

---

### Task 1: Add the per-turn successful-tool counter

**Files:**
- Modify: `src/store/bootstrap.ts`
- Modify: `src/store/schema.ts`
- Modify: `src/store/host-session-bindings.ts`
- Test: `tests/store/store.test.ts`
- Test: `tests/store/host-lifecycle.test.ts`

- [ ] **Step 1: Write failing migration and counter tests**

Add a bootstrap regression that creates the old binding table, initializes the store, and asserts `PRAGMA table_info(host_session_bindings)` contains `successful_tool_count`. Add lifecycle setup assertions that a new turn counter increments from zero and resets after the binding is closed and rebound.

```ts
const columns = await client.execute('PRAGMA table_info(host_session_bindings)');
expect(columns.rows.map(row => String(row.name))).toContain('successful_tool_count');

expect(await incrementHostSuccessfulToolCount(key)).toBe(1);
expect(await incrementHostSuccessfulToolCount(key)).toBe(2);
await closeHostSessionBinding(key);
await bindHostSession(key, nextSession.id);
expect(await incrementHostSuccessfulToolCount(key)).toBe(1);
```

- [ ] **Step 2: Run the focused tests and verify the red state**

Run:

```powershell
npm.cmd test -- tests/store/store.test.ts tests/store/host-lifecycle.test.ts --maxWorkers=1
```

Expected: FAIL because the schema column and increment function do not exist.

- [ ] **Step 3: Add the schema column and idempotent bootstrap migration**

Add the column to both schema declarations and bootstrap older databases:

```ts
successfulToolCount: integer('successful_tool_count').notNull().default(0),
```

```sql
successful_tool_count INTEGER NOT NULL DEFAULT 0
```

```ts
async function ensureHostSessionBindingColumns(client: Client): Promise<void> {
  if (!(await tableExists(client, 'host_session_bindings'))) return;
  const columns = await tableColumns(client, 'host_session_bindings');
  if (!columns.includes('successful_tool_count')) {
    await client.execute('ALTER TABLE host_session_bindings ADD COLUMN successful_tool_count INTEGER NOT NULL DEFAULT 0;');
  }
}
```

Call the new ensure function from `bootstrapSchema`.

- [ ] **Step 4: Implement atomic increment and reset-on-rebind**

Include `successful_tool_count` in `bindHostSession`, reset it to zero in the conflict update, and add:

```ts
export async function incrementHostSuccessfulToolCount(input: HostSessionKey): Promise<number> {
  const key = normalizedKey(input);
  const row = (await getClient().execute({
    sql: `UPDATE host_session_bindings
      SET successful_tool_count = successful_tool_count + 1, updated_at = ?
      WHERE host = ? AND project_root = ? AND external_session_id = ? AND external_turn_id = ? AND active = 1
      RETURNING successful_tool_count`,
    args: [new Date().toISOString(), key.host, key.projectRoot, key.externalSessionId, key.externalTurnId],
  })).rows[0];
  return row ? Number(row.successful_tool_count) : 0;
}
```

- [ ] **Step 5: Run focused tests and commit**

Run:

```powershell
npm.cmd test -- tests/store/store.test.ts tests/store/host-lifecycle.test.ts --maxWorkers=1
```

Expected: PASS.

```powershell
git add -- src/store/bootstrap.ts src/store/schema.ts src/store/host-session-bindings.ts tests/store/store.test.ts tests/store/host-lifecycle.test.ts
git commit -m "feat: track Claude tool progress per turn"
```

### Task 2: Emit the throttled Claude continuation reminder

**Files:**
- Modify: `src/core/knowl-guidance.ts`
- Modify: `src/cli/agents/reminder.ts`
- Modify: `src/store/host-lifecycle.ts`
- Test: `tests/store/host-lifecycle.test.ts`
- Create: `tests/cli/claude-continuation-reminder.test.ts`

- [ ] **Step 1: Write failing lifecycle and CLI tests**

Exercise nine distinct successful Claude tool events in one turn. Assert events 1-7 and 9 have no `hostOutput`, and event 8 equals:

```ts
{
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext: KNOWL_CLAUDE_CONTINUATION_REMINDER,
  },
}
```

Add separate assertions that an exact debounced duplicate and `PostToolUseFailure` do not advance the schedule. At CLI level, invoke the real built `agent-hook claude PostToolUse --json` command eight times with distinct tool inputs and assert only the eighth stdout is non-empty.

- [ ] **Step 2: Run the focused tests and verify the red state**

Run:

```powershell
npm.cmd run build
npm.cmd test -- tests/store/host-lifecycle.test.ts tests/cli/claude-continuation-reminder.test.ts --maxWorkers=1
```

Expected: FAIL because no continuation reminder exists.

- [ ] **Step 3: Add the compact reminder and Claude envelope**

Add a fixed compact constant under 500 characters:

```ts
export const KNOWL_CLAUDE_CONTINUATION_REMINDER = 'KNOWL CONTINUATION: Keep the project-memory workflow active. Use relevant active memory. Before entering a new project area, call knowl_query with 2-6 keywords before repository files or commands. Store or update verified durable findings. Claude hooks own lifecycle; do not start the manual task loop.';
```

Add a typed renderer:

```ts
export function createClaudePostToolReminderOutput(): ClaudePostToolReminderOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: KNOWL_CLAUDE_CONTINUATION_REMINDER,
    },
  };
}
```

- [ ] **Step 4: Increment only accepted Claude success events and emit on multiples of eight**

After successful capture in `handleHostLifecycleEvent`, add:

```ts
const successfulToolCount = input.host === 'claude' && input.status !== 'failed'
  ? await incrementHostSuccessfulToolCount(bindingKey(input, 'turn'))
  : 0;
return {
  accepted: true,
  sessionId: started.session.id,
  hostOutput: successfulToolCount > 0 && successfulToolCount % 8 === 0
    ? createClaudePostToolReminderOutput()
    : undefined,
};
```

Keep the existing early return for debounced events so duplicates never increment.

- [ ] **Step 5: Run focused tests and commit**

Run:

```powershell
npm.cmd run build
npm.cmd test -- tests/store/host-lifecycle.test.ts tests/cli/claude-continuation-reminder.test.ts tests/cli/agent-reminder.test.ts --maxWorkers=1
```

Expected: all listed tests PASS.

```powershell
git add -- src/core/knowl-guidance.ts src/cli/agents/reminder.ts src/store/host-lifecycle.ts tests/store/host-lifecycle.test.ts tests/cli/claude-continuation-reminder.test.ts
git commit -m "feat: remind Claude during long tool runs"
```

### Task 3: Document and verify the completed behavior

**Files:**
- Modify: `README.md`
- Validate: `docs/superpowers/specs/2026-07-21-claude-mid-turn-knowl-reminder-design.md`

- [ ] **Step 1: Update lifecycle documentation**

Replace the statement that all tool capture hooks stay quiet with wording that distinguishes the throttled Claude behavior:

```markdown
SessionStart is the sole automatic retrieved-memory injection; Claude's prompt reminder and throttled continuation reminder are fixed workflow guidance, not retrieved memory. Claude's successful `PostToolUse` hook injects the compact continuation reminder after every eight accepted tool events in one turn; all other capture events remain quiet.
```

Document that the counter resets with the turn binding and that the reminder does not query Knowl or inspect prompts.

- [ ] **Step 2: Run the affected verification gate**

Run:

```powershell
npm.cmd test -- tests/store/store.test.ts tests/store/host-lifecycle.test.ts tests/cli/claude-continuation-reminder.test.ts tests/cli/agent-reminder.test.ts tests/cli/agent-adapters.test.ts --maxWorkers=1
npm.cmd run build
git diff --check
```

Expected: all listed tests PASS.

- [ ] **Step 3: Run the complete suite and inspect the final diff**

Run:

```powershell
npm.cmd test -- --maxWorkers=1
git status --short
git diff --stat HEAD~2
```

Expected: no new failures; any unchanged pre-existing failure is reported explicitly. The diff contains only the approved schema, lifecycle, reminder, tests, and README changes.

- [ ] **Step 4: Commit documentation**

```powershell
git add -- README.md
git commit -m "docs: explain Claude continuation reminders"
```

- [ ] **Step 5: Store the verified durable finding**

After verification, use `knowl_store` to record the fixed interval, per-turn reset, Claude-only scope, and absence of prompt parsing or automatic retrieval.
