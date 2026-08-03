# Deliberate Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a session park a workstream on purpose, so the next session in the project is handed a baton that reads as planned work rather than as damage to repair.

**Architecture:** `main` already has a one-shot handoff slot used for crashes — one pending handoff per project, delivered once to the next session, then archived. This adds a `handoff` *kind* to that existing machinery rather than building a second channel: same slot, same claim, same delivery. Only the kind differs, and with it the opening the receiving session reads.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `@libsql/client`, Vitest, MCP SDK.

**Adapted from PR #10** (`William-Sommers:feat/deliberate-handoff`). That PR is stacked on #7 and #8, so its 1,963-line diff is mostly those; the unique work is `src/store/session-handoff.ts`, a conflict-key fix, and one MCP tool. This plan takes only the unique part, rebased onto current `main`.

## Global Constraints

- **ESM imports.** All relative imports end in `.js`.
- **Do not touch the transcript modules.** This feature is independent of `src/transcripts/`; if a task seems to need them, the task is wrong.
- **One baton per project.** Parking again replaces the previous pending handoff. Anything worth keeping durably goes to `knowl_store`, not here.
- **Delivery stays one-shot.** A handoff is consumed and archived on read. This is a pass, not a durable note.
- **Tool inventory is asserted.** `tests/core/knowl-guidance.test.ts:44-45` pins `KNOWL_MCP_TOOL_GROUPS` at **7 groups** and `KNOWL_MCP_TOOL_NAMES` at exactly **24 tools**. This plan takes both to **8 groups / 25 tools**; update the fixture deliberately, never by pasting whatever the code produces.
- **Verification gate:** `npm test` + `npm run build` + `git diff --check`. Do **not** gate on `npx tsc --noEmit` — `main` has 15 pre-existing errors in files this work does not touch.
- **Commit style:** Conventional Commits, lowercase subject, no trailing period.

---

### Task 1: Derive the kind list instead of hand-maintaining it

The defect this fixes is real and already present on `main`: [session-handoff.ts:167](../../../src/store/session-handoff.ts#L167) validates the parsed kind against a **hardcoded array literal**, while the `SessionFailureKind` type is declared separately at lines 15-21. Adding a kind to the type does not add it to the parser, so a baton of the new kind is written successfully and then silently dropped on every read — the failure is invisible at write time and total at read time.

Fixing this **before** adding a kind is the whole point of the ordering: do it after, and the new feature simply does not work with no error to explain why.

**Files:**
- Modify: `src/store/session-handoff.ts:15-21` (the type), `:167` (the parser)
- Test: `tests/store/deliberate-handoff.test.ts` (new file)

**Interfaces:**
- Consumes: nothing
- Produces:
  - `SESSION_HANDOFF_KINDS: readonly ['handoff', 'rate_limit', 'auth', 'provider_outage', 'interrupted', 'failed']`
  - `SessionFailureKind = typeof SESSION_HANDOFF_KINDS[number]` (unchanged shape, new derivation)

- [ ] **Step 1: Write the failing test**

Create `tests/store/deliberate-handoff.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { SESSION_HANDOFF_KINDS } from '../../src/store/session-handoff.js';

describe('handoff kind inventory', () => {
  it('is a single list the type, the writer and the parser all derive from', () => {
    expect([...SESSION_HANDOFF_KINDS]).toEqual([
      'handoff', 'rate_limit', 'auth', 'provider_outage', 'interrupted', 'failed',
    ]);
  });

  it('includes the deliberate kind, which the crash kinds do not cover', () => {
    expect(SESSION_HANDOFF_KINDS).toContain('handoff');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/deliberate-handoff.test.ts`
Expected: FAIL — `SESSION_HANDOFF_KINDS` is not exported.

- [ ] **Step 3: Replace the type declaration with a derived one**

In `src/store/session-handoff.ts`, replace the `SessionFailureKind` union (lines 15-21) with:

```typescript
/**
 * Every kind a pending handoff can carry.
 *
 * `handoff` is the one that is not a failure: the user parked a workstream deliberately. It
 * rides the same slot, claim and delivery machinery as a crash, because none of that differs --
 * only the opening the receiving session should read.
 *
 * A single `const` the type, the writer and the parser all derive from. They used to be two
 * hand-maintained copies, and the parser's copy was the shorter one: a kind added to the type
 * was written successfully and then dropped on every read, with nothing to notice at write time.
 */
export const SESSION_HANDOFF_KINDS = [
  'handoff',
  'rate_limit',
  'auth',
  'provider_outage',
  'interrupted',
  'failed',
] as const;

export type SessionFailureKind = typeof SESSION_HANDOFF_KINDS[number];
```

- [ ] **Step 4: Point the parser at the same list**

At line 167, replace the array literal:

```typescript
    // Derived, never a second copy: a hand-maintained duplicate here is what made a newly
    // added kind unreadable.
    if (!(SESSION_HANDOFF_KINDS as readonly string[]).includes(parsed.kind)) return null;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/store/deliberate-handoff.test.ts`
Expected: PASS, 2 tests

Run: `npx vitest run tests/store`
Expected: PASS — the existing crash-handoff tests must be unaffected, since the five crash kinds are unchanged and only their source moved.

- [ ] **Step 6: Commit**

```bash
git add src/store/session-handoff.ts tests/store/deliberate-handoff.test.ts
git commit -m "fix(handoff): derive the kind list so a new kind cannot be written-but-unreadable"
```

---

### Task 2: A planned baton reads differently from a crash

**Files:**
- Modify: `src/store/session-handoff.ts:9-13` (urgency constants), `:262` (`formatPendingHandoffContext`), and the `PendingHandoff.urgency` type at `:31`
- Test: `tests/store/deliberate-handoff.test.ts`

**Interfaces:**
- Consumes: `SESSION_HANDOFF_KINDS` (Task 1)
- Produces: `HANDOFF_URGENCY = 'planned'`; `formatPendingHandoffContext` branches on `kind === 'handoff'`

Why this is its own task: the existing opening is *actively wrong* for parked work. "Ended before a clean finish. Continue from this handoff first." tells the next session to treat a deliberate stopping point as damage. A reviewer could accept Task 1 and reject this wording independently.

- [ ] **Step 1: Write the failing test**

Append to `tests/store/deliberate-handoff.test.ts`:

```typescript
import { formatPendingHandoffContext, HANDOFF_URGENCY } from '../../src/store/session-handoff.js';
import type { PendingHandoff } from '../../src/store/session-handoff.js';

const baseHandoff = (over: Partial<PendingHandoff> = {}): PendingHandoff => ({
  kind: 'handoff',
  urgency: HANDOFF_URGENCY,
  host: 'claude',
  projectRoot: '/repo/knowl',
  externalSessionId: 'session-abc',
  failedAt: '2026-08-03T10:00:00.000Z',
  consumed: false,
  taskState: { goal: 'Ship the parser', nextAction: 'Wire the CLI flag' },
  ...over,
} as PendingHandoff);

describe('handoff context reads by kind', () => {
  it('opens a planned baton as parked work, not as damage', () => {
    const text = formatPendingHandoffContext(baseHandoff());

    expect(text).toContain('SESSION HANDOFF');
    expect(text).toMatch(/parked this work for you on purpose/i);
    expect(text).toMatch(/Parked at:/);
    expect(text).not.toMatch(/ended before a clean finish/i);
    expect(text).not.toMatch(/Failed at:/);
  });

  it('keeps the crash opening for a crash', () => {
    const text = formatPendingHandoffContext(baseHandoff({
      kind: 'rate_limit',
      urgency: 'critical',
    }));

    expect(text).toMatch(/ended before a clean finish/i);
    expect(text).toMatch(/Failed at:/);
    expect(text).not.toMatch(/on purpose/i);
  });

  it('carries the task state either way', () => {
    for (const kind of ['handoff', 'interrupted'] as const) {
      const text = formatPendingHandoffContext(baseHandoff({ kind } as Partial<PendingHandoff>));
      expect(text).toContain('Ship the parser');
      expect(text).toContain('Wire the CLI flag');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/deliberate-handoff.test.ts`
Expected: FAIL — `HANDOFF_URGENCY` is not exported.

- [ ] **Step 3: Add the urgency and widen the type**

In `src/store/session-handoff.ts`, beside the existing urgency constants (lines 9-13):

```typescript
/** Not an urgency in the alarm sense. A parked baton is waiting, not burning. */
export const HANDOFF_URGENCY = 'planned';
```

Then widen the `urgency` field on `PendingHandoff` (around line 31) to include it:

```typescript
  urgency:
    | typeof RATE_LIMIT_URGENCY
    | typeof AUTH_URGENCY
    | typeof PROVIDER_OUTAGE_URGENCY
    | typeof INTERRUPTED_URGENCY
    | typeof GENERIC_FAILURE_URGENCY
    | typeof HANDOFF_URGENCY;
```

- [ ] **Step 4: Branch the rendered context**

In `formatPendingHandoffContext` (around line 262), compute the kind once and use it for the three lines that differ. Keep every other line exactly as it is:

```typescript
  // A planned baton and a crash both arrive here and deserve opposite openings: one resumes
  // work, the other recovers from a blocker. Telling a session that parked cleanly it "ended
  // before a clean finish" invites it to go looking for damage that does not exist.
  const planned = handoff.kind === 'handoff';
```

- the title line becomes `planned ? '# KNOWL - SESSION HANDOFF' : '# KNOWL - PENDING SESSION HANDOFF'`
- the lede becomes `planned ? 'The previous session parked this work for you on purpose. Pick it up from here.' : 'Previous host session ended before a clean finish. Continue from this handoff first.'`
- the timestamp line becomes `planned ? \`- Parked at: ${handoff.failedAt}\` : \`- Failed at: ${handoff.failedAt}\``

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/store/deliberate-handoff.test.ts`
Expected: PASS, 5 tests

Run: `npx vitest run tests/store tests/cli`
Expected: PASS — existing crash-handoff assertions still hold.

- [ ] **Step 6: Commit**

```bash
git add src/store/session-handoff.ts tests/store/deliberate-handoff.test.ts
git commit -m "feat(handoff): open a planned baton as parked work rather than as a crash"
```

---

### Task 3: Record a deliberate handoff

**Files:**
- Modify: `src/store/session-handoff.ts` (add beside `recordPendingSessionHandoff` at `:293`)
- Test: `tests/store/deliberate-handoff.test.ts`

**Interfaces:**
- Consumes: `HANDOFF_URGENCY` (Task 2), the existing `recordPendingSessionHandoff` write path, `HandoffTaskState` (already exported at `:22`)
- Produces:
  ```typescript
  recordDeliberateHandoff(projectId: string, input: {
    host: string;
    projectRoot: string;
    externalSessionId: string;
    sessionTitle?: string;
    taskState: HandoffTaskState;
  }): Promise<{ itemId: string; handoff: PendingHandoff }>
  ```

Read `recordPendingSessionHandoff` before writing this. It already handles the slot, the conflict key, replacement of an existing pending handoff, and the merge with the latest checkpoint. Reuse that path; do not write a second one. The only differences are the kind, the urgency, and that a deliberate handoff takes its task state from the caller instead of inferring it from a failure.

- [ ] **Step 1: Write the failing test**

Append to `tests/store/deliberate-handoff.test.ts`. Follow the setup in `tests/store/` for `initDb` + `createProject`; copy it from an existing store test rather than inventing one:

```typescript
describe('recordDeliberateHandoff', () => {
  it('parks a baton and delivers it exactly once', async () => {
    await recordDeliberateHandoff(projectId, {
      host: 'claude',
      projectRoot: TEST_ROOT,
      externalSessionId: 'session-one',
      taskState: { goal: 'Ship the parser', nextAction: 'Wire the CLI flag' },
    });

    const first = await consumePendingSessionHandoff({ host: 'claude', projectRoot: TEST_ROOT, externalSessionId: 'session-two' });
    expect(first?.kind).toBe('handoff');
    expect(first?.taskState?.goal).toBe('Ship the parser');

    // One-shot: the next session gets nothing.
    const second = await consumePendingSessionHandoff({ host: 'claude', projectRoot: TEST_ROOT, externalSessionId: 'session-three' });
    expect(second).toBeNull();
  });

  it('holds one baton per project - parking again replaces the previous one', async () => {
    await recordDeliberateHandoff(projectId, {
      host: 'claude', projectRoot: TEST_ROOT, externalSessionId: 'session-one',
      taskState: { goal: 'First goal' },
    });
    await recordDeliberateHandoff(projectId, {
      host: 'claude', projectRoot: TEST_ROOT, externalSessionId: 'session-one',
      taskState: { goal: 'Second goal' },
    });

    const received = await consumePendingSessionHandoff({ host: 'claude', projectRoot: TEST_ROOT, externalSessionId: 'session-two' });
    expect(received?.taskState?.goal).toBe('Second goal');

    expect(await consumePendingSessionHandoff({ host: 'claude', projectRoot: TEST_ROOT, externalSessionId: 'session-three' })).toBeNull();
  });

  it('supersedes a stale crash handoff rather than queueing behind it', async () => {
    await recordPendingSessionHandoff(projectId, {
      host: 'claude', projectRoot: TEST_ROOT, externalSessionId: 'session-crashed',
      kind: 'interrupted',
    } as never);

    await recordDeliberateHandoff(projectId, {
      host: 'claude', projectRoot: TEST_ROOT, externalSessionId: 'session-one',
      taskState: { goal: 'Deliberate goal' },
    });

    const received = await consumePendingSessionHandoff({ host: 'claude', projectRoot: TEST_ROOT, externalSessionId: 'session-two' });
    expect(received?.kind).toBe('handoff');
    expect(received?.taskState?.goal).toBe('Deliberate goal');
  });

  it('carries artifact references through the round trip', async () => {
    await recordDeliberateHandoff(projectId, {
      host: 'claude', projectRoot: TEST_ROOT, externalSessionId: 'session-one',
      taskState: {
        goal: 'Ship the parser',
        artifactRefs: ['src/parser.ts', 'docs/parser.md'],
        verificationStatus: 'unverified',
      },
    });

    const received = await consumePendingSessionHandoff({ host: 'claude', projectRoot: TEST_ROOT, externalSessionId: 'session-two' });
    expect(received?.taskState?.artifactRefs).toEqual(['src/parser.ts', 'docs/parser.md']);
    expect(received?.taskState?.verificationStatus).toBe('unverified');
  });
});
```

Adjust the `recordPendingSessionHandoff` call in the third test to that function's real signature — read it at `:293` first; the shape above is illustrative of intent, not of its parameters.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/deliberate-handoff.test.ts`
Expected: FAIL — `recordDeliberateHandoff` is not exported.

- [ ] **Step 3: Write the implementation**

Add to `src/store/session-handoff.ts`:

```typescript
/**
 * Park a workstream on purpose.
 *
 * Same slot and same one-shot delivery as a crash handoff, so nothing new is built for the
 * receiving side -- only the kind differs, and with it the tone the next session opens in.
 *
 * One baton per project: an existing pending handoff is replaced. That is the right behaviour
 * for "I am leaving this session now", and it is also why this is a pass rather than a durable
 * note -- anything worth keeping goes to `knowl_store`.
 */
export async function recordDeliberateHandoff(
  projectId: string,
  input: {
    host: string;
    projectRoot: string;
    externalSessionId: string;
    sessionTitle?: string;
    taskState: HandoffTaskState;
  },
): Promise<{ itemId: string; handoff: PendingHandoff }> {
  const handoff: PendingHandoff = {
    kind: 'handoff',
    urgency: HANDOFF_URGENCY,
    host: input.host,
    projectRoot: input.projectRoot,
    externalSessionId: input.externalSessionId,
    sessionTitle: input.sessionTitle,
    taskState: input.taskState,
    failedAt: new Date().toISOString(),
    consumed: false,
  };

  return persistPendingHandoff(projectId, handoff);
}
```

`persistPendingHandoff` is whatever `recordPendingSessionHandoff` already uses to write the item, set the conflict key and replace the previous pending row. If that logic is currently inline in `recordPendingSessionHandoff`, extract it into a private helper first and have both call it — one write path, not two. Do the extraction as part of this step; a second copy is how the two kinds drift apart later.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/store/deliberate-handoff.test.ts`
Expected: PASS, 9 tests

Run: `npx vitest run tests/store`
Expected: PASS — the extraction must leave crash handoffs byte-identical in behaviour.

- [ ] **Step 5: Commit**

```bash
git add src/store/session-handoff.ts tests/store/deliberate-handoff.test.ts
git commit -m "feat(handoff): record a deliberate baton through the existing slot"
```

---

### Task 4: The `knowl_handoff` MCP tool

**Files:**
- Modify: `src/mcp/tools.ts` (tool list + dispatcher)
- Modify: `src/core/knowl-guidance.ts` (`KNOWL_MCP_TOOL_GROUPS`)
- Modify: `tests/core/knowl-guidance.test.ts:16` (`EXPECTED_TOOLS`), `:44` (group count)
- Test: `tests/mcp/server.test.ts`

**Interfaces:**
- Consumes: `recordDeliberateHandoff` (Task 3)
- Produces: MCP tool `knowl_handoff`; `KNOWL_MCP_TOOL_GROUPS` at 8 groups, `KNOWL_MCP_TOOL_NAMES` at 25

Unlike the transcript tools, this one is **not gated** — it needs no index, no model, and no config. It is registered unconditionally like every other tool.

- [ ] **Step 1: Write the failing test**

Update `tests/core/knowl-guidance.test.ts`: add `'knowl_handoff'` to `EXPECTED_TOOLS` (line 16) and change `toHaveLength(7)` to `toHaveLength(8)` (line 44). Then append to `tests/mcp/server.test.ts`, using that file's existing `runRpcRequest` helper:

```typescript
  it('lists knowl_handoff', async () => {
    const response = await runRpcRequest('tools/list', {});
    const names = response.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain('knowl_handoff');
  });

  it('parks a baton through the tool and reports it back', async () => {
    const response = await runRpcRequest('tools/call', {
      name: 'knowl_handoff',
      arguments: {
        goal: 'Ship the parser',
        nextAction: 'Wire the CLI flag',
        completed: ['schema', 'tests'],
        verificationStatus: 'unverified',
      },
    });

    const text = JSON.stringify(response.result);
    expect(text).toMatch(/parked/i);
    expect(text).toContain('Ship the parser');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/knowl-guidance.test.ts tests/mcp/server.test.ts`
Expected: FAIL — the tool is not registered, and the inventory assertions do not match.

- [ ] **Step 3: Add the guidance group**

In `src/core/knowl-guidance.ts`, add to `KNOWL_MCP_TOOL_GROUPS`:

```typescript
  {
    label: 'Session handoff',
    tools: ['knowl_handoff'],
    routing: 'Use when parking a workstream before ending a session. The next session in this project receives it once, then it is archived. One baton per project -- parking again replaces it. Durable facts still belong in knowl_store.',
  },
```

Then add one Route line to the compact card's hand-written list, matching the existing bullets' phrasing:

```typescript
    '- handoff: knowl_handoff when parking a workstream; the next session in this project receives it once, then it is archived.',
```

The compact card is measured against a 2,000-character ceiling. It was 1,746 before the transcript work; check the length after this addition and say so in the commit message.

- [ ] **Step 4: Register and dispatch the tool**

In `src/mcp/tools.ts`, add to the tool list:

```typescript
        {
          name: 'knowl_handoff',
          description: 'Park the current workstream so the next session in this project picks it up. Delivered once, then archived - this is a pass, not a durable note. Store anything worth keeping with knowl_store.',
          inputSchema: {
            type: 'object',
            properties: {
              goal: { type: 'string', description: 'What this workstream is trying to achieve.' },
              completed: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'What is already done.' },
              nextAction: { type: 'string', description: 'The single next thing to do.' },
              blocker: { type: 'string', description: 'What is in the way, if anything.' },
              artifactRefs: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'Files or paths the next session should look at.' },
              verificationStatus: { type: 'string', enum: ['verified', 'unverified'], description: 'Whether the work so far was checked.' },
            },
            required: ['goal', 'nextAction'],
          },
        },
```

And in the dispatcher, following the shape of the neighbouring handlers:

```typescript
    if (name === 'knowl_handoff') {
      const projectId = getProjectId();
      const projectRoot = getProjectRoot();
      if (!projectId || !projectRoot) return textResult('Project is not initialized.');

      const { handoff } = await recordDeliberateHandoff(projectId, {
        host: 'claude',
        projectRoot,
        externalSessionId: String(args.sessionId ?? 'unknown'),
        taskState: {
          goal: String(args.goal ?? ''),
          nextAction: String(args.nextAction ?? ''),
          completed: Array.isArray(args.completed) ? args.completed.map(String).slice(0, 20) : undefined,
          blocker: args.blocker ? String(args.blocker) : undefined,
          artifactRefs: Array.isArray(args.artifactRefs) ? args.artifactRefs.map(String).slice(0, 20) : undefined,
          verificationStatus: args.verificationStatus === 'verified' ? 'verified' : 'unverified',
        },
      });

      return textResult(
        `Parked. The next session in this project will receive this once.\n\n${formatPendingHandoffContext(handoff)}`,
      );
    }
```

Match the surrounding handlers' return shape exactly — read two neighbours and use whatever result helper they use rather than the literal `textResult` above if the name differs.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/core/knowl-guidance.test.ts tests/mcp/server.test.ts tests/store/deliberate-handoff.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools.ts src/core/knowl-guidance.ts tests/core/knowl-guidance.test.ts tests/mcp/server.test.ts
git commit -m "feat(handoff): expose knowl_handoff and add it to the tool inventory"
```

---

### Task 5: Normalize the conflict key on update, not only on create

PR #10 carries this fix and it is genuinely independent of handoffs — it belongs here only because that is where it was found. A conflict key written through the update path bypassed `normalizeConflictKey`, so the same logical identity could be stored raw in one row and normalized in another, and the two never collided.

**Files:**
- Modify: `src/store/repository.ts` (the update path), `src/store/integrity.ts` (repair)
- Test: `tests/store/conflicts.test.ts`

**Interfaces:**
- Consumes: `normalizeConflictKey` from `src/store/conflicts.js` (already exported at `:6`)
- Produces: `isNormalizedConflictKey(value: string): boolean` in `conflicts.ts`; an integrity check that repairs rows stored raw

Confirm the defect before fixing it. `normalizeConflictKey` is called at [repository.ts:179](../../../src/store/repository.ts#L179); check whether that line is on the create path, the update path, or both. If update already normalizes, **skip this task and say so** — do not invent a fix for a bug that is not there.

- [ ] **Step 1: Write the failing test**

Append to `tests/store/conflicts.test.ts`:

```typescript
describe('conflict key normalization on update', () => {
  it('normalizes a key written through UPDATE, not only through create', async () => {
    const item = await repo.createKnowledgeItem({ /* ...minimal item, no conflictKey... */ } as never);

    await repo.updateKnowledgeItem(item.id, { conflictKey: '  Mixed CASE  Key  ' } as never);

    const stored = await repo.getKnowledgeItem(item.id);
    expect(stored?.conflictKey).toBe(normalizeConflictKey('  Mixed CASE  Key  '));
  });

  it('leaves identity alone when an update does not mention it', async () => {
    const item = await repo.createKnowledgeItem({ conflictKey: 'stable-key' } as never);

    await repo.updateKnowledgeItem(item.id, { title: 'New title' } as never);

    const stored = await repo.getKnowledgeItem(item.id);
    expect(stored?.conflictKey).toBe('stable-key');
  });
});
```

Fill the `createKnowledgeItem` / `updateKnowledgeItem` arguments from that file's existing tests — they already build valid items, and copying is more reliable than guessing the shape.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/conflicts.test.ts`
Expected: FAIL on the first test — the raw string is stored verbatim.

- [ ] **Step 3: Normalize on the update path**

In `src/store/repository.ts`, wherever the update builds its field set, apply the same normalization the create path uses:

```typescript
    // Normalized here as well as on create. A key written raw through update never collides
    // with the same identity written normalized through create, so exclusivity silently stops
    // holding for exactly the rows that most need it.
    fields.conflictKey = input.conflictKey ? normalizeConflictKey(input.conflictKey) : null;
```

Only touch `conflictKey` when the update actually mentions it — the second test guards that.

- [ ] **Step 4: Add the repair check**

In `src/store/conflicts.ts`:

```typescript
/** Whether a stored key is already in normal form. Deterministic, so it is safe to repair. */
export function isNormalizedConflictKey(value: string): boolean {
  return normalizeConflictKey(value) === value;
}
```

Then add an integrity check in `src/store/integrity.ts` that scans rows with a non-null `conflict_key`, reports any that are not normalized, and — when repairing — rewrites them. Repairing can expose duplicates that were previously invisible because the two spellings never matched; the check must settle those the same way a create-time collision is settled rather than leaving two active rows. Follow whatever `integrity.ts` already does for its other checks.

- [ ] **Step 5: Write the repair test**

```typescript
  it('repairs keys already stored raw, and settles the duplicates that exposes', async () => {
    // Two rows that are the same identity but were stored differently.
    await getClient().execute({
      sql: 'UPDATE knowledge_items SET conflict_key = ? WHERE id = ?',
      args: ['  Mixed CASE  Key  ', firstId],
    });
    await getClient().execute({
      sql: 'UPDATE knowledge_items SET conflict_key = ? WHERE id = ?',
      args: [normalizeConflictKey('  Mixed CASE  Key  '), secondId],
    });

    const report = await runIntegrityChecks({ repair: true } as never);

    const rows = (await getClient().execute(
      'SELECT conflict_key, status FROM knowledge_items WHERE conflict_key IS NOT NULL',
    )).rows;
    for (const row of rows) expect(isNormalizedConflictKey(String(row.conflict_key))).toBe(true);
    expect(rows.filter(row => row.status === 'active')).toHaveLength(1);
  });
```

Adjust `runIntegrityChecks` to the real entry point in `integrity.ts`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/store/conflicts.test.ts`
Expected: PASS, 3 new tests

- [ ] **Step 7: Full verification and commit**

```bash
npm test && npm run build && git diff --check
git add src/store/repository.ts src/store/conflicts.ts src/store/integrity.ts tests/store/conflicts.test.ts
git commit -m "fix(conflicts): normalize the conflict key on update, not only on create"
```

---

## Self-review notes

**PR coverage.** #10's unique work maps as: kind list → Task 1; planned-vs-crash rendering → Task 2; `recordDeliberateHandoff` → Task 3; `knowl_handoff` tool and inventory → Task 4; conflict-key fix → Task 5.

**Deliberately dropped from #10.** The `chore(fork): version 3.0.0-fork.1` commit is fork-sync bookkeeping for someone else's fork and means nothing in this repo. The `transcript-index.ts` / `transcript-search.ts` / `session-directory.ts` files in its diff are the stacked #7 and #8 commits, covered by the shipped transcript work and by the session-directory plan respectively.

**Two things to confirm rather than assume.** Task 3 says to read `recordPendingSessionHandoff` before reusing its write path, and to extract a shared helper rather than duplicate it. Task 5 says to confirm the update path really does skip normalization before fixing it — [repository.ts:179](../../../src/store/repository.ts#L179) calls `normalizeConflictKey` and the plan does not assume which path that line serves.

**Verified, not assumed:** the hardcoded kind allowlist at [session-handoff.ts:167](../../../src/store/session-handoff.ts#L167); `SESSION_HANDOFF_KINDS` absent from `main`; `KNOWL_MCP_TOOL_GROUPS` at 7 groups and `KNOWL_MCP_TOOL_NAMES` at 24, both asserted in `tests/core/knowl-guidance.test.ts:44-45`.
