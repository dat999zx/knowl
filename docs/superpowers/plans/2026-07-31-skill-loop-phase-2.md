# Skill Loop, Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the loop on procedural memory — notice a repeated non-obvious command while the session is live, ask the agent to save it as a runnable skill package, then surface saved skills back to future sessions.

**Architecture:** A pure qualifier decides whether a command deserves a nudge; the host lifecycle emits that nudge through the existing single-slot mid-turn channel under a fixed precedence; the session-start card gains a dedicated skills section so an agent knows what exists without being interrupted. Capture writes real `.knowl/skills/` packages, because those are the only shape `knowl_skill_run` can execute and `usage_count` can track.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), vitest, libSQL/Drizzle. Product suite (`npm test`).

## Global Constraints

From `docs/superpowers/specs/2026-07-31-extractor-rebuild-and-skill-loop-design.md`. Every task's requirements implicitly include this section.

- **Skill capture is deliberately model-dependent, and fact capture is not.** Phase 1's `finalizeMemorySession` must keep reporting `usedAi: false`. Nothing in this plan may change that or add a model call to the fact path — the agent is *asked* to save a skill, never transcribed by one.
- **Never auto-run a captured command.** A captured command is an unvetted shell string; one already-stored item embeds a hardcoded scratch path from a session that no longer exists. Capture may suggest and may save; it must never execute.
- **The mid-turn channel carries at most one message per tool event** (`src/store/host-lifecycle.ts`, "At most one card per tool event, never two"). Fixed precedence, from the spec: a skill message **never** displaces a change card; it **may** displace the continuation reminder; if capture and retrieval both qualify on one event, **capture wins — unless a saved skill already covers the command**, in which case retrieval speaks and capture stays silent. (Amended 2026-08-01 by review: the unconditional form asked the agent to save a skill that already existed, so the loop never closed.)
- **The qualifying trigger is repetition AND non-obviousness.** Three repeats alone is too eager — it fired twice during the capture experiment for ordinary test runs. The command must also contain a pipe, a redirect, or a filter. A bare `npm test` never qualifies.
  - **Amended 2026-08-01 by review:** this originally also listed a platform-specific binary (`npm.cmd`, `npx.cmd`) as non-obvious, which contradicted "a bare `npm test` never qualifies" on the one platform this project runs on. On Windows `npm.cmd test` **is** `npm test`; the suffix is a shell artifact, not encoded knowledge. `.cmd` is out of the pattern.
- **The nudge fires once, on the run that reaches the threshold.** Not on every run at or above it. Repeat counts come from successful runs only — a command failing three times is being debugged, not repeated as a workflow.
- **The session-start skills section must fit inside `DEFAULT_CONTEXT_MAX_CHARS`, not extend it.** That budget is already shared with recent context and, since v2.9.0, a drift warning. A skills section that pushes recent context out has made things worse.
- **No `PreToolUse` hook exists and this plan does not add one.** `PostToolUse` is the only mid-execution channel, so a command cannot be intercepted before it runs. Retrieval is necessarily after the fact.
- Product tests live in `tests/**/*.test.ts` under `npm test`. Benchmarks are excluded by design.
- `npx tsc --noEmit` is already red on ~17 pre-existing `src/` errors and exits 0 regardless. The binding gate is that `npx tsc --noEmit 2>&1 | grep "<your file>"` is empty.
- The project is ESM (`"type": "module"`); relative imports need explicit `.js` extensions.

## Context you need before Task 1

**Two systems share the word "skill" and only one is runnable.**

| Shape | Written by | Runnable | `source` |
| --- | --- | --- | --- |
| File-backed package | `createSkillPackage` → `indexSkillPackage` | yes | `.knowl/skills/<name>/` |
| Plain memory row | `knowl_store` with `category: 'skill'` | **no** | NULL or free text |

All 15 skill items in the real store are the second kind, so `knowl_skill_run` has never had anything to run and `usage_count` has never left zero. That is not a bug in the runner — `indexSkillPackage` (`src/skills/knowledge-index.ts:14-28`) already writes the `title` and `source` that `recordSkillRun` matches on. **The gap is what gets written.** This plan makes capture write packages.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/store/skill-capture.ts` | Pure: decide whether a command qualifies for a capture nudge, and render that nudge. |
| `src/store/skill-surface.ts` | Read active skill items for the session-start card and for retrieval matching. Pure given its input. |
| `src/store/host-lifecycle.ts` | Wire the capture nudge into the existing mid-turn precedence. |
| `src/core/format.ts` | Render the skills section inside the session-start card, within the existing cap. |
| `tests/store/skill-capture.test.ts` | Unit tests for the qualifier and renderer. |
| `tests/store/skill-surface.test.ts` | Unit tests for selection and budgeting. |
| `tests/store/skill-loop-integration.test.ts` | The nudge fires under the real precedence; the card carries skills. |

---

### Task 1: The capture qualifier

**Files:**
- Create: `src/store/skill-capture.ts`
- Test: `tests/store/skill-capture.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `qualifiesForSkillCapture(command: string, repeatCount: number): boolean`, `SKILL_CAPTURE_MIN_REPEATS = 3`, and `renderSkillCaptureNudge(command: string, repeatCount: number): string`. Task 3 imports all three.

Repetition alone is not the signal. The command must also carry something non-obvious — a pipe, a redirect, a filter flag, or a platform-specific binary — because that is where the project knowledge sits. `npm run typecheck:bench 2>&1 | grep "benchmarks/unassisted-capture"` qualifies because the filter encodes that the typecheck is already red; `npm test` does not.

- [ ] **Step 1: Write the failing test**

```ts
// tests/store/skill-capture.test.ts
import { describe, expect, it } from 'vitest';
import { qualifiesForSkillCapture, renderSkillCaptureNudge, SKILL_CAPTURE_MIN_REPEATS } from '../../src/store/skill-capture.js';

describe('qualifiesForSkillCapture', () => {
  it('rejects a bare command however often it repeats', () => {
    // The capture experiment fired on `npm test` twice in one session. Running the
    // suite is not a workflow worth remembering.
    expect(qualifiesForSkillCapture('npm test', 9)).toBe(false);
  });

  it('accepts a repeated command carrying a filter', () => {
    expect(qualifiesForSkillCapture('npm run typecheck:bench 2>&1 | grep "benchmarks/unassisted-capture"', 3)).toBe(true);
  });

  it('rejects a non-obvious command that has not repeated enough', () => {
    expect(qualifiesForSkillCapture('npm test 2>&1 | tail -20', SKILL_CAPTURE_MIN_REPEATS - 1)).toBe(false);
  });

  it('accepts a redirect as non-obvious', () => {
    // Amended 2026-08-01: `npm.cmd test` must NOT qualify. See Global Constraints.
    expect(qualifiesForSkillCapture('node build.js > out.log', 3)).toBe(true);
  });

  it('rejects an empty or trivially short command', () => {
    expect(qualifiesForSkillCapture('', 9)).toBe(false);
    expect(qualifiesForSkillCapture('ls', 9)).toBe(false);
  });

  it('does not treat a bare hyphen flag as non-obvious', () => {
    // Flags alone are ordinary. Only pipes, redirects, filters and platform
    // binaries indicate encoded knowledge.
    expect(qualifiesForSkillCapture('npm run build --silent', 9)).toBe(false);
  });
});

describe('renderSkillCaptureNudge', () => {
  it('names the command, the count, and the tool to call', () => {
    const nudge = renderSkillCaptureNudge('npm test 2>&1 | tail -20', 3);

    expect(nudge).toContain('npm test 2>&1 | tail -20');
    expect(nudge).toContain('3');
    expect(nudge).toContain('knowl_skill_create');
  });

  it('asks for the purpose, which is the thing only the agent knows', () => {
    expect(renderSkillCaptureNudge('cmd | grep x', 3)).toMatch(/what it is for|purpose/i);
  });

  it('never tells the agent to run the command', () => {
    // A captured command is an unvetted shell string; the nudge must suggest saving,
    // never executing.
    expect(renderSkillCaptureNudge('rm -rf build | tee log', 5)).not.toMatch(/\brun it\b|\bexecute\b/i);
  });

  it('truncates a very long command rather than flooding the slot', () => {
    const nudge = renderSkillCaptureNudge(`echo ${'x'.repeat(500)} | cat`, 3);

    expect(nudge.length).toBeLessThan(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/skill-capture.test.ts`
Expected: FAIL — cannot find module `../../src/store/skill-capture.js`.

- [ ] **Step 3: Write the qualifier**

```ts
// src/store/skill-capture.ts

/** A command must run at least this many times before it is worth suggesting. */
export const SKILL_CAPTURE_MIN_REPEATS = 3;

/** Below this length a command carries nothing worth remembering. */
const MIN_COMMAND_CHARS = 4;

/** How much of the command the nudge shows before truncating. */
const NUDGE_COMMAND_CHARS = 160;

/**
 * Marks of a command that encodes project knowledge rather than a plain invocation:
 * a pipe, a redirect, a filter flag, or a platform-specific binary. Repetition alone
 * is not enough -- running the test suite three times is Tuesday, not a workflow.
 */
const NON_OBVIOUS = /(\||>|2>&1|\bgrep\b|\btail\b|\bhead\b|\bsed\b|\bawk\b|\.cmd\b)/;

export function qualifiesForSkillCapture(command: string, repeatCount: number): boolean {
  const trimmed = command.trim();
  if (trimmed.length < MIN_COMMAND_CHARS) return false;
  if (repeatCount < SKILL_CAPTURE_MIN_REPEATS) return false;
  return NON_OBVIOUS.test(trimmed);
}

export function renderSkillCaptureNudge(command: string, repeatCount: number): string {
  const shown = command.trim().slice(0, NUDGE_COMMAND_CHARS);
  return [
    `KNOWL: you have run this ${repeatCount} times this session:`,
    `  ${shown}`,
    'If it is a reusable workflow, save it with knowl_skill_create — give it a name and say what it is for.',
    'Saving records it for later; it is never run for you.',
  ].join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/store/skill-capture.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Verify no new type errors**

Run: `npx tsc --noEmit 2>&1 | grep "skill-capture"`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/store/skill-capture.ts tests/store/skill-capture.test.ts
git commit -m "feat(skills): qualify a repeated non-obvious command for capture"
```

---

### Task 2: Reading skills for the surface

**Files:**
- Create: `src/store/skill-surface.ts`
- Test: `tests/store/skill-surface.test.ts`

**Interfaces:**
- Consumes: `KnowledgeItem` from `../core/types.js`.
- Produces: `selectSurfacedSkills(items: KnowledgeItem[], maxChars: number): SurfacedSkill[]` and `SurfacedSkill { name: string; purpose: string; runnable: boolean }`. Tasks 4 and 5 import both.

Runnable packages come first: a plain memory row cannot be executed by `knowl_skill_run`, so pointing an agent at one wastes the slot. A row is runnable when its `source` begins with `.knowl/skills/`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/store/skill-surface.test.ts
import { describe, expect, it } from 'vitest';
import { selectSurfacedSkills } from '../../src/store/skill-surface.js';
import type { KnowledgeItem } from '../../src/core/types.js';

const item = (over: Partial<KnowledgeItem>): KnowledgeItem => ({
  id: 'i1', category: 'skill', status: 'active', title: 'a-skill',
  content: 'File-backed learned skill package at `.knowl/skills/a-skill/`.\nPurpose: does a thing.',
  confidence: 1, freshness: 'fresh', version: 1,
  createdAt: '2026-07-31T00:00:00.000Z', updatedAt: '2026-07-31T00:00:00.000Z',
  source: '.knowl/skills/a-skill/', ...over,
} as KnowledgeItem);

describe('selectSurfacedSkills', () => {
  it('extracts the purpose line from a package item', () => {
    const [skill] = selectSurfacedSkills([item({})], 1_000);

    expect(skill).toMatchObject({ name: 'a-skill', purpose: 'does a thing.', runnable: true });
  });

  it('marks a plain memory row as not runnable', () => {
    const rows = selectSurfacedSkills([item({ title: 'plain', source: null, content: 'Ran 3 times.' })], 1_000);

    expect(rows[0].runnable).toBe(false);
  });

  it('puts runnable packages before plain rows', () => {
    const skills = selectSurfacedSkills([
      item({ id: 'i1', title: 'plain', source: null, content: 'no purpose here' }),
      item({ id: 'i2', title: 'runnable' }),
    ], 1_000);

    expect(skills.map((s) => s.name)).toEqual(['runnable', 'plain']);
  });

  it('drops skills that do not fit the budget rather than truncating mid-entry', () => {
    const many = Array.from({ length: 40 }, (_, index) => item({ id: `i${index}`, title: `skill-${index}` }));

    const skills = selectSurfacedSkills(many, 200);
    const rendered = skills.map((s) => `${s.name}: ${s.purpose}`).join('\n');

    expect(rendered.length).toBeLessThanOrEqual(200);
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.length).toBeLessThan(40);
  });

  it('ignores non-skill and non-active items', () => {
    expect(selectSurfacedSkills([
      item({ category: 'fact' }),
      item({ status: 'superseded' }),
    ], 1_000)).toEqual([]);
  });

  it('falls back to the content head when no Purpose line exists', () => {
    const [skill] = selectSurfacedSkills([item({ content: 'Some description with no purpose label.' })], 1_000);

    expect(skill.purpose).toContain('Some description');
  });

  it('returns an empty array for no input rather than throwing', () => {
    expect(selectSurfacedSkills([], 1_000)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/skill-surface.test.ts`
Expected: FAIL — cannot find module `../../src/store/skill-surface.js`.

- [ ] **Step 3: Write the selector**

```ts
// src/store/skill-surface.ts
import type { KnowledgeItem } from '../core/types.js';

export interface SurfacedSkill {
  name: string;
  purpose: string;
  /** True when `knowl_skill_run` can actually execute it -- a file-backed package. */
  runnable: boolean;
}

/** How much of a purpose line is worth showing. */
const MAX_PURPOSE_CHARS = 90;

/** `indexSkillPackage` writes `Purpose: <one sentence>` as the second line. */
function purposeOf(content: string): string {
  const line = content.split('\n').map((row) => row.trim()).find((row) => /^purpose:/i.test(row));
  const text = line ? line.replace(/^purpose:\s*/i, '') : content.split('\n')[0] ?? '';
  return text.slice(0, MAX_PURPOSE_CHARS).trim();
}

export function selectSurfacedSkills(items: KnowledgeItem[], maxChars: number): SurfacedSkill[] {
  const eligible = items
    .filter((candidate) => candidate.category === 'skill' && candidate.status === 'active')
    .map((candidate) => ({
      name: candidate.title,
      purpose: purposeOf(candidate.content ?? ''),
      // Only a file-backed package is reachable by knowl_skill_run; a plain row is not,
      // so pointing an agent at one wastes the reader's attention.
      runnable: typeof candidate.source === 'string' && candidate.source.startsWith('.knowl/skills/'),
    }));

  // Runnable first, then original order within each group.
  const ordered = [...eligible.filter((s) => s.runnable), ...eligible.filter((s) => !s.runnable)];

  const kept: SurfacedSkill[] = [];
  let used = 0;
  for (const skill of ordered) {
    const cost = `${skill.name}: ${skill.purpose}`.length + 1;
    if (used + cost > maxChars) break;
    kept.push(skill);
    used += cost;
  }
  return kept;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/store/skill-surface.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Verify no new type errors**

Run: `npx tsc --noEmit 2>&1 | grep "skill-surface"`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/store/skill-surface.ts tests/store/skill-surface.test.ts
git commit -m "feat(skills): select and budget skills for the session surface"
```

---

### Task 3: Wire the capture nudge into the mid-turn precedence

**Files:**
- Modify: `src/store/host-lifecycle.ts` (the `session-event` branch that currently chooses between the change card and the continuation reminder)
- Test: `tests/store/skill-loop-integration.test.ts` (create)

**Interfaces:**
- Consumes: `qualifiesForSkillCapture`, `renderSkillCaptureNudge`, `SKILL_CAPTURE_MIN_REPEATS` from `./skill-capture.js` (Task 1).
- Produces: no new exports. Behaviour: on a `session-event` whose payload carries a qualifying repeated command, `hostOutput` is the capture nudge.

**The precedence is fixed by the spec and is the point of this task:**

1. A change card **always** wins — it carries knowledge the agent does not have.
2. Otherwise, a qualifying capture nudge wins over the continuation reminder — a specific suggestion beats a generic one.
3. Otherwise, the continuation reminder behaves exactly as today.

The repeat count comes from the session's own events: count prior `command` events in this session whose trimmed command matches, case-insensitively. Those rows already exist — `appendMemorySessionEvent` writes one per command.

- [ ] **Step 1: Write the failing test**

```ts
// tests/store/skill-loop-integration.test.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb, initDb } from '../../src/store/database.js';
import { handleHostLifecycleEvent } from '../../src/store/host-lifecycle.js';
import * as repo from '../../src/store/repository.js';

const TEST_ROOT = path.resolve('./.knowl-skill-loop-test');
let projectId: string;

const toolEvent = (sessionId: string, command: string) => handleHostLifecycleEvent(projectId, {
  host: 'claude', event: 'session-event', projectRoot: TEST_ROOT,
  externalSessionId: sessionId, externalTurnId: `${sessionId}-turn`,
  payload: { command, exitCode: 0 }, knowlTool: false,
} as any);

describe('skill capture nudge', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
    projectId = (await repo.createProject(TEST_ROOT, 'skill-loop')).id;
  });
  beforeEach(async () => {
    const db = getDb() as any;
    await db.run(sql`DELETE FROM memory_session_events`);
    await db.run(sql`DELETE FROM memory_sessions`);
    await db.run(sql`DELETE FROM host_session_bindings`);
  });
  afterAll(async () => { await closeDb(); await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('nudges once a qualifying command has repeated enough', async () => {
    const command = 'npm run typecheck 2>&1 | grep "src/store"';
    await handleHostLifecycleEvent(projectId, {
      host: 'claude', event: 'session-start', projectRoot: TEST_ROOT,
      externalSessionId: 's1', externalTurnId: 's1-turn', payload: {},
    } as any);

    let last;
    for (let index = 0; index < 3; index++) last = await toolEvent('s1', command);

    const text = JSON.stringify(last?.hostOutput ?? {});
    expect(text).toContain('knowl_skill_create');
  });

  it('does not nudge for a bare command however often it repeats', async () => {
    await handleHostLifecycleEvent(projectId, {
      host: 'claude', event: 'session-start', projectRoot: TEST_ROOT,
      externalSessionId: 's2', externalTurnId: 's2-turn', payload: {},
    } as any);

    let last;
    for (let index = 0; index < 6; index++) last = await toolEvent('s2', 'npm test');

    expect(JSON.stringify(last?.hostOutput ?? {})).not.toContain('knowl_skill_create');
  });

  it('never suggests running the captured command', async () => {
    const command = 'rm -rf dist | tee clean.log';
    await handleHostLifecycleEvent(projectId, {
      host: 'claude', event: 'session-start', projectRoot: TEST_ROOT,
      externalSessionId: 's3', externalTurnId: 's3-turn', payload: {},
    } as any);

    let last;
    for (let index = 0; index < 3; index++) last = await toolEvent('s3', command);

    expect(JSON.stringify(last?.hostOutput ?? {})).not.toMatch(/run it|execute/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/skill-loop-integration.test.ts`
Expected: FAIL — the first test finds no `knowl_skill_create` in the output, because nothing emits the nudge yet.

- [ ] **Step 3: Add the repeat count helper**

Add to `src/store/skill-capture.ts`:

```ts
import { getClient } from './database.js';

/**
 * How many times this exact command has already run in this session, counting the
 * current one. Case-insensitive on the trimmed text, matching how a human would
 * judge "the same command".
 */
export async function countCommandRepeats(sessionId: string, command: string): Promise<number> {
  const key = command.trim().toLowerCase();
  if (!key) return 0;
  const rows = (await getClient().execute({
    sql: `SELECT payload FROM memory_session_events WHERE session_id = ? AND type = 'command'`,
    args: [sessionId],
  })).rows;
  let count = 0;
  for (const row of rows) {
    try {
      const payload = JSON.parse(String(row.payload));
      if (typeof payload.command === 'string' && payload.command.trim().toLowerCase() === key) count++;
    } catch {
      // A malformed payload is not a match; never let one row abort the count.
    }
  }
  return count;
}
```

- [ ] **Step 4: Wire it into the precedence**

In `src/store/host-lifecycle.ts`, import at the top:

```ts
import { countCommandRepeats, qualifiesForSkillCapture, renderSkillCaptureNudge } from './skill-capture.js';
```

Then inside the `session-event` branch, replace the `else if (profile.midTurnContext('') !== undefined) {` block's opening so the capture nudge is tried before the reminder:

```ts
        } else if (profile.midTurnContext('') !== undefined) {
          // A change card always wins the single mid-turn slot; below it, a specific
          // capture suggestion beats the generic continuation reminder.
          const command = typeof input.payload.command === 'string' ? input.payload.command : '';
          const repeats = command && started?.session?.id
            ? await countCommandRepeats(started.session.id, command)
            : 0;

          if (command && qualifiesForSkillCapture(command, repeats)) {
            hostOutput = profile.midTurnContext(renderSkillCaptureNudge(command, repeats));
          } else if (input.knowlTool) {
            await resetHostSuccessfulToolCount(key);
          } else {
            const drift = await incrementHostSuccessfulToolCount(key);
            if (drift > 0 && drift % KNOWL_REMINDER_DRIFT === 0) {
              hostOutput = profile.midTurnContext(KNOWL_CLAUDE_CONTINUATION_REMINDER);
            }
          }
        }
```

`started` **is** in scope: the branch opens with `const started = await startBoundSession(projectId, input, 'turn');` and the line above your edit already calls `captureMemorySessionEvent(started.session.id, type, input.payload)`. Use `started.session.id` directly.

That ordering also means the current command's event row is **already written** before your count runs, so `countCommandRepeats` includes the current invocation. The third run of a command therefore reports 3, matching `SKILL_CAPTURE_MIN_REPEATS`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/store/skill-loop-integration.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Run the neighbouring lifecycle suites**

Run: `npx vitest run tests/store/host-lifecycle.test.ts tests/store/federated-change-notification.test.ts tests/mcp/dual-channel-notification.test.ts`
Expected: PASS. These assert on the mid-turn slot's existing behaviour. **If one fails, report the exact assertion and why before changing it** — a change-card test failing would mean the precedence is wrong, which is a real defect, not a re-baseline.

- [ ] **Step 7: Verify no new type errors**

Run: `npx tsc --noEmit 2>&1 | grep -E "host-lifecycle|skill-capture"`
Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add src/store/skill-capture.ts src/store/host-lifecycle.ts tests/store/skill-loop-integration.test.ts
git commit -m "feat(skills): nudge for capture mid-session, below the change card"
```

---

### Task 4: Skills in the session-start card

**Files:**
- Modify: `src/core/format.ts` — `formatRecentContextToMarkdown`
- Modify: `tests/store/skill-loop-integration.test.ts` — add the card assertions

**Interfaces:**
- Consumes: `selectSurfacedSkills`, `SurfacedSkill` from `../store/skill-surface.js` (Task 2).
- Produces: `formatRecentContextToMarkdown` accepts an optional `skills: KnowledgeItem[]` on its context argument and renders a `## Available skills` section.

`getRecentContext` returns the 3 most recent active items with no category filter, so a skill appears in the card today only by accident of recency. A skill created last month never shows. This task gives skills their own section.

**The budget is shared, not extended.** Reserve a slice of `maxChars` for skills and let `selectSurfacedSkills` drop what does not fit; the recent-context body then formats into what remains.

- [ ] **Step 1: Write the failing test**

Append to `tests/store/skill-loop-integration.test.ts`:

```ts
describe('skills in the session-start card', () => {
  it('lists a runnable skill with its purpose', async () => {
    const { formatRecentContextToMarkdown } = await import('../../src/core/format.js');
    const skill = {
      id: 's1', category: 'skill', status: 'active', title: 'verify-bench',
      content: 'File-backed learned skill package at `.knowl/skills/verify-bench/`.\nPurpose: run the benchmark suite and filter its output.',
      source: '.knowl/skills/verify-bench/', confidence: 1, freshness: 'fresh', version: 1,
      createdAt: '2026-07-31T00:00:00.000Z', updatedAt: '2026-07-31T00:00:00.000Z',
    } as any;

    const md = formatRecentContextToMarkdown({ items: [], commits: [], skills: [skill] }, { maxChars: 4_000 });

    expect(md).toContain('verify-bench');
    expect(md).toContain('run the benchmark suite');
  });

  it('omits the section entirely when there are no skills', async () => {
    const { formatRecentContextToMarkdown } = await import('../../src/core/format.js');

    expect(formatRecentContextToMarkdown({ items: [], commits: [] }, { maxChars: 4_000 }))
      .not.toMatch(/available skills/i);
  });

  it('stays inside the character cap it was given', async () => {
    const { formatRecentContextToMarkdown } = await import('../../src/core/format.js');
    const skills = Array.from({ length: 60 }, (_, index) => ({
      id: `s${index}`, category: 'skill', status: 'active', title: `skill-${index}`,
      content: `Purpose: ${'p'.repeat(80)}`, source: `.knowl/skills/skill-${index}/`,
      confidence: 1, freshness: 'fresh', version: 1,
      createdAt: '2026-07-31T00:00:00.000Z', updatedAt: '2026-07-31T00:00:00.000Z',
    })) as any[];

    const md = formatRecentContextToMarkdown({ items: [], commits: [], skills }, { maxChars: 800 });

    expect(md.length).toBeLessThanOrEqual(800);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/skill-loop-integration.test.ts`
Expected: FAIL — the card contains no `verify-bench`, because nothing renders skills.

- [ ] **Step 3: Render the section**

In `src/core/format.ts`, extend the context parameter of `formatRecentContextToMarkdown` with `skills?: KnowledgeItem[]`, import `selectSurfacedSkills` from `../store/skill-surface.js`, and render the section **before** the recent-context body so it survives truncation:

```ts
  // A quarter of the budget at most, and only what fits. An agent that already knows a
  // skill exists needs no mid-turn interrupt, which is why this section earns its space.
  const skillBudget = Math.floor(maxChars * 0.25);
  const skills = selectSurfacedSkills(context.skills ?? [], skillBudget);
  if (skills.length > 0) {
    md += '## Available skills\n\n';
    for (const skill of skills) {
      md += `- **${skill.name}**${skill.runnable ? '' : ' (not runnable)'} — ${skill.purpose}\n`;
    }
    md += '\n';
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/store/skill-loop-integration.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run the formatter's own suite**

Run: `npx vitest run tests/core/ tests/store/context-bootstrap.test.ts`
Expected: PASS. **If a card-shape assertion fails, report it before changing it** — the card is asserted on in several places and a silent reshape is a regression.

- [ ] **Step 6: Verify no new type errors**

Run: `npx tsc --noEmit 2>&1 | grep -E "format.ts|skill-surface"`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/core/format.ts tests/store/skill-loop-integration.test.ts
git commit -m "feat(skills): surface available skills in the session-start card"
```

---

### Task 5: Feed skills into the card, end to end

**Files:**
- Modify: `src/store/context-bootstrap.ts` — `bootstrapAgentSession`
- Modify: `tests/store/skill-loop-integration.test.ts`

**Interfaces:**
- Consumes: `formatRecentContextToMarkdown` with its `skills` field (Task 4).
- Produces: a real session start carries the skills section.

Task 4 renders skills when given them; nothing gives them yet. `bootstrapAgentSession` calls `getRecentContext`, which returns only the 3 most recent items of any category. This task queries active skill items separately and passes them through.

- [ ] **Step 1: Write the failing test**

Append to `tests/store/skill-loop-integration.test.ts`:

```ts
describe('session start carries skills', () => {
  it('includes a stored skill in the bootstrap context', async () => {
    await repo.createKnowledgeItem(projectId, {
      category: 'skill',
      title: 'verify-release',
      content: 'File-backed learned skill package at `.knowl/skills/verify-release/`.\nPurpose: check publish readiness before tagging.',
      source: '.knowl/skills/verify-release/',
    });

    const result = await handleHostLifecycleEvent(projectId, {
      host: 'claude', event: 'session-start', projectRoot: TEST_ROOT,
      externalSessionId: 's-skills', externalTurnId: 's-skills-turn', payload: {},
    } as any);

    expect(result.context ?? '').toContain('verify-release');
    expect(result.context ?? '').toContain('check publish readiness');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/skill-loop-integration.test.ts -t "includes a stored skill"`
Expected: FAIL — the context has no `verify-release`, because bootstrap passes no skills.

- [ ] **Step 3: Query and pass the skills**

In `src/store/context-bootstrap.ts`, inside `bootstrapAgentSession` where `recent` is built, fetch active skill items and hand them to the formatter:

```ts
  const recent = await getRecentContext(input.projectId);
  // Skills are surfaced regardless of recency: getRecentContext returns only the three
  // most recent items of any category, so a skill created last month would never appear.
  const skills = (await repo.listKnowledgeItems())
    .filter((item) => item.category === 'skill' && item.status === 'active');
  const fallback = formatRecentContextToMarkdown({ ...recent, skills }, {
    maxChars: Number.MAX_SAFE_INTEGER,
    workspace: await workspaceContext(),
  });
```

`context-bootstrap.ts` imports named functions rather than a namespace — its current imports are `formatRecentContextToMarkdown`, `DEFAULT_CONTEXT_MAX_CHARS`, `heartbeatMemorySession`, `startMemorySession`, and `getRecentContext`. Add a named import in the same style:

```ts
import { listKnowledgeItems } from './repository.js';
```

and call `listKnowledgeItems()` rather than `repo.listKnowledgeItems()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/store/skill-loop-integration.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Run the full product suite**

Run: `npm test`
Expected: PASS, 0 failures. Report file and test counts. **Run the whole suite, not a subset** — a previous phase shipped a regression because only three suites were checked and the broken test lived elsewhere.

- [ ] **Step 6: Verify no new type errors**

Run: `npx tsc --noEmit 2>&1 | grep "context-bootstrap"`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/store/context-bootstrap.ts tests/store/skill-loop-integration.test.ts
git commit -m "feat(skills): pass active skills into the session bootstrap context"
```

---

### Task 6: The after-the-fact retrieval nudge

**Files:**
- Modify: `src/store/skill-surface.ts`
- Modify: `src/store/host-lifecycle.ts`
- Modify: `tests/store/skill-surface.test.ts`, `tests/store/skill-loop-integration.test.ts`

**Interfaces:**
- Consumes: `SurfacedSkill` (Task 2); the precedence branch from Task 3.
- Produces: `matchSkillForCommand(command: string, skills: SurfacedSkill[]): SurfacedSkill | null` and `renderSkillUseNudge(skill: SurfacedSkill): string`.

**Read this before starting.** Knowl has no `PreToolUse` hook, so a command cannot be intercepted before it runs — this nudge necessarily arrives *after*. It earns its place when the saved skill covers a **sequence**: catching step one of a five-step procedure still saves four steps. It is close to worthless for a one-off command the agent has already completed, which is why the match bar is high.

**Precedence, fixed by the spec:** a change card always wins; if capture and retrieval both qualify on one event, **capture wins**; retrieval may displace only the generic continuation reminder.

**Match on the skill name appearing in the command, not on fuzzy similarity.** A skill named `verify-bench` matches `npm run verify-bench --watch`. Similarity matching would be the wrong tool here — the project's own measurement found the local embedder cannot separate same-fact from same-topic at 20% error, and a false suggestion costs the single slot for that event.

- [ ] **Step 1: Write the failing test**

Append to `tests/store/skill-surface.test.ts`:

```ts
import { matchSkillForCommand, renderSkillUseNudge } from '../../src/store/skill-surface.js';

describe('matchSkillForCommand', () => {
  const skill = { name: 'verify-bench', purpose: 'run the benchmark suite and filter its output', runnable: true };

  it('matches when the skill name appears in the command', () => {
    expect(matchSkillForCommand('npm run verify-bench --watch', [skill])).toEqual(skill);
  });

  it('does not match an unrelated command', () => {
    expect(matchSkillForCommand('npm test', [skill])).toBeNull();
  });

  it('never suggests a skill that cannot be run', () => {
    // Pointing an agent at a plain memory row wastes the one mid-turn slot for that
    // event: knowl_skill_run cannot execute it.
    expect(matchSkillForCommand('npm run verify-bench', [{ ...skill, runnable: false }])).toBeNull();
  });

  it('ignores a name too short to be a meaningful match', () => {
    expect(matchSkillForCommand('go build ./...', [{ name: 'go', purpose: 'x', runnable: true }])).toBeNull();
  });

  it('returns null for no skills rather than throwing', () => {
    expect(matchSkillForCommand('anything', [])).toBeNull();
  });
});

describe('renderSkillUseNudge', () => {
  it('names the skill and how to run it', () => {
    const nudge = renderSkillUseNudge({ name: 'verify-bench', purpose: 'run the suite', runnable: true });

    expect(nudge).toContain('verify-bench');
    expect(nudge).toContain('knowl_skill_run');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/skill-surface.test.ts`
Expected: FAIL — `matchSkillForCommand` is not exported.

- [ ] **Step 3: Implement the matcher**

Append to `src/store/skill-surface.ts`:

```ts
/** Below this, a name is too generic to match on -- `go`, `cd`, `rm`. */
const MIN_MATCHABLE_NAME_CHARS = 4;

export function matchSkillForCommand(command: string, skills: SurfacedSkill[]): SurfacedSkill | null {
  const haystack = command.toLowerCase();
  return skills.find((skill) =>
    skill.runnable
    && skill.name.length >= MIN_MATCHABLE_NAME_CHARS
    && haystack.includes(skill.name.toLowerCase())) ?? null;
}

export function renderSkillUseNudge(skill: SurfacedSkill): string {
  return [
    `KNOWL: a saved skill covers this — **${skill.name}**: ${skill.purpose}`,
    `Run it with knowl_skill_run if it fits what you are doing.`,
  ].join('\n');
}
```

- [ ] **Step 4: Wire it below capture in the precedence**

In `src/store/host-lifecycle.ts`, extend the branch from Task 3 so retrieval sits between capture and the reminder:

```ts
          if (command && qualifiesForSkillCapture(command, repeats)) {
            hostOutput = profile.midTurnContext(renderSkillCaptureNudge(command, repeats));
          } else if (command && (() => {
            // Retrieval sits below capture: recording a workflow the agent is actively
            // repeating is worth more than pointing at one it has already started.
            const active = selectSurfacedSkills(await listKnowledgeItems(), 4_000);
            const match = matchSkillForCommand(command, active);
            if (match) hostOutput = profile.midTurnContext(renderSkillUseNudge(match));
            return Boolean(match);
          })()) {
            // hostOutput already set above.
          } else if (input.knowlTool) {
```

**That inline arrow cannot be `await`ed inside a condition.** Restructure it as a plain sequential block instead — compute the match first, then branch:

```ts
          let skillMatch: SurfacedSkill | null = null;
          if (command && !qualifiesForSkillCapture(command, repeats)) {
            skillMatch = matchSkillForCommand(command, selectSurfacedSkills(await listKnowledgeItems(), 4_000));
          }

          if (command && qualifiesForSkillCapture(command, repeats)) {
            hostOutput = profile.midTurnContext(renderSkillCaptureNudge(command, repeats));
          } else if (skillMatch) {
            hostOutput = profile.midTurnContext(renderSkillUseNudge(skillMatch));
          } else if (input.knowlTool) {
            await resetHostSuccessfulToolCount(key);
          } else {
            const drift = await incrementHostSuccessfulToolCount(key);
            if (drift > 0 && drift % KNOWL_REMINDER_DRIFT === 0) {
              hostOutput = profile.midTurnContext(KNOWL_CLAUDE_CONTINUATION_REMINDER);
            }
          }
```

Use the second form. Add `listKnowledgeItems` and the three skill-surface imports at the top of the file.

- [ ] **Step 5: Add the precedence test**

Append to `tests/store/skill-loop-integration.test.ts`:

```ts
  it('prefers the capture nudge over the retrieval nudge when both qualify', async () => {
    await repo.createKnowledgeItem(projectId, {
      category: 'skill', title: 'typecheck-filtered',
      content: 'Purpose: run typecheck and filter it.', source: '.knowl/skills/typecheck-filtered/',
    });
    await handleHostLifecycleEvent(projectId, {
      host: 'claude', event: 'session-start', projectRoot: TEST_ROOT,
      externalSessionId: 's-prec', externalTurnId: 's-prec-turn', payload: {},
    } as any);

    // A command that both matches the saved skill AND qualifies for capture.
    const command = 'npm run typecheck-filtered 2>&1 | grep src';
    let last;
    for (let index = 0; index < 3; index++) last = await toolEvent('s-prec', command);

    const text = JSON.stringify(last?.hostOutput ?? {});
    expect(text).toContain('knowl_skill_create');
    expect(text).not.toContain('knowl_skill_run');
  });
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/store/skill-surface.test.ts tests/store/skill-loop-integration.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full product suite**

Run: `npm test`
Expected: PASS, 0 failures. Report file and test counts.

- [ ] **Step 8: Verify no new type errors**

Run: `npx tsc --noEmit 2>&1 | grep -E "skill-surface|host-lifecycle"`
Expected: no output.

- [ ] **Step 9: Commit**

```bash
git add src/store/skill-surface.ts src/store/host-lifecycle.ts tests/store/skill-surface.test.ts tests/store/skill-loop-integration.test.ts
git commit -m "feat(skills): suggest a saved skill after a matching command, below capture"
```

---

## Out of Scope for This Plan

- **Adding `PreToolUse`.** Recorded in the spec as the escape hatch. It fires on every tool call and would put Knowl on the critical path of every agent action.
  - **Contradiction, found by review 2026-08-01, and its resolution.** That reasoning rejects `PreToolUse` for a cost this plan then pays anyway: Tasks 3 and 6 put two unbounded queries on `PostToolUse`, which fires exactly as often. `countCommandRepeats` read and `JSON.parse`d every command row of the session, and the skill lookup read every row of `knowledge_items` (424 rows, ~8 MB) to find at most one substring match. **Resolved by making the per-tool-call work bounded, not by dropping the hook:** the repeat count is now one indexed scalar `COUNT(*)`, and the skill lookup is `listActiveSkillItems`, scoped by `idx_ki_cat_status`. The out-of-scope decision stands, but its stated reason now applies honestly — being on the critical path is acceptable only for bounded work, and that is the bar any future addition here must clear too.
- **Retiring the four existing `Repeated workflow:` items and the one `Verified command:` item.** They are no longer written; removing the stored ones is a data change and the spec leaves it as an explicit decision.
- **Migrating plain skill rows into packages.** The nine hand-written rows are useful as memory even though they are not runnable; `selectSurfacedSkills` marks them `(not runnable)` rather than hiding or converting them.
