# Agent Change Notification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell a running agent, on its next tool call, that project memory changed underneath it — and which items changed — without telling it about its own writes.

**Architecture:** Each agent gets its own `host_session_bindings` row, keyed by the `agent_id` that Claude puts on every subagent hook event. That row carries `seen_commit_rowid`, a watermark into `knowledge_commits`. Every accepted tool event compares the watermark against `MAX(rowid)`, always advances to head, and emits a titles-only card describing only the commits that are *not* attributable to the agent's own `tool_input`. Delivery reuses the existing `PostToolUse` `additionalContext` channel; the change card takes precedence over the static drift reminder.

**Tech Stack:** TypeScript (ESM, `"type": "module"`), `@libsql/client` raw SQL via `getClient()`, Drizzle schema definitions for table metadata, vitest.

**Spec:** [docs/superpowers/specs/2026-07-25-agent-change-notification-design.md](../specs/2026-07-25-agent-change-notification-design.md)

## Global Constraints

- **No new daemon or background process.** All work happens inside the existing short-lived `knowl agent-hook <host> <event> --json` invocation. Nothing may launch `knowl serve`.
- **No stdout except `additionalContext`.** Non-`SessionStart` hook handlers emit output only through `result.hostOutput`. Never add `console.log` to a hook path.
- **Card budget:** at most 5 item lines, titles truncated to 90 characters, worst case ~610 characters. The nothing-changed case must emit zero bytes.
- **At most one card per tool event.** The change card replaces the static drift reminder; they never both fire.
- **Drift constant stays 12.** `KNOWL_REMINDER_DRIFT = 12` in `src/store/host-lifecycle.ts` is unchanged.
- **`seen_commit_rowid = 0` means uninitialized, never "has seen nothing."** Any code path reading it must treat `0` with a non-empty commit table as "adopt head, emit nothing."
- **Untrusted payload strings are truncated.** `MAX_STRING = 2_000` in `src/cli/agents/host-hook.ts` applies to every field read out of a hook payload.
- **Migrations are additive and idempotent.** Follow the `ensureHostSessionBindingColumns` pattern: check `tableColumns` first, then `ALTER TABLE ... ADD COLUMN`. No table rebuilds, no primary-key changes.
- **Existing behaviour that must not regress:** `tests/cli/claude-continuation-reminder.test.ts` asserts the reminder fires at exactly the 12th non-Knowl tool call and stays silent after a Knowl call. Both must still pass.

## File Structure

**New files:**

| File | Responsibility |
| --- | --- |
| `src/store/change-watermark.ts` | Everything about "what changed that isn't mine": read head, read/advance a binding's watermark, load and flatten commit changes, attribute changes to a caller's `tool_input`, dedupe. No formatting, no host protocol. |
| `src/cli/agents/change-card.ts` | Render a `ChangeSummary` into card text and the Claude `hookSpecificOutput` envelope. Pure string work, no database access. |
| `tests/store/change-watermark.test.ts` | Unit tests for the watermark module. |
| `tests/cli/change-card.test.ts` | Unit tests for card rendering. |

**Modified files:**

| File | Change |
| --- | --- |
| `src/store/schema.ts:108-121` | Add `seenCommitRowid` to the `hostSessionBindings` table definition. |
| `src/store/bootstrap.ts:373-379` | Add the `seen_commit_rowid` column in `ensureHostSessionBindingColumns`, and add it to the `CREATE TABLE` statement for fresh databases. |
| `src/store/host-session-bindings.ts` | Initialise the watermark to head in `bindHostSession`; add read/advance accessors. |
| `src/cli/agents/host-hook.ts` | Add `agentId`, `agentType`, `knowlChangeKeys` to `NormalizedHostHook`; add `agent-start` / `agent-stop` events; extract attribution keys from `tool_input`. |
| `src/store/host-lifecycle.ts` | Agent-scoped `bindingKey`; `agent-start` / `agent-stop` handlers; the trigger; `changes` on `HostLifecycleResult`. |
| `src/cli/agents/hook-config.ts:9` | Register `SubagentStart` and `SubagentStop` in `CLAUDE_HOOK_EVENTS`. |
| `tests/cli/host-hook.test.ts` | Normalization tests for the new fields and events. |
| `tests/store/host-lifecycle.test.ts` | Integration tests for agent scope, the trigger, and precedence. |

**Why two new files rather than growing `host-lifecycle.ts`:** that file is already 258 lines of event routing. The watermark decision is independently testable against a database without constructing lifecycle events, and card rendering is a pure function that deserves tests with no database at all. Keeping them separate is what makes Tasks 3 and 4 reviewable on their own.

---

### Task 1: Watermark column and binding accessors

**Files:**
- Modify: `src/store/schema.ts:108-121`
- Modify: `src/store/bootstrap.ts:373-379` and the `host_session_bindings` `CREATE TABLE`
- Modify: `src/store/host-session-bindings.ts`
- Create: `src/store/change-watermark.ts`
- Test: `tests/store/host-session-bindings.test.ts`

**Interfaces:**
- Consumes: `getClient()` from `src/store/database.js`; `HostSessionKey` and the private `normalizedKey` helper already in `host-session-bindings.ts`.
- Produces:
  - `readCommitHead(): Promise<number>` — `MAX(rowid)` of `knowledge_commits`, `0` when empty. Exported from `src/store/change-watermark.ts`.
  - `readHostSeenCommit(key: HostSessionKey): Promise<number | null>` — `null` when no active row exists. Exported from `src/store/host-session-bindings.ts`.
  - `setHostSeenCommit(key: HostSessionKey, value: number): Promise<void>` — exported from `src/store/host-session-bindings.ts`.

- [x] **Step 1: Write the failing test**

Append to `tests/store/host-session-bindings.test.ts` inside the existing top-level `describe`:

```typescript
  it('initialises the watermark to the current commit head when binding', async () => {
    await repo.createKnowledgeCommit(projectId, 'First commit', [
      { itemId: 'item-a', action: 'insert', after: { id: 'item-a', title: 'A' } },
    ]);
    const head = await readCommitHead();
    expect(head).toBeGreaterThan(0);

    const session = await startMemorySession(projectId, 'Watermark bind');
    const key: HostSessionKey = {
      host: 'claude',
      projectRoot: ROOT,
      externalSessionId: 'watermark-session',
      externalTurnId: '__agent__:agent-1',
    };
    await bindHostSession(key, session.id);

    expect(await readHostSeenCommit(key)).toBe(head);
  });

  it('advances and reads the watermark, and returns null for an unknown row', async () => {
    const session = await startMemorySession(projectId, 'Watermark advance');
    const key: HostSessionKey = {
      host: 'claude',
      projectRoot: ROOT,
      externalSessionId: 'watermark-advance-session',
      externalTurnId: '__agent__:agent-2',
    };
    await bindHostSession(key, session.id);

    await setHostSeenCommit(key, 99);
    expect(await readHostSeenCommit(key)).toBe(99);

    expect(await readHostSeenCommit({ ...key, externalTurnId: '__agent__:missing' })).toBeNull();
  });
```

Add to that file's imports:

```typescript
import { readCommitHead } from '../../src/store/change-watermark.js';
import { readHostSeenCommit, setHostSeenCommit } from '../../src/store/host-session-bindings.js';
```

Open `tests/store/host-session-bindings.test.ts` first and reuse whatever it already names for `projectId`, `ROOT`, `repo`, and `startMemorySession` rather than adding duplicate imports or a second `beforeAll`.

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/host-session-bindings.test.ts`
Expected: FAIL — cannot resolve `src/store/change-watermark.js`.

- [x] **Step 3: Create the watermark head reader**

Create `src/store/change-watermark.ts`:

```typescript
import { getClient } from './database.js';

/**
 * Highest `knowledge_commits` rowid, or 0 when the table is empty.
 *
 * rowid is used as the watermark because it is dense, monotonic, and already
 * present. It is NOT stable across snapshot restore, which reassigns rowids via
 * `INSERT ... SELECT *`; callers must clamp a stored watermark that exceeds head.
 */
export async function readCommitHead(): Promise<number> {
  const row = (await getClient().execute('SELECT MAX(rowid) AS head FROM knowledge_commits')).rows[0];
  const head = row?.head;
  return head === null || head === undefined ? 0 : Number(head);
}
```

- [x] **Step 4: Add the schema column**

In `src/store/schema.ts`, inside the `hostSessionBindings` definition, add after the `successfulToolCount` line:

```typescript
  seenCommitRowid: integer('seen_commit_rowid').notNull().default(0),
```

- [x] **Step 5: Add the migration and the fresh-database column**

In `src/store/bootstrap.ts`, extend `ensureHostSessionBindingColumns`:

```typescript
async function ensureHostSessionBindingColumns(client: Client): Promise<void> {
  if (!(await tableExists(client, 'host_session_bindings'))) return;
  const columns = await tableColumns(client, 'host_session_bindings');
  if (!columns.includes('successful_tool_count')) {
    await client.execute('ALTER TABLE host_session_bindings ADD COLUMN successful_tool_count INTEGER NOT NULL DEFAULT 0;');
  }
  // 0 is an "uninitialized" sentinel, not "has seen no commits". Rows migrated here
  // adopt head on their first tool event rather than reporting all history as new.
  if (!columns.includes('seen_commit_rowid')) {
    await client.execute('ALTER TABLE host_session_bindings ADD COLUMN seen_commit_rowid INTEGER NOT NULL DEFAULT 0;');
  }
}
```

Then find the `CREATE TABLE IF NOT EXISTS host_session_bindings` statement in the same file and add `seen_commit_rowid INTEGER NOT NULL DEFAULT 0,` alongside `successful_tool_count INTEGER NOT NULL DEFAULT 0,` so fresh databases get the column without relying on the migration.

- [x] **Step 6: Initialise the watermark on bind and add the accessors**

In `src/store/host-session-bindings.ts`, add the import:

```typescript
import { readCommitHead } from './change-watermark.js';
```

Replace `bindHostSession` with:

```typescript
export async function bindHostSession(input: HostSessionKey, memorySessionId: string): Promise<void> {
  const key = normalizedKey(input);
  const now = new Date().toISOString();
  // Seed the watermark at head so a brand-new row never reports the entire
  // commit history as "changed since you last looked".
  const head = await readCommitHead();
  await getClient().execute({
    sql: `INSERT INTO host_session_bindings
      (host, project_root, external_session_id, external_turn_id, memory_session_id, active, successful_tool_count, seen_commit_rowid, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)
      ON CONFLICT (host, project_root, external_session_id, external_turn_id)
      DO UPDATE SET memory_session_id = excluded.memory_session_id, active = 1, successful_tool_count = 0,
        seen_commit_rowid = excluded.seen_commit_rowid, updated_at = excluded.updated_at`,
    args: [key.host, key.projectRoot, key.externalSessionId, key.externalTurnId, memorySessionId, head, now],
  });
}
```

Add these two functions next to `resetHostSuccessfulToolCount`:

```typescript
export async function readHostSeenCommit(input: HostSessionKey): Promise<number | null> {
  const key = normalizedKey(input);
  const row = (await getClient().execute({
    sql: `SELECT seen_commit_rowid FROM host_session_bindings
      WHERE host = ? AND project_root = ? AND external_session_id = ? AND external_turn_id = ? AND active = 1`,
    args: [key.host, key.projectRoot, key.externalSessionId, key.externalTurnId],
  })).rows[0];
  return row ? Number(row.seen_commit_rowid) : null;
}

export async function setHostSeenCommit(input: HostSessionKey, value: number): Promise<void> {
  const key = normalizedKey(input);
  await getClient().execute({
    sql: `UPDATE host_session_bindings SET seen_commit_rowid = ?, updated_at = ?
      WHERE host = ? AND project_root = ? AND external_session_id = ? AND external_turn_id = ? AND active = 1`,
    args: [value, new Date().toISOString(), key.host, key.projectRoot, key.externalSessionId, key.externalTurnId],
  });
}
```

- [x] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/store/host-session-bindings.test.ts`
Expected: PASS, including the pre-existing tests in that file.

- [x] **Step 8: Verify no regression in the existing lifecycle suite**

Run: `npx vitest run tests/store/host-lifecycle.test.ts`
Expected: PASS. `bindHostSession` changed shape, so this confirms callers still work.

- [x] **Step 9: Commit**

```bash
git add src/store/change-watermark.ts src/store/schema.ts src/store/bootstrap.ts src/store/host-session-bindings.ts tests/store/host-session-bindings.test.ts
git commit -m "feat(store): add seen_commit_rowid watermark to host session bindings"
```

---

### Task 2: Hook normalization for agent identity and subagent events

**Files:**
- Modify: `src/cli/agents/host-hook.ts`
- Test: `tests/cli/host-hook.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `NormalizedHostHook` gains three optional fields and two event names:
  - `agentId?: string`, `agentType?: string`
  - `knowlChangeKeys?: { ids: string[]; titles: string[] }` — set only when `knowlTool` is true
  - `NormalizedHookEventName` gains `'agent-start' | 'agent-stop'`

- [x] **Step 1: Write the failing tests**

Append to `tests/cli/host-hook.test.ts` inside the existing `describe`:

```typescript
  it('carries agent identity on subagent tool events and omits it on main-thread events', () => {
    const subagent = normalizeHostHook('claude', 'PostToolUse', {
      session_id: 'session-3',
      agent_id: 'adc54472c7d8cad78',
      agent_type: 'Explore',
      cwd: ROOT,
      tool_name: 'Grep',
      tool_input: { pattern: 'foo' },
      tool_response: {},
    });
    expect(subagent).toMatchObject({
      event: 'session-event',
      externalSessionId: 'session-3',
      agentId: 'adc54472c7d8cad78',
      agentType: 'Explore',
    });

    const mainThread = normalizeHostHook('claude', 'PostToolUse', {
      session_id: 'session-3',
      cwd: ROOT,
      tool_name: 'Grep',
      tool_input: { pattern: 'foo' },
      tool_response: {},
    });
    expect(mainThread.agentId).toBeUndefined();
  });

  it('normalizes SubagentStart and SubagentStop, titling the session by agent type', () => {
    const start = normalizeHostHook('claude', 'SubagentStart', {
      session_id: 'session-4',
      agent_id: 'agent-4',
      agent_type: 'Explore',
      cwd: ROOT,
      prompt_id: 'prompt-4',
    });
    expect(start).toMatchObject({
      event: 'agent-start',
      externalSessionId: 'session-4',
      agentId: 'agent-4',
      agentType: 'Explore',
      title: 'Agent session (Explore)',
      payload: {},
    });

    const stop = normalizeHostHook('claude', 'SubagentStop', {
      session_id: 'session-4',
      agent_id: 'agent-4',
      agent_type: 'Explore',
      cwd: ROOT,
      last_assistant_message: 'Private subagent output must not be retained',
    });
    expect(stop).toMatchObject({ event: 'agent-stop', agentId: 'agent-4' });
    expect(JSON.stringify(stop)).not.toContain('Private subagent output');
  });

  it('normalizes a subagent event with no agent type', () => {
    const result = normalizeHostHook('claude', 'SubagentStart', {
      session_id: 'session-4b',
      agent_id: 'agent-4b',
      cwd: ROOT,
    });

    expect(result).toMatchObject({
      event: 'agent-start',
      agentId: 'agent-4b',
      title: 'Agent session (subagent)',
    });
    expect(result.agentType).toBeUndefined();
  });

  it('rejects a subagent event with no agent id', () => {
    expect(() => normalizeHostHook('claude', 'SubagentStart', {
      session_id: 'session-5',
      cwd: ROOT,
    })).toThrow(IncompleteHostHookPayloadError);
  });

  it('extracts attribution keys from Knowl write tool input only', () => {
    const store = normalizeHostHook('claude', 'PostToolUse', {
      session_id: 'session-6',
      cwd: ROOT,
      tool_name: 'mcp__knowl__knowl_ingest_atoms',
      tool_input: { atoms: [{ title: 'First atom' }, { title: 'Second atom' }] },
      tool_response: {},
    });
    expect(store.knowlTool).toBe(true);
    expect(store.knowlChangeKeys).toEqual({ ids: [], titles: ['First atom', 'Second atom'] });

    const update = normalizeHostHook('claude', 'PostToolUse', {
      session_id: 'session-6',
      cwd: ROOT,
      tool_name: 'mcp__knowl__knowl_update',
      tool_input: { id: 'item-9', supersedeId: 'item-8', title: 'New title' },
      tool_response: {},
    });
    expect(update.knowlChangeKeys).toEqual({ ids: ['item-9', 'item-8'], titles: ['New title'] });

    const nonKnowl = normalizeHostHook('claude', 'PostToolUse', {
      session_id: 'session-6',
      cwd: ROOT,
      tool_name: 'Grep',
      tool_input: { title: 'not a knowl call' },
      tool_response: {},
    });
    expect(nonKnowl.knowlChangeKeys).toBeUndefined();
  });
```

Add `IncompleteHostHookPayloadError` to the file's import from `../../src/cli/agents/host-hook.js`.

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/cli/host-hook.test.ts`
Expected: FAIL — `agentId` undefined on the subagent event, and `Unsupported claude hook event: SubagentStart`.

- [x] **Step 3: Extend the type and event name union**

In `src/cli/agents/host-hook.ts`, extend the union and interface:

```typescript
export type NormalizedHookEventName =
  | 'session-start'
  | 'turn-start'
  | 'session-event'
  | 'checkpoint'
  | 'turn-stop'
  | 'session-stop'
  | 'agent-start'
  | 'agent-stop';
```

Add to `NormalizedHostHook`, after `knowlTool`:

```typescript
  /** Claude subagent id. Present on every subagent event, absent on main-thread events. */
  agentId?: string;
  /** Claude subagent type, e.g. "Explore". Used only to title the binding. */
  agentType?: string;
  /**
   * Titles and ids the caller supplied in its own tool_input, used to recognise
   * this agent's own writes in new commits. Held in memory for comparison only and
   * never persisted, so no attribution column is needed.
   */
  knowlChangeKeys?: { ids: string[]; titles: string[] };
```

- [x] **Step 4: Extract attribution keys**

Add these constants and helper above `toolEvent` in the same file:

```typescript
const MAX_CHANGE_KEYS = 20;
const MAX_CHANGE_KEY_LENGTH = 200;

const changeKey = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_CHANGE_KEY_LENGTH) : undefined;

/**
 * Pull the ids and titles this call wrote from its own tool_input. A new commit whose
 * changes match one of these is the caller's own work and must not be reported back.
 */
function knowlChangeKeys(input: Record<string, unknown>): { ids: string[]; titles: string[] } {
  const ids = [changeKey(input.id), changeKey(input.supersedeId), changeKey(input.supersedes)]
    .filter((value): value is string => Boolean(value));
  const titles = [changeKey(input.title)].filter((value): value is string => Boolean(value));
  const atoms = Array.isArray(input.atoms) ? input.atoms : [];
  for (const atom of atoms) {
    const title = changeKey(recordValue(atom)?.title);
    if (title) titles.push(title);
  }
  return { ids: ids.slice(0, MAX_CHANGE_KEYS), titles: titles.slice(0, MAX_CHANGE_KEYS) };
}
```

Then in `toolEvent`, return the keys whenever the tool is a Knowl call. Replace the three `return` statements so each carries `knowlChangeKeys`:

```typescript
function toolEvent(host: HookHost, eventName: string, projectRoot: string, raw: Record<string, unknown>): Pick<NormalizedHostHook, 'type' | 'payload' | 'status' | 'knowlTool' | 'knowlChangeKeys'> {
  const input = toolInput(raw);
  const toolName = stringValue(raw.tool_name) ?? stringValue(raw.toolName) ?? '';
  const knowlTool = /knowl/i.test(toolName);
  const changeKeys = knowlTool ? { knowlChangeKeys: knowlChangeKeys(input) } : {};
  const isShell = host === 'cursor'
    ? eventName === 'afterShellExecution'
    : toolName.toLocaleLowerCase() === 'bash' || toolName.toLocaleLowerCase() === 'shell';
  if (isShell) return { ...commandEvent(projectRoot, raw), status: typeof raw.exit_code === 'number' && raw.exit_code !== 0 ? 'failed' : undefined, knowlTool, ...changeKeys };

  const paths = changedPaths(projectRoot, { ...raw, ...input });
  if (paths.length > 0) return { type: 'checkpoint', payload: { changedPaths: paths }, knowlTool, ...changeKeys };
  return { type: 'checkpoint', payload: { summary: `${toolName || 'Tool'} completed`.slice(0, MAX_STRING) }, knowlTool, ...changeKeys };
}
```

- [x] **Step 5: Read agent identity and route the two new events**

Still in `src/cli/agents/host-hook.ts`, add a helper next to `externalIds`:

```typescript
function agentIdentity(raw: Record<string, unknown>) {
  const agentId = stringValue(raw.agent_id) ?? stringValue(raw.agentId);
  const agentType = stringValue(raw.agent_type) ?? stringValue(raw.agentType);
  return { ...(agentId ? { agentId } : {}), ...(agentType ? { agentType } : {}) };
}
```

In `normalizeHostHookUnchecked`, after `const ids = externalIds(normalizedHost, raw);` add:

```typescript
  const agent = agentIdentity(raw);
```

Add the two entries to the codex/claude `eventMap`:

```typescript
        SubagentStart: 'agent-start', SubagentStop: 'agent-stop',
```

Add this branch immediately after the `session-start`/`turn-start` branch:

```typescript
  if (event === 'agent-start' || event === 'agent-stop') {
    if (!agent.agentId) throw new IncompleteHostHookPayloadError('Subagent hook payload requires agent_id.');
    return {
      host: normalizedHost,
      event,
      ...ids,
      ...agent,
      projectRoot,
      title: `Agent session (${agent.agentType ?? 'subagent'})`,
      payload: {},
    };
  }
```

Finally, spread `agent` into the tool-event return at the end of the function so subagent `PostToolUse` carries identity:

```typescript
  return { host: normalizedHost, event, ...ids, ...agent, projectRoot, ...toolEvent(normalizedHost, eventName, projectRoot, raw) };
```

- [x] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/cli/host-hook.test.ts`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add src/cli/agents/host-hook.ts tests/cli/host-hook.test.ts
git commit -m "feat(hooks): normalize Claude subagent identity and SubagentStart/Stop events"
```

---

### Task 3: Foreign-change detection

**Files:**
- Modify: `src/store/change-watermark.ts`
- Test: `tests/store/change-watermark.test.ts`

**Interfaces:**
- Consumes: `readCommitHead()` from Task 1; `knowlChangeKeys` shape from Task 2.
- Produces, all exported from `src/store/change-watermark.ts`:
  - `type ChangeSummaryItem = { itemId: string; category: string; title: string; action: CommitChange['action'] }`
  - `type ChangeSummary = { count: number; items: ChangeSummaryItem[] }`
  - `loadForeignChanges(seen: number, keys?: { ids: string[]; titles: string[] }): Promise<ChangeSummary>`

`count` is the number of distinct changed items after deduplication, including any whose title could not be resolved. `items` holds only the titled ones. That asymmetry is deliberate: the header stays truthful when a change carries neither `after` nor `before`.

- [x] **Step 1: Write the failing test**

Create `tests/store/change-watermark.test.ts`:

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { loadForeignChanges, readCommitHead } from '../../src/store/change-watermark.js';
import * as repo from '../../src/store/repository.js';

const ROOT = path.resolve('.knowl-change-watermark-test');

describe('foreign change detection', () => {
  let projectId = '';

  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'Change watermark')).id;
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('reports nothing when the watermark is already at head', async () => {
    await repo.createKnowledgeCommit(projectId, 'Baseline', [
      { itemId: 'base', action: 'insert', after: { id: 'base', category: 'fact', title: 'Baseline item' } },
    ]);
    const head = await readCommitHead();

    expect(await loadForeignChanges(head)).toEqual({ count: 0, items: [] });
  });

  it('reports category, title and action for commits after the watermark', async () => {
    const seen = await readCommitHead();
    await repo.createKnowledgeCommit(projectId, 'Sibling insert', [
      { itemId: 'sib-1', action: 'insert', after: { id: 'sib-1', category: 'decision', title: 'Sibling decision' } },
    ]);
    await repo.createKnowledgeCommit(projectId, 'Sibling update', [
      { itemId: 'sib-2', action: 'update', after: { id: 'sib-2', category: 'fact', title: 'Sibling fact' } },
    ]);

    expect(await loadForeignChanges(seen)).toEqual({
      count: 2,
      items: [
        { itemId: 'sib-1', category: 'decision', title: 'Sibling decision', action: 'insert' },
        { itemId: 'sib-2', category: 'fact', title: 'Sibling fact', action: 'update' },
      ],
    });
  });

  it('falls back to before.title when after is absent', async () => {
    const seen = await readCommitHead();
    await repo.createKnowledgeCommit(projectId, 'Supersede', [
      { itemId: 'old-1', action: 'supersede', before: { id: 'old-1', category: 'fact', title: 'Retired fact' } },
    ]);

    expect(await loadForeignChanges(seen)).toEqual({
      count: 1,
      items: [{ itemId: 'old-1', category: 'fact', title: 'Retired fact', action: 'supersede' }],
    });
  });

  it('counts a change with no resolvable title but omits it from items', async () => {
    const seen = await readCommitHead();
    await repo.createKnowledgeCommit(projectId, 'Delete', [
      { itemId: 'gone-1', action: 'delete' },
    ]);

    expect(await loadForeignChanges(seen)).toEqual({ count: 1, items: [] });
  });

  it('collapses repeated changes to one entry carrying the latest action', async () => {
    const seen = await readCommitHead();
    await repo.createKnowledgeCommit(projectId, 'Insert then update', [
      { itemId: 'dup-1', action: 'insert', after: { id: 'dup-1', category: 'fact', title: 'First title' } },
    ]);
    await repo.createKnowledgeCommit(projectId, 'Later update', [
      { itemId: 'dup-1', action: 'update', after: { id: 'dup-1', category: 'fact', title: 'Second title' } },
    ]);

    expect(await loadForeignChanges(seen)).toEqual({
      count: 1,
      items: [{ itemId: 'dup-1', category: 'fact', title: 'Second title', action: 'update' }],
    });
  });

  it('excludes the callers own writes by id and by title', async () => {
    const seen = await readCommitHead();
    await repo.createKnowledgeCommit(projectId, 'My write', [
      { itemId: 'mine-1', action: 'update', after: { id: 'mine-1', category: 'fact', title: 'My own item' } },
    ]);
    await repo.createKnowledgeCommit(projectId, 'Their write', [
      { itemId: 'theirs-1', action: 'insert', after: { id: 'theirs-1', category: 'fact', title: 'Their item' } },
    ]);

    const byId = await loadForeignChanges(seen, { ids: ['mine-1'], titles: [] });
    expect(byId.items.map(item => item.itemId)).toEqual(['theirs-1']);
    expect(byId.count).toBe(1);

    const byTitle = await loadForeignChanges(seen, { ids: [], titles: ['My own item'] });
    expect(byTitle.items.map(item => item.itemId)).toEqual(['theirs-1']);
  });

  it('still reports a sibling commit when the callers own write produced none', async () => {
    const seen = await readCommitHead();
    // Mirrors an all-duplicate knowl_ingest_atoms call: the caller committed nothing,
    // so the single new commit belongs to a sibling and must not be swallowed.
    await repo.createKnowledgeCommit(projectId, 'Sibling only', [
      { itemId: 'sib-only', action: 'insert', after: { id: 'sib-only', category: 'fact', title: 'Sibling only item' } },
    ]);

    const summary = await loadForeignChanges(seen, { ids: [], titles: ['Atom that deduped'] });
    expect(summary.count).toBe(1);
    expect(summary.items[0].itemId).toBe('sib-only');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/change-watermark.test.ts`
Expected: FAIL — `loadForeignChanges` is not exported.

- [x] **Step 3: Implement foreign-change loading**

First add `CommitChange` to the import block at the top of `src/store/change-watermark.ts`, so the file keeps a single import section:

```typescript
import { getClient } from './database.js';
import type { CommitChange } from '../core/types.js';
```

Then append the rest below `readCommitHead`:

```typescript
export type ChangeSummaryItem = {
  itemId: string;
  category: string;
  title: string;
  action: CommitChange['action'];
};

export type ChangeSummary = {
  /** Distinct changed items, including any whose title could not be resolved. */
  count: number;
  /** Only the items with a resolvable title, in commit order. */
  items: ChangeSummaryItem[];
};

export type ChangeAttributionKeys = { ids: string[]; titles: string[] };

const parseChanges = (value: unknown): CommitChange[] => {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed as CommitChange[] : [];
};

const changeTitle = (change: CommitChange): string | undefined => {
  const title = change.after?.title ?? change.before?.title;
  return typeof title === 'string' && title.length > 0 ? title : undefined;
};

const changeCategory = (change: CommitChange): string =>
  String(change.after?.category ?? change.before?.category ?? 'item');

/**
 * Changes committed after `seen` that are not attributable to the caller.
 *
 * Attribution is by content rather than by a stored author, because writes arrive
 * through the MCP process, which has no caller identity to record. A change is the
 * caller's own when its item id or title appears in the caller's own tool_input.
 */
export async function loadForeignChanges(
  seen: number,
  keys?: ChangeAttributionKeys,
): Promise<ChangeSummary> {
  const rows = (await getClient().execute({
    sql: 'SELECT changes FROM knowledge_commits WHERE rowid > ? ORDER BY rowid ASC',
    args: [seen],
  })).rows;

  const ownIds = new Set(keys?.ids ?? []);
  const ownTitles = new Set(keys?.titles ?? []);
  // Later changes to the same item overwrite earlier ones, so the card shows the
  // latest action rather than one line per commit.
  const byItem = new Map<string, { category: string; title?: string; action: CommitChange['action'] }>();

  for (const row of rows) {
    for (const change of parseChanges(row.changes)) {
      if (!change?.itemId) continue;
      const title = changeTitle(change);
      if (ownIds.has(change.itemId)) continue;
      if (title && ownTitles.has(title)) continue;
      byItem.set(change.itemId, { category: changeCategory(change), title, action: change.action });
    }
  }

  const items: ChangeSummaryItem[] = [];
  for (const [itemId, entry] of byItem) {
    if (!entry.title) continue;
    items.push({ itemId, category: entry.category, title: entry.title, action: entry.action });
  }
  return { count: byItem.size, items };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/store/change-watermark.test.ts`
Expected: PASS, all eight cases.

- [x] **Step 5: Commit**

```bash
git add src/store/change-watermark.ts tests/store/change-watermark.test.ts
git commit -m "feat(store): detect commits since a watermark excluding the callers own writes"
```

---

### Task 4: Change card rendering

**Files:**
- Create: `src/cli/agents/change-card.ts`
- Test: `tests/cli/change-card.test.ts`

**Interfaces:**
- Consumes: `ChangeSummary` from Task 3.
- Produces, exported from `src/cli/agents/change-card.ts`:
  - `renderChangeCard(summary: ChangeSummary): string`
  - `createClaudeChangeCardOutput(summary: ChangeSummary): { hookSpecificOutput: { hookEventName: 'PostToolUse'; additionalContext: string } }`

- [x] **Step 1: Write the failing test**

Create `tests/cli/change-card.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { createClaudeChangeCardOutput, renderChangeCard } from '../../src/cli/agents/change-card.js';
import { ChangeSummary } from '../../src/store/change-watermark.js';

const item = (index: number, action: 'insert' | 'update' = 'insert') => ({
  itemId: `item-${index}`,
  category: 'fact',
  title: `Item ${index}`,
  action,
});

describe('change card rendering', () => {
  it('renders a singular header, one line per item, and the closing instruction', () => {
    const summary: ChangeSummary = { count: 1, items: [item(1)] };

    expect(renderChangeCard(summary)).toBe([
      'KNOWL CHANGED: 1 item since you last looked.',
      '- fact: Item 1',
      'Call knowl_query before relying on earlier memory in these areas.',
    ].join('\n'));
  });

  it('pluralises the header and marks non-insert actions', () => {
    const summary: ChangeSummary = { count: 2, items: [item(1), item(2, 'update')] };

    expect(renderChangeCard(summary)).toContain('KNOWL CHANGED: 2 items since you last looked.');
    expect(renderChangeCard(summary)).toContain('- fact: Item 1');
    expect(renderChangeCard(summary)).toContain('- fact (update): Item 2');
  });

  it('caps at five item lines and reports the overflow', () => {
    const items = [1, 2, 3, 4, 5, 6, 7].map(index => item(index));
    const card = renderChangeCard({ count: 7, items });
    const lines = card.split('\n').filter(line => line.startsWith('- '));

    expect(lines).toHaveLength(6);
    expect(lines[5]).toBe('- +2 more');
    expect(card).toContain('KNOWL CHANGED: 7 items since you last looked.');
  });

  it('truncates titles to 90 characters', () => {
    const long = 'x'.repeat(200);
    const card = renderChangeCard({ count: 1, items: [{ ...item(1), title: long }] });
    const line = card.split('\n')[1];

    expect(line).toBe(`- fact: ${'x'.repeat(90)}`);
  });

  it('counts items dropped for having no title in the header only', () => {
    const card = renderChangeCard({ count: 3, items: [item(1)] });

    expect(card).toContain('KNOWL CHANGED: 3 items since you last looked.');
    expect(card.split('\n').filter(line => line.startsWith('- '))).toHaveLength(2);
    expect(card).toContain('- +2 more');
  });

  it('stays within the documented character budget', () => {
    const items = [1, 2, 3, 4, 5].map(index => ({ ...item(index), title: 'y'.repeat(120) }));

    expect(renderChangeCard({ count: 50, items }).length).toBeLessThanOrEqual(700);
  });

  it('wraps the card in the Claude PostToolUse envelope', () => {
    const summary: ChangeSummary = { count: 1, items: [item(1)] };

    expect(createClaudeChangeCardOutput(summary)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: renderChangeCard(summary),
      },
    });
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/change-card.test.ts`
Expected: FAIL — cannot resolve `src/cli/agents/change-card.js`.

- [x] **Step 3: Implement the renderer**

Create `src/cli/agents/change-card.ts`:

```typescript
import type { ChangeSummary } from '../../store/change-watermark.js';

const MAX_ITEM_LINES = 5;
const MAX_TITLE_LENGTH = 90;
const CLOSING_LINE = 'Call knowl_query before relying on earlier memory in these areas.';

export interface ClaudeChangeCardOutput {
  hookSpecificOutput: {
    hookEventName: 'PostToolUse';
    additionalContext: string;
  };
}

/**
 * Titles only, never content. A title is the routing information the agent needs —
 * "do I care about this?" — and content is what knowl_query is for.
 */
export function renderChangeCard(summary: ChangeSummary): string {
  const shown = summary.items.slice(0, MAX_ITEM_LINES);
  const lines = shown.map(item => {
    const action = item.action === 'insert' ? '' : ` (${item.action})`;
    return `- ${item.category}${action}: ${item.title.slice(0, MAX_TITLE_LENGTH)}`;
  });
  const remaining = summary.count - shown.length;
  if (remaining > 0) lines.push(`- +${remaining} more`);
  const noun = summary.count === 1 ? 'item' : 'items';
  return [
    `KNOWL CHANGED: ${summary.count} ${noun} since you last looked.`,
    ...lines,
    CLOSING_LINE,
  ].join('\n');
}

export function createClaudeChangeCardOutput(summary: ChangeSummary): ClaudeChangeCardOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: renderChangeCard(summary),
    },
  };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli/change-card.test.ts`
Expected: PASS, all seven cases.

- [x] **Step 5: Commit**

```bash
git add src/cli/agents/change-card.ts tests/cli/change-card.test.ts
git commit -m "feat(hooks): render the Knowl change card"
```

---

### Task 5: Agent-scoped binding and subagent lifecycle

**Files:**
- Modify: `src/store/host-lifecycle.ts:38-45` (`bindingKey`) and `handleHostLifecycleEvent`
- Test: `tests/store/host-lifecycle.test.ts`

**Interfaces:**
- Consumes: `agentId` / `agentType` from Task 2; `bindHostSession`, `findHostSession`, `closeHostSessionBinding` from `host-session-bindings.js`.
- Produces: `bindingKey(input, 'turn')` returns `__agent__:<agentId>` when `agentId` is set; `handleHostLifecycleEvent` handles `agent-start` and `agent-stop`.

- [x] **Step 1: Write the failing test**

Append to `tests/store/host-lifecycle.test.ts`:

```typescript
  it('binds a subagent to the parent memory session and returns SubagentStart context', async () => {
    const parent = await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'session-start',
      externalSessionId: 'subagent-parent',
      externalTurnId: undefined,
      title: 'Agent session',
    }));

    const child = await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'agent-start',
      externalSessionId: 'subagent-parent',
      externalTurnId: undefined,
      agentId: 'agent-alpha',
      agentType: 'Explore',
      title: 'Agent session (Explore)',
    }));

    expect(child.accepted).toBe(true);
    expect(child.sessionId).toBe(parent.sessionId);
    expect(child.hostOutput).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SubagentStart',
        additionalContext: child.context,
      },
    });
    expect(child.context).toContain('Use local memory');
  });

  it('routes subagent tool events to an agent-scoped binding, isolated from the parent', async () => {
    await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'session-start',
      externalSessionId: 'sibling-session',
      externalTurnId: undefined,
      title: 'Agent session',
    }));

    const agentKey: HostSessionKey = {
      host: 'claude',
      projectRoot: ROOT,
      externalSessionId: 'sibling-session',
      externalTurnId: '__agent__:agent-beta',
    };
    const parentTurnKey: HostSessionKey = { ...agentKey, externalTurnId: '__turn__' };

    await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'session-event',
      type: 'checkpoint',
      externalSessionId: 'sibling-session',
      externalTurnId: undefined,
      agentId: 'agent-beta',
      agentType: 'Explore',
      payload: { summary: 'Grep completed' },
    }));

    expect(await findHostSession(agentKey)).not.toBeNull();
    expect(await findHostSession(parentTurnKey)).toBeNull();
  });

  it('closes only the subagent binding on agent-stop', async () => {
    const agentKey: HostSessionKey = {
      host: 'claude',
      projectRoot: ROOT,
      externalSessionId: 'agent-stop-session',
      externalTurnId: '__agent__:agent-gamma',
    };
    const sessionKey: HostSessionKey = { ...agentKey, externalTurnId: '__session__' };

    await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'session-start',
      externalSessionId: 'agent-stop-session',
      externalTurnId: undefined,
      title: 'Agent session',
    }));
    await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'agent-start',
      externalSessionId: 'agent-stop-session',
      externalTurnId: undefined,
      agentId: 'agent-gamma',
      agentType: 'Plan',
    }));
    expect(await findHostSession(agentKey)).not.toBeNull();

    const stopped = await handleHostLifecycleEvent(projectId, hook({
      host: 'claude',
      event: 'agent-stop',
      externalSessionId: 'agent-stop-session',
      externalTurnId: undefined,
      agentId: 'agent-gamma',
    }));

    expect(stopped.accepted).toBe(true);
    expect(stopped.hostOutput).toBeUndefined();
    expect(await findHostSession(agentKey)).toBeNull();
    expect(await findHostSession(sessionKey)).not.toBeNull();
  });
```

Add `findHostSession` to the existing import from `../../src/store/host-session-bindings.js`.

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/store/host-lifecycle.test.ts`
Expected: FAIL — `agent-start` falls through to the session-stop branch at the end of `handleHostLifecycleEvent` and returns `{ accepted: false, reason: 'event-loss' }`.

- [x] **Step 3: Make the turn-scope key agent-aware**

In `src/store/host-lifecycle.ts`, replace `bindingKey`:

```typescript
function bindingKey(input: NormalizedHostHook, scope: 'session' | 'turn'): HostSessionKey {
  return {
    host: input.host,
    projectRoot: input.projectRoot,
    // A Claude subagent has no turn id but always has an agent id, so its events get
    // their own row: its own drift counter and its own watermark, isolated from
    // siblings and from the main thread. Main-thread events keep `__turn__`.
    externalTurnId: scope === 'session'
      ? '__session__'
      : input.agentId
        ? `__agent__:${input.agentId}`
        : input.externalTurnId ?? '__turn__',
  };
}
```

- [x] **Step 4: Extend the host output envelope for SubagentStart**

In the same file, update `hostContextOutput` so an `agent-start` event names the right hook:

```typescript
function hostContextOutput(input: NormalizedHostHook, context: string | undefined): Record<string, unknown> | undefined {
  if (!context) return undefined;
  if (input.host === 'codex' || input.host === 'claude') {
    const hookEventName = input.event === 'session-start'
      ? 'SessionStart'
      : input.event === 'agent-start'
        ? 'SubagentStart'
        : 'UserPromptSubmit';
    return { hookSpecificOutput: { hookEventName, additionalContext: context } };
  }
  if (input.host === 'cursor') {
    return {
      additional_context: context,
      sessionStart: true,
    };
  }
  // `generic` has no host-native protocol: emitting a host-output object here would
  // replace the host-neutral lifecycle result ({ accepted, sessionId, context, ... })
  // that generic integrations consume, so it deliberately returns nothing.
  return undefined;
}
```

- [x] **Step 5: Handle the two new events**

In `handleHostLifecycleEvent`, add this block immediately after the `turn-start` block and before the `session-event` block:

```typescript
  if (input.event === 'agent-start') {
    // One memory session per host session, N bindings. The subagent shares the
    // parent's session_id, so it joins the parent's memory session rather than
    // creating one that would need separate finalization.
    const sessionBinding = await findHostSession(bindingKey(input, 'session'));
    let memorySessionId = sessionBinding?.id;
    if (!memorySessionId) {
      // SubagentStart normally arrives after SessionStart, but an event loss must not
      // leave the subagent unbound. includeContext is false here because
      // bootstrapAgentContext below composes the subagent's own bounded context.
      const started = await bootstrapWithHandoff(projectId, input, 'session', false);
      memorySessionId = started.session.id;
      await bindHostSession(bindingKey(input, 'session'), memorySessionId);
    }

    await bindHostSession(bindingKey(input, 'turn'), memorySessionId);
    const bootstrap = await bootstrapAgentContext(projectId, input, memorySessionId);
    return {
      accepted: true,
      sessionId: memorySessionId,
      context: bootstrap.context,
      contextTruncated: bootstrap.truncated,
      hostOutput: hostContextOutput(input, bootstrap.context),
    };
  }

  if (input.event === 'agent-stop') {
    const agentKey = bindingKey(input, 'turn');
    const closed = await closeHostSessionBinding(agentKey);
    // Emits no host output: SubagentStop may block a subagent from stopping and
    // this never does.
    return { accepted: closed, ...(closed ? {} : { reason: 'event-loss' as const }) };
  }
```

Add the helper above `handleHostLifecycleEvent`:

```typescript
// Subagent bootstrap deliberately halves the recent-context cap: fan-out multiplies
// whatever a subagent costs. The operational card is retained, because it is unverified
// whether MCP instructions reach subagents and a wrong bet there silently disables the
// workflow, while a wrong bet the other way only costs tokens.
async function bootstrapAgentContext(projectId: string, input: NormalizedHostHook, sessionId: string) {
  const bootstrap = await bootstrapAgentSession({
    projectId,
    title: input.title ?? 'Agent session (subagent)',
    agent: String(input.host),
    sessionId,
  }, { includeContext: true });
  const cap = Math.floor(DEFAULT_CONTEXT_MAX_CHARS / 2);
  const context = bootstrap.context ? truncateText(bootstrap.context, cap) : undefined;
  return { context, truncated: Boolean(bootstrap.context && bootstrap.context.length > cap) };
}
```

Add `bootstrapAgentSession` to the imports:

```typescript
import { bootstrapAgentSession } from './context-bootstrap.js';
```

- [x] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/store/host-lifecycle.test.ts`
Expected: PASS, including all pre-existing tests in the file.

- [x] **Step 7: Verify the main-thread path still keys on `__turn__`**

Run: `npx vitest run tests/cli/claude-continuation-reminder.test.ts`
Expected: PASS. This is the regression gate for `bindingKey`: main-session payloads carry no `agent_id`, so the drift reminder must still fire at exactly the 12th tool call. If this fails, the `input.agentId` branch is being taken for main-thread events.

Note: this test runs the built CLI from `dist/index.js`. Run `npm run build` first if it has not been built in this session.

- [x] **Step 8: Commit**

```bash
git add src/store/host-lifecycle.ts tests/store/host-lifecycle.test.ts
git commit -m "feat(lifecycle): scope bindings per subagent and handle SubagentStart/Stop"
```

---

### Task 6: The trigger

**Files:**
- Modify: `src/store/host-lifecycle.ts` (`HostLifecycleResult`, the `session-event` branch)
- Test: `tests/store/host-lifecycle.test.ts`

**Interfaces:**
- Consumes: `readCommitHead`, `loadForeignChanges`, `ChangeSummary` from Tasks 1 and 3; `readHostSeenCommit`, `setHostSeenCommit` from Task 1; `createClaudeChangeCardOutput` from Task 4; `knowlChangeKeys` from Task 2.
- Produces: `HostLifecycleResult.changes?: ChangeSummary`, populated for every host; `hostOutput` carrying the change card for `claude` only.

The ordered rule, which the implementation must follow exactly:

0. `seen === 0 && head > 0` → set `seen = head`, emit nothing.
1. `seen > head` → set `seen = head`, emit nothing. (Snapshot restore reassigns rowids.)
2. `head === seen` → nothing changed; fall through to drift.
3. Otherwise load foreign changes, set `seen = head` unconditionally.
4. Foreign changes present → emit the card and reset drift to zero.
5. Otherwise → existing drift behaviour, unchanged.

- [x] **Step 1: Write the failing test**

Append to `tests/store/host-lifecycle.test.ts`:

```typescript
  const claudeToolEvent = (externalSessionId: string, extra: Partial<NormalizedHostHook> = {}) => hook({
    host: 'claude',
    event: 'session-event',
    type: 'checkpoint',
    externalSessionId,
    externalTurnId: undefined,
    payload: { summary: 'Tool completed' },
    ...extra,
  });

  it('adopts head without notifying when the watermark is uninitialised', async () => {
    await repo.createKnowledgeCommit(projectId, 'Pre-existing history', [
      { itemId: 'history-1', action: 'insert', after: { id: 'history-1', category: 'fact', title: 'Old news' } },
    ]);
    const key: HostSessionKey = {
      host: 'claude',
      projectRoot: ROOT,
      externalSessionId: 'watermark-init-session',
      externalTurnId: '__turn__',
    };
    const session = await startMemorySession(projectId, 'Watermark init');
    await bindHostSession(key, session.id);
    await setHostSeenCommit(key, 0);

    const result = await handleHostLifecycleEvent(projectId, claudeToolEvent('watermark-init-session'));

    expect(result.changes).toBeUndefined();
    expect(result.hostOutput).toBeUndefined();
    expect(await readHostSeenCommit(key)).toBe(await readCommitHead());
  });

  it('emits a change card for a sibling commit and resets drift', async () => {
    const key: HostSessionKey = {
      host: 'claude',
      projectRoot: ROOT,
      externalSessionId: 'sibling-write-session',
      externalTurnId: '__turn__',
    };
    await handleHostLifecycleEvent(projectId, claudeToolEvent('sibling-write-session'));
    await incrementHostSuccessfulToolCount(key);

    await repo.createKnowledgeCommit(projectId, 'Sibling stored a decision', [
      { itemId: 'sibling-x', action: 'insert', after: { id: 'sibling-x', category: 'decision', title: 'Ship the watermark' } },
    ]);

    const result = await handleHostLifecycleEvent(projectId, claudeToolEvent('sibling-write-session'));

    expect(result.changes).toEqual({
      count: 1,
      items: [{ itemId: 'sibling-x', category: 'decision', title: 'Ship the watermark', action: 'insert' }],
    });
    const context = (result.hostOutput as any).hookSpecificOutput.additionalContext as string;
    expect(context).toContain('KNOWL CHANGED: 1 item since you last looked.');
    expect(context).toContain('- decision: Ship the watermark');
    expect(await readHostSeenCommit(key)).toBe(await readCommitHead());

    // The card is delivered once; the next tool event is silent.
    const next = await handleHostLifecycleEvent(projectId, claudeToolEvent('sibling-write-session'));
    expect(next.hostOutput).toBeUndefined();
  });

  it('does not report the agents own write back to it', async () => {
    await handleHostLifecycleEvent(projectId, claudeToolEvent('own-write-session'));

    await repo.createKnowledgeCommit(projectId, 'My own store', [
      { itemId: 'own-1', action: 'insert', after: { id: 'own-1', category: 'fact', title: 'A thing I just learned' } },
    ]);

    const result = await handleHostLifecycleEvent(projectId, claudeToolEvent('own-write-session', {
      knowlTool: true,
      knowlChangeKeys: { ids: [], titles: ['A thing I just learned'] },
    }));

    expect(result.changes).toBeUndefined();
    expect(result.hostOutput).toBeUndefined();
  });

  it('reports a sibling commit even when the agent wrote at the same time', async () => {
    await handleHostLifecycleEvent(projectId, claudeToolEvent('mixed-write-session'));

    await repo.createKnowledgeCommit(projectId, 'Sibling', [
      { itemId: 'mixed-sibling', action: 'insert', after: { id: 'mixed-sibling', category: 'fact', title: 'Sibling fact' } },
    ]);
    await repo.createKnowledgeCommit(projectId, 'Mine', [
      { itemId: 'mixed-mine', action: 'insert', after: { id: 'mixed-mine', category: 'fact', title: 'My fact' } },
    ]);

    const result = await handleHostLifecycleEvent(projectId, claudeToolEvent('mixed-write-session', {
      knowlTool: true,
      knowlChangeKeys: { ids: [], titles: ['My fact'] },
    }));

    expect(result.changes!.items.map(item => item.itemId)).toEqual(['mixed-sibling']);
  });

  it('clamps a watermark ahead of head, as after a snapshot restore', async () => {
    const key: HostSessionKey = {
      host: 'claude',
      projectRoot: ROOT,
      externalSessionId: 'clamp-session',
      externalTurnId: '__turn__',
    };
    await handleHostLifecycleEvent(projectId, claudeToolEvent('clamp-session'));
    await setHostSeenCommit(key, 100_000);

    const result = await handleHostLifecycleEvent(projectId, claudeToolEvent('clamp-session'));

    expect(result.changes).toBeUndefined();
    expect(result.hostOutput).toBeUndefined();
    expect(await readHostSeenCommit(key)).toBe(await readCommitHead());
  });

  it('populates changes for generic hosts without emitting host output', async () => {
    await handleHostLifecycleEvent(projectId, hook({
      host: 'generic',
      event: 'session-event',
      type: 'checkpoint',
      externalSessionId: 'generic-changes-session',
      payload: { summary: 'Tool completed' },
    }));

    await repo.createKnowledgeCommit(projectId, 'Sibling for generic', [
      { itemId: 'generic-1', action: 'insert', after: { id: 'generic-1', category: 'fact', title: 'Generic visible fact' } },
    ]);

    const result = await handleHostLifecycleEvent(projectId, hook({
      host: 'generic',
      event: 'session-event',
      type: 'checkpoint',
      externalSessionId: 'generic-changes-session',
      payload: { summary: 'Tool completed' },
    }));

    expect(result.changes!.items.map(item => item.title)).toEqual(['Generic visible fact']);
    expect(result.hostOutput).toBeUndefined();
  });

  it('prefers the change card over the drift reminder', async () => {
    const key: HostSessionKey = {
      host: 'claude',
      projectRoot: ROOT,
      externalSessionId: 'precedence-session',
      externalTurnId: '__turn__',
    };
    await handleHostLifecycleEvent(projectId, claudeToolEvent('precedence-session'));
    // Park drift one short of the threshold so the next event would emit the static card.
    for (let index = 0; index < 11; index++) await incrementHostSuccessfulToolCount(key);

    await repo.createKnowledgeCommit(projectId, 'Sibling at drift boundary', [
      { itemId: 'precedence-1', action: 'insert', after: { id: 'precedence-1', category: 'fact', title: 'Boundary fact' } },
    ]);

    const result = await handleHostLifecycleEvent(projectId, claudeToolEvent('precedence-session'));
    const context = (result.hostOutput as any).hookSpecificOutput.additionalContext as string;

    expect(context).toContain('KNOWL CHANGED');
    expect(context).not.toContain(KNOWL_CLAUDE_CONTINUATION_REMINDER);
  });
```

Add to that file's imports:

```typescript
import { readCommitHead } from '../../src/store/change-watermark.js';
import { readHostSeenCommit, setHostSeenCommit } from '../../src/store/host-session-bindings.js';
```

Task 1 already added the second import to this file's sibling suite; here it must be added to `tests/store/host-lifecycle.test.ts` specifically.

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/store/host-lifecycle.test.ts`
Expected: FAIL — `result.changes` is undefined on the sibling-commit case, and no change card appears in `hostOutput`.

- [x] **Step 3: Add `changes` to the result type**

In `src/store/host-lifecycle.ts`, add to `HostLifecycleResult`:

```typescript
  changes?: ChangeSummary;
```

Add the imports:

```typescript
import { ChangeSummary, loadForeignChanges, readCommitHead } from './change-watermark.js';
import { createClaudeChangeCardOutput } from '../cli/agents/change-card.js';
```

and extend the existing `host-session-bindings.js` import with `readHostSeenCommit` and `setHostSeenCommit`.

- [x] **Step 4: Implement the trigger**

Add above `handleHostLifecycleEvent`:

```typescript
/**
 * Ordered watermark rule. Always advances to head; returns only the changes that are
 * not the caller's own. Returns undefined when there is nothing to report, which
 * includes the uninitialised and clamp cases.
 */
async function evaluateChangeNotification(
  input: NormalizedHostHook,
  key: HostSessionKey,
): Promise<ChangeSummary | undefined> {
  const head = await readCommitHead();
  const seen = await readHostSeenCommit(key);
  if (seen === null) return undefined;

  // 0 means "uninitialised", not "has seen no commits": adopt head silently rather
  // than reporting the entire history. Covers rows migrated by the ALTER TABLE.
  if (seen === 0 && head > 0) {
    await setHostSeenCommit(key, head);
    return undefined;
  }
  // Snapshot restore reassigns rowids, so a stored watermark can exceed head.
  if (seen > head) {
    await setHostSeenCommit(key, head);
    return undefined;
  }
  if (seen === head) return undefined;

  const summary = await loadForeignChanges(seen, input.knowlChangeKeys);
  await setHostSeenCommit(key, head);
  return summary.count > 0 ? summary : undefined;
}
```

Then replace the reminder block inside the `session-event` / `checkpoint` branch of `handleHostLifecycleEvent`:

```typescript
      let hostOutput: Record<string, unknown> | undefined;
      let changes: ChangeSummary | undefined;
      if (input.event === 'session-event' && input.status !== 'failed') {
        const key = bindingKey(input, 'turn');
        changes = await evaluateChangeNotification(input, key);
        if (changes) {
          // Change news implies "go query", so it replaces the static drift nudge and
          // resets the counter. At most one card per tool event, never two.
          await resetHostSuccessfulToolCount(key);
          if (input.host === 'claude') hostOutput = createClaudeChangeCardOutput(changes);
        } else if (input.host === 'claude') {
          // Adaptive continuation reminder: only nudge Claude after a run of tool calls
          // that ignored Knowl. Using a Knowl tool resets the drift counter, so an agent
          // that is querying/storing memory never sees a reminder.
          if (input.knowlTool) {
            await resetHostSuccessfulToolCount(key);
          } else {
            const drift = await incrementHostSuccessfulToolCount(key);
            if (drift > 0 && drift % KNOWL_REMINDER_DRIFT === 0) hostOutput = createClaudePostToolReminderOutput();
          }
        }
      }
      return { accepted: true, sessionId: started.session.id, hostOutput, ...(changes ? { changes } : {}) };
```

- [x] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/store/host-lifecycle.test.ts`
Expected: PASS, all seven new cases plus every pre-existing case.

- [x] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS. Watch particularly for `tests/cli/claude-continuation-reminder.test.ts`, `tests/store/host-session-bindings.test.ts`, and `tests/store/session-handoff.test.ts`.

- [x] **Step 7: Commit**

```bash
git add src/store/host-lifecycle.ts tests/store/host-lifecycle.test.ts
git commit -m "feat(lifecycle): notify agents of foreign memory changes on tool events"
```

---

### Task 7: Register the subagent hooks end to end

**Files:**
- Modify: `src/cli/agents/hook-config.ts:9`
- Test: `tests/cli/claude-subagent-notification.test.ts` (create)

**Interfaces:**
- Consumes: everything from Tasks 1-6.
- Produces: `CLAUDE_HOOK_EVENTS` includes `SubagentStart` and `SubagentStop`, so `knowl init` writes handlers for them and `verifyNestedHookConfig` requires them.

- [x] **Step 1: Write the failing test**

Create `tests/cli/claude-subagent-notification.test.ts`:

```typescript
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLAUDE_HOOK_EVENTS } from '../../src/cli/agents/hook-config.js';

const TEST_DIR = path.resolve('./.knowl-claude-subagent-notification-test');
const CLI_PATH = path.resolve('./dist/index.js');

function run(args: string[], input?: string): string {
  return execFileSync(process.execPath, [CLI_PATH, ...args], {
    cwd: TEST_DIR,
    encoding: 'utf8',
    input,
  });
}

const post = (sessionId: string, agentId: string | undefined, toolName: string, toolInput: unknown) =>
  run(['agent-hook', 'claude', 'PostToolUse', '--json'], JSON.stringify({
    session_id: sessionId,
    cwd: TEST_DIR,
    ...(agentId ? { agent_id: agentId, agent_type: 'Explore' } : {}),
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: { exit_code: 0 },
  }));

describe('Claude subagent change notification CLI', () => {
  beforeAll(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
    await fs.mkdir(TEST_DIR, { recursive: true });
    run(['init', '--yes']);
  }, 120_000);

  afterAll(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it('registers SubagentStart and SubagentStop handlers', async () => {
    expect(CLAUDE_HOOK_EVENTS).toContain('SubagentStart');
    expect(CLAUDE_HOOK_EVENTS).toContain('SubagentStop');

    const settings = JSON.parse(await fs.readFile(path.join(TEST_DIR, '.claude', 'settings.json'), 'utf8'));
    for (const event of ['SubagentStart', 'SubagentStop']) {
      const handlers = settings.hooks[event].flatMap((entry: any) => entry.hooks);
      expect(handlers.some((hook: any) => hook.command.includes(`agent-hook claude ${event} `))).toBe(true);
    }
  }, 120_000);

  it('bootstraps a subagent and then notifies it of a sibling write', async () => {
    run(['agent-hook', 'claude', 'SessionStart', '--json'], JSON.stringify({
      session_id: 'e2e-session',
      cwd: TEST_DIR,
    }));

    const bootstrap = run(['agent-hook', 'claude', 'SubagentStart', '--json'], JSON.stringify({
      session_id: 'e2e-session',
      cwd: TEST_DIR,
      agent_id: 'e2e-agent',
      agent_type: 'Explore',
      prompt_id: 'prompt-1',
    }));
    expect(JSON.parse(bootstrap).hookSpecificOutput.hookEventName).toBe('SubagentStart');

    // The subagent's first tool call adopts head silently.
    expect(post('e2e-session', 'e2e-agent', 'Grep', { pattern: 'x' })).toBe('');

    // A sibling stores something the subagent has never seen. `knowl decide <title>
    // <content>` is non-interactive when both positionals are given, and creates
    // exactly one commit through recordDecisionDirect.
    run(['decide', 'Sibling wrote this decision', 'Stored by another agent.']);

    const notified = post('e2e-session', 'e2e-agent', 'Grep', { pattern: 'y' });
    const context = JSON.parse(notified).hookSpecificOutput.additionalContext as string;
    expect(context).toContain('KNOWL CHANGED: 1 item since you last looked.');
    expect(context).toContain('- decision: Sibling wrote this decision');

    // Delivered once only.
    expect(post('e2e-session', 'e2e-agent', 'Grep', { pattern: 'z' })).toBe('');
  }, 120_000);

  it('does not notify the agent that made the write', async () => {
    run(['agent-hook', 'claude', 'SubagentStart', '--json'], JSON.stringify({
      session_id: 'e2e-writer-session',
      cwd: TEST_DIR,
      agent_id: 'writer-agent',
      agent_type: 'general-purpose',
      prompt_id: 'prompt-2',
    }));
    expect(post('e2e-writer-session', 'writer-agent', 'Grep', { pattern: 'warmup' })).toBe('');

    run(['decide', 'The writer agent own decision', 'Written by the same agent.']);

    // The PostToolUse that follows the agent's own write carries the same title in
    // tool_input, so content attribution recognises the commit as its own.
    const output = post('e2e-writer-session', 'writer-agent', 'mcp__knowl__knowl_decide', {
      title: 'The writer agent own decision',
      content: 'Written by the same agent.',
    });
    expect(output).toBe('');
  }, 120_000);

  it('closes the subagent binding on SubagentStop without emitting output', () => {
    expect(run(['agent-hook', 'claude', 'SubagentStop', '--json'], JSON.stringify({
      session_id: 'e2e-session',
      cwd: TEST_DIR,
      agent_id: 'e2e-agent',
      agent_type: 'Explore',
      stop_hook_active: false,
      last_assistant_message: 'done',
    }))).toBe('');
  }, 120_000);
});
```

There is no `knowl store` CLI command — `decide` is the direct write path (`src/index.ts:397-403`), and it runs non-interactively only when both the title and content positionals are supplied. It records a `decision`, which is why the expected card line reads `- decision: ...` rather than `- fact: ...`.

- [x] **Step 2: Build and run the test to verify it fails**

Run: `npm run build && npx vitest run tests/cli/claude-subagent-notification.test.ts`
Expected: FAIL on the first case — `settings.hooks.SubagentStart` is undefined.

- [x] **Step 3: Register the events**

In `src/cli/agents/hook-config.ts`, replace line 9:

```typescript
export const CLAUDE_HOOK_EVENTS = ['SessionStart', 'SubagentStart', 'PostToolUse', 'PostToolUseFailure', 'PreCompact', 'Stop', 'StopFailure', 'SubagentStop', 'SessionEnd'] as const;
```

`nestedStatusMessage` needs no change: only `SessionStart` shows a status message, and everything else returns `''` to avoid status spam.

- [x] **Step 4: Rebuild and run the test to verify it passes**

Run: `npm run build && npx vitest run tests/cli/claude-subagent-notification.test.ts`
Expected: PASS, all four cases.

- [x] **Step 5: Confirm re-running `init` is idempotent**

Run: `npx vitest run tests/cli/init-flow.test.ts tests/cli/agent-adapters.test.ts`
Expected: PASS. `mergeNestedHookConfig` must add exactly one handler per new event and report `unchanged` on a second run. Hook config takes effect live rather than at next session start, so a duplicated handler would fire twice immediately.

- [x] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add src/cli/agents/hook-config.ts tests/cli/claude-subagent-notification.test.ts
git commit -m "feat(hooks): register SubagentStart and SubagentStop for Claude"
```

- [x] **Step 8: Update the spec status**

In `docs/superpowers/specs/2026-07-25-agent-change-notification-design.md`, change the status line to `**Status:** Implemented.` and commit:

```bash
git add docs/superpowers/specs/2026-07-25-agent-change-notification-design.md
git commit -m "docs: mark agent change notification spec as implemented"
```

---

## Manual verification

Automated tests cover the state machine, but two behaviours are only observable in a live session. After Task 7, verify by hand:

1. **Subagent bootstrap actually arrives.** Spawn an `Explore` subagent and confirm from its transcript that it received Knowl context at `SubagentStart`. This also settles the open question the spec flags — whether MCP `instructions` reach subagents — because if the operational card is visibly redundant there, the card can be dropped from the subagent bootstrap as a follow-up.

   **Performed 2026-07-25 — found a defect, now fixed.** Memory context arrived correctly. Guidance did not: the subagent received no prompt reminder, no MCP server `instructions` block, and no host instruction file. The spec's open question is therefore answered **no** — MCP instructions do *not* reach subagents — which invalidated the assumption behind omitting the card. The subagent had project memory and nothing telling it to use memory. Fixed by prepending `KNOWL_SUBAGENT_BOOTSTRAP_CARD` in `bootstrapAgentContext`, charged against the halved cap first so recent-context cannot truncate the guidance away. Re-probed after the fix: guidance arrives and precedes the data.

   Two incidental findings worth keeping: memory tools reach a subagent as *deferred* names whose schemas are not loaded, so the card tells the agent to load them; and subagent guidance must never point at `KNOWL.md`, which is not in subagent context.

2. **Sibling notification in a real fan-out.** Spawn two subagents, have one store a fact, and confirm the other receives a `KNOWL CHANGED` card on its next tool call and does not receive one for its own write.

   **Performed 2026-07-25 — passed.** A background subagent ran ten sequential `Read` calls while the parent session landed one `knowl_store` commit mid-run. The subagent received exactly one card, on the first tool event after the commit:

   ```
   KNOWL CHANGED: 1 item since you last looked.
   - state: Change-notification plan manual verification status 2026-07-25
   Call knowl_query before relying on earlier memory in these areas.
   ```

   It named the committed atom exactly, arrived as `PostToolUse` `additionalContext`, and fired once rather than on every subsequent tool call — so the watermark advances as designed. The nine other Reads produced no card.

   Two notes from the run. The probe speculated the trigger might be tied to the file it read (`KNOWL.md`); it is not — the card fired on that Read because that is when the commit landed, and the rule is `head > seen` with no path involvement, relevance filtering being an explicit non-goal. Separately, an unrelated `knowl_store` in the same window was silently deduped and produced no commit at all, which is what surfaced the write-loss defect fixed alongside this verification.

## Spec coverage

| Spec section | Tasks |
| --- | --- |
| §1 agent-scoped binding key | 5 |
| §1 `agent_type` used for naming only | 2 (title), 5 (binding) |
| §1 `SubagentStart` / `SubagentStop` events | 2 (normalization), 5 (handlers), 7 (registration) |
| §1 subagent bootstrap with halved context, card retained | 5 |
| §1 verified payload contract | 2 |
| §2 `seen_commit_rowid` state and migration | 1 |
| §2 zero-is-uninitialised, both measures | 1 (bind writes head), 6 (step 0) |
| §2 ordered rule including clamp | 6 |
| §2 content attribution | 2 (key extraction), 3 (matching) |
| §3 payload format, caps, action verbs, title fallback | 3 (title fallback), 4 (rendering) |
| §4 precedence | 6 |
| §4 host coverage: claude full, codex/cursor watermark only, generic `changes` | 6 |
| §4 no daemon, no extra stdout, latency | Global Constraints; enforced by the `''` assertions in Tasks 5 and 7 |

Not implemented, by design: relevance filtering, commit attribution columns, MCP-response headers, and enabling the card for `codex` — all listed as spec non-goals or deferred pending verification.
