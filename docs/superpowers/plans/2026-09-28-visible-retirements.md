# Visible retirements (R1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `knowl conflicts` / `knowl_conflicts` list recently retired verified facts and same-subject pairs with a verified side, so a silent swap and a guard-kept pair are both visible to someone other than the writer.

**Architecture:** Extend the one existing all-items scan in `src/store/contradiction-scan.ts` with two more lists computed in memory, then add them to the CLI JSON and the MCP handler output, and update both descriptions and `docs/reference.md`.

**Tech Stack:** TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-09-28-visible-retirements.md`

## Global Constraints

- Worktree `D:/coding/knowl/.claude/worktrees/issue-165-r1`, branch `feat/issue-165-visible-retirements`, based on `integrate/issue-165` (R2 + R5 merged). Do not rebase onto `origin/main`.
- Read-only: nothing is blocked or written. No new DB query: filter the `listKnowledgeItems()` result already loaded.
- "Verified" = `isVerifiedProvenance` from `src/store/knowledge-writer.ts` (already exported by R2).
- `RETIRED_WINDOW_DAYS = 14`. Retirement time = the superseded item's `updatedAt`.
- Keep reversal candidates out of this surface (see the module docblock).
- Docblocks explain WHY. Lowercase conventional commits.

---

### Task 0: Baseline

- [ ] **Step 1:**

```bash
npm.cmd ci
npm.cmd run build
npx vitest run tests/store/contradiction-visibility.test.ts tests/mcp/act-as-repo.test.ts tests/mcp/tool-annotations.test.ts
```

Expected: pass. If not, stop and report.

---

### Task 1: `scanContradictions` gains `retired` and `sameSubject`

**Files:**
- Modify: `src/store/contradiction-scan.ts`
- Modify: `tests/store/contradiction-visibility.test.ts` (the one key-set pin, see Step 1)
- Create: `tests/store/visible-retirements.test.ts`

**Interfaces (produced, used by Task 2):**

```ts
export const RETIRED_WINDOW_DAYS = 14;
export type VerifiedParty = ContradictionParty & { provenance: KnowledgeProvenance | null };
export type RetiredVerified = { kind: 'retired'; retired: VerifiedParty; replacedBy: VerifiedParty | null; retiredAt: string };
export type SameSubjectPair = { kind: 'sameSubject'; a: VerifiedParty; b: VerifiedParty };
export type DetectedContradictions = { polarity: PolarityContradiction[]; retired: RetiredVerified[]; sameSubject: SameSubjectPair[] };
export async function scanContradictions(options?: { now?: Date }): Promise<DetectedContradictions>;
```

- [ ] **Step 1: Write the failing tests**

In `tests/store/contradiction-visibility.test.ts`, the test "knowl conflicts lists polarity pairs and NOT reversal candidates" changes one line, because the spec adds keys on purpose; its `reversalCandidates` assertion stays:

```ts
    expect(Object.keys(detected)).toEqual(['polarity', 'retired', 'sameSubject']);
```

Create `tests/store/visible-retirements.test.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { promoteSessionCandidates } from '../../src/store/candidate-promotion.js';
import { startMemorySession } from '../../src/store/session-repository.js';
import { RETIRED_WINDOW_DAYS, scanContradictions } from '../../src/store/contradiction-scan.js';

let n = 0;
let projectId = '';
const roots: string[] = [];

// A fresh store per test: the lists are whole-store scans, so a shared store would make every
// assertion depend on test order.
beforeEach(async () => {
  await closeDb();
  const root = path.resolve(`./.knowl-visible-retirements-test-${n++}`);
  roots.push(root);
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await initDb(root);
  projectId = (await repo.createProject(root, 'visible-retirements')).id;
});
afterAll(async () => {
  await closeDb();
  for (const root of roots) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

const seed = (provenance: 'observed' | null, title = 'Access token lifetime', value = '15 minutes') =>
  storeKnowledgeItemDeduped(projectId, {
    category: 'constraint', title, content: `Access tokens must expire after ${value}.`, provenance,
  });

describe('retired verified facts (#165 R1)', () => {
  it('the report A1 shape: a same-title write retiring an observed fact is listed', async () => {
    const held = await seed('observed');
    const swap = await storeKnowledgeItemDeduped(projectId, {
      category: 'constraint', title: 'Access token lifetime', content: 'Access tokens must expire after 30 days.',
    });
    expect(swap.superseded?.id).toBe(held.item.id);

    const { retired } = await scanContradictions();
    expect(retired).toHaveLength(1);
    expect(retired[0].retired.id).toBe(held.item.id);
    expect(retired[0].retired.provenance).toBe('observed');
    expect(retired[0].replacedBy?.id).toBe(swap.item.id);
  });

  it('an unverified retirement is not listed', async () => {
    await seed(null);
    await storeKnowledgeItemDeduped(projectId, {
      category: 'constraint', title: 'Access token lifetime', content: 'Access tokens must expire after 30 days.',
    });
    expect((await scanContradictions()).retired).toEqual([]);
  });

  it('a verified retirement older than the window is not listed', async () => {
    await seed('observed');
    await storeKnowledgeItemDeduped(projectId, {
      category: 'constraint', title: 'Access token lifetime', content: 'Access tokens must expire after 30 days.',
    });
    const later = new Date(Date.now() + (RETIRED_WINDOW_DAYS + 1) * 86_400_000);
    expect((await scanContradictions({ now: later })).retired).toEqual([]);
  });
});

describe('same-subject pairs with a verified side (#165 R1)', () => {
  it('an R2 clamp (capture kept beside an observed fact) is listed once', async () => {
    const held = await seed('observed');
    const session = await startMemorySession({ title: 'Poisoned session' });
    await promoteSessionCandidates(projectId, session.id, [{
      candidateType: 'decision', sessionId: session.id, category: 'constraint',
      title: 'Access token lifetime', content: 'Access tokens must expire after 30 days.',
      confidence: 0.9, evidence: [],
    }]);

    const { sameSubject } = await scanContradictions();
    expect(sameSubject).toHaveLength(1);
    expect([sameSubject[0].a.id, sameSubject[0].b.id]).toContain(held.item.id);
  });

  it('two unverified same-subject items are not listed', async () => {
    await repo.createKnowledgeItem(projectId, { category: 'state', title: 'Work Loop checkpoint', content: 'step 1' });
    await repo.createKnowledgeItem(projectId, { category: 'state', title: 'Work Loop checkpoint', content: 'step 2' });
    expect((await scanContradictions()).sameSubject).toEqual([]);
  });

  it('a polarity pair is listed under polarity only, not twice', async () => {
    await repo.createKnowledgeItem(projectId, {
      category: 'decision', title: 'Push gate blocks default branch', content: 'Refused.', provenance: 'observed',
    });
    await repo.createKnowledgeItem(projectId, {
      category: 'decision', title: 'Push gate no longer blocks default branch', content: 'Removed.', provenance: 'observed',
    });
    const detected = await scanContradictions();
    expect(detected.polarity).toHaveLength(1);
    expect(detected.sameSubject).toEqual([]);
  });

  it('pairs across categories are not listed', async () => {
    await repo.createKnowledgeItem(projectId, { category: 'fact', title: 'Cache TTL policy', content: '5 minutes', provenance: 'observed' });
    await repo.createKnowledgeItem(projectId, { category: 'decision', title: 'Cache TTL policy', content: '10 minutes', provenance: 'observed' });
    expect((await scanContradictions()).sameSubject).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, confirm they fail**

Run: `npx vitest run tests/store/visible-retirements.test.ts tests/store/contradiction-visibility.test.ts`
Expected: FAIL (`RETIRED_WINDOW_DAYS` not exported; key set `['polarity']`).

- [ ] **Step 3: Implement.** In `src/store/contradiction-scan.ts`:

Add to the module docblock, after the "ONE detected kind" paragraph (and change its "ONE detected kind, and deliberately not two" opening to "Detected kinds"):

```ts
 * `retired` and `sameSubject` exist because of #165. A same-subject write that retired a verified
 * fact told only its writer -- in an injection, the one party that was fooled -- and this scan
 * compared active items only, so the retired truth had nothing to pair with: 0 pairs in every
 * red-team store. `retired` lists verified items retired in the last `RETIRED_WINDOW_DAYS`;
 * `sameSubject` lists the pairs the write-path guards keep side by side when one side is verified.
 * Both are filtered to stay short on a real store (4 rows each on this repository's own, against
 * 147 superseded items and 838 same-subject active pairs unfiltered), for the precision reason
 * given above.
```

Imports and types:

```ts
import type { KnowledgeItem, KnowledgeProvenance } from '../core/types.js';
import { duplicateTokens, isVerifiedProvenance, polarityTokensDiffer, sameSubjectTokens } from './knowledge-writer.js';

/** A place to glance at recent swaps, not an audit log: `knowl_timeline` holds the full history. */
export const RETIRED_WINDOW_DAYS = 14;

export type VerifiedParty = ContradictionParty & { provenance: KnowledgeProvenance | null };

export type RetiredVerified = {
  kind: 'retired';
  retired: VerifiedParty;
  replacedBy: VerifiedParty | null;
  /** The retired item's `updatedAt`, which the supersede update stamps. */
  retiredAt: string;
};

export type SameSubjectPair = { kind: 'sameSubject'; a: VerifiedParty; b: VerifiedParty };

export type DetectedContradictions = {
  polarity: PolarityContradiction[];
  retired: RetiredVerified[];
  sameSubject: SameSubjectPair[];
};

const verifiedParty = (item: KnowledgeItem): VerifiedParty => ({ ...party(item), provenance: item.provenance ?? null });
```

Replace `scanContradictions`:

```ts
export async function scanContradictions(options: { now?: Date } = {}): Promise<DetectedContradictions> {
  const all = await repo.listKnowledgeItems();
  const items = all.filter(item => item.status === 'active');
  const byId = new Map(all.map(item => [item.id, item]));

  const titleTokens = items.map(item => duplicateTokens(item.title));

  const polarity: PolarityContradiction[] = [];
  const sameSubject: SameSubjectPair[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (!sameSubjectTokens(titleTokens[i], titleTokens[j])) continue;
      if (polarityTokensDiffer(titleTokens[i], titleTokens[j])) {
        polarity.push({ kind: 'polarity', a: party(items[i]), b: party(items[j]) });
      } else if (
        items[i].category === items[j].category
        && (isVerifiedProvenance(items[i]) || isVerifiedProvenance(items[j]))
      ) {
        sameSubject.push({ kind: 'sameSubject', a: verifiedParty(items[i]), b: verifiedParty(items[j]) });
      }
    }
  }

  const since = (options.now ?? new Date()).getTime() - RETIRED_WINDOW_DAYS * 86_400_000;
  const retired: RetiredVerified[] = all
    .filter(item => item.status === 'superseded' && isVerifiedProvenance(item)
      && Date.parse(item.updatedAt) >= since)
    .map(item => {
      const next = item.supersededById ? byId.get(item.supersededById) : undefined;
      return { kind: 'retired', retired: verifiedParty(item), replacedBy: next ? verifiedParty(next) : null, retiredAt: item.updatedAt };
    });

  return { polarity, retired, sameSubject };
}
```

Note: the existing polarity loop did not require equal categories; keep that behaviour for `polarity` exactly as it was.

- [ ] **Step 4: Run, confirm pass**

Run: `npx vitest run tests/store/visible-retirements.test.ts tests/store/contradiction-visibility.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/contradiction-scan.ts tests/store/visible-retirements.test.ts tests/store/contradiction-visibility.test.ts
git commit -m "feat(conflicts): list recently retired verified facts and verified same-subject pairs"
```

---

### Task 2: Surface both lists in the CLI and MCP, and document them

**Files:**
- Modify: `src/cli/program.ts` (`conflicts` command, ~line 890)
- Modify: `src/mcp/tools.ts` (`knowl_conflicts` handler, ~line 1506)
- Modify: `src/mcp/tool-definitions.ts` (`knowl_conflicts` description, ~line 715)
- Modify: `docs/reference.md` (the `knowl conflicts` and `knowl_conflicts` table rows)
- Test: `tests/mcp/conflicts-visible-retirements.test.ts`

- [ ] **Step 1: Write the failing test.** Find how `tests/mcp/act-as-repo.test.ts` obtains `callTool` and a project root, and use the same helper. The test: seed 6 `observed` items with distinct subjects (`Subject 1 lifetime` … `Subject 6 lifetime`), retire each with a same-title write through `storeKnowledgeItemDeduped`, call `knowl_conflicts`, and assert:

```ts
    const payload = JSON.parse(String(result.content[0].text));
    expect(Object.keys(payload)).toEqual(['declared', 'polarity', 'retired', 'sameSubject']);
    expect(payload.retired).toHaveLength(5);
    expect(String(result.content[1].text)).toContain('1 retired');
```

- [ ] **Step 2: Run, confirm it fails.**

- [ ] **Step 3: Implement.**

`src/mcp/tools.ts`, inside the `knowl_conflicts` handler:

```ts
            text: compactMcpJson({
              declared: items.slice(0, 3).map(item => ({ id: item.id, title: item.title, conflictKey: item.conflictKey, conflictScope: item.conflictScope, freshness: item.freshness })),
              polarity: detected.polarity.slice(0, 5),
              retired: detected.retired.slice(0, 5),
              sameSubject: detected.sameSubject.slice(0, 5),
            }),
```
```ts
        if (detected.retired.length > 5) hidden.push(`${detected.retired.length - 5} retired`);
        if (detected.sameSubject.length > 5) hidden.push(`${detected.sameSubject.length - 5} same-subject`);
```

`src/cli/program.ts`, the `conflicts` command:

```ts
program.command('conflicts').description('List knowledge items that contradict each other: declared exclusive keys, polarity pairs, recently retired verified facts and verified same-subject pairs').action(async () => {
```
```ts
      polarity: detected.polarity,
      retired: detected.retired,
      sameSubject: detected.sameSubject,
```

`src/mcp/tool-definitions.ts`, the `knowl_conflicts` description, replaced whole:

```ts
          description: 'List contradictions: declared exclusive conflict keys; polarity pairs (the same title asserted both ways, kept side by side); verified facts retired in the last 14 days, with what replaced each; and same-subject active pairs with a verified side, which the write path keeps side by side instead of letting either retire the other. Use when a write reports an overlapping item left active, or when memory gives contradictory answers. A wrong retirement is undone by storing the correct fact with supersedes naming its replacement; a side-by-side pair is resolved by retiring one with supersedes (or knowl_update), never by storing a third item. A write that reports a possible REVERSAL is telling you something this command does not list -- act on it there.',
```

`docs/reference.md`:

```markdown
| `knowl conflicts` | List contradictions: declared exclusive keys, polarity pairs, verified facts retired in the last 14 days, and verified same-subject pairs |
```
```markdown
| `knowl_conflicts` | Inspect declared exclusive keys, polarity pairs, recently retired verified facts and verified same-subject pairs |
```

Run `npm.cmd run docs:check`. If it names another file that repeats the old wording (README, generated docs), update that line too.

- [ ] **Step 4: Run, confirm pass**

Run: `npx vitest run tests/mcp/conflicts-visible-retirements.test.ts tests/mcp/act-as-repo.test.ts tests/mcp/tool-annotations.test.ts tests/store/visible-retirements.test.ts tests/store/contradiction-visibility.test.ts; npm.cmd run docs:check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/program.ts src/mcp/tools.ts src/mcp/tool-definitions.ts docs/reference.md tests/mcp/conflicts-visible-retirements.test.ts
git commit -m "feat(conflicts): show retired verified facts and verified pairs in knowl conflicts"
```

---

### Task 3: Mutants, real-store check, changelog, full gate

- [ ] **Step 1: Mutation check.** One at a time, run `npx vitest run tests/store/visible-retirements.test.ts tests/mcp/conflicts-visible-retirements.test.ts`, record failures, then `git checkout -- src`:
1. Drop `isVerifiedProvenance(item)` from the `retired` filter.
2. Drop the `>= since` window condition.
3. Drop the `polarityTokensDiffer` `else` (list polarity pairs under `sameSubject` too).
4. Drop the "at least one verified" condition from `sameSubject`.
5. Drop the category equality from `sameSubject`.
6. Remove `retired` from the MCP handler output.

Expected: each fails a different set.

- [ ] **Step 2: Real-store check.** Build, then run the CLI read-only against the main checkout's store and count both lists:

```bash
npm.cmd run build
cd D:/coding/knowl
node D:/coding/knowl/.claude/worktrees/issue-165-r1/dist/index.js conflicts > $env:LOCALAPPDATA/Temp/r1-conflicts.json
python -c "import json;d=json.load(open(r'C:/Users/Admin/AppData/Local/Temp/r1-conflicts.json'));print({k:len(v) for k,v in d.items()})"
```

Expected: `retired` and `sameSubject` in single digits (spec measured 4 and 4; retirements made since then may add a few). Record the counts and the titles in the report. `knowl conflicts` only reads the store.

- [ ] **Step 3: CHANGELOG.** Under the existing `## Unreleased`, after the #165 entries:

```markdown
### `knowl conflicts` lists retired verified facts and the pairs the write path keeps side by side

A same-subject write that retired a verified fact told only its writer, and `knowl conflicts`
compared active items only, so the retired fact had nothing to pair with (#165). It now also
lists `observed`/`user_stated` items retired in the last 14 days with what replaced each, and
same-subject active pairs with a verified side, which the new write guards keep side by side
instead of superseding. On this repository's own store both lists hold a handful of rows.
```

- [ ] **Step 4: Full gate** (foreground; do not edit `src` while tests run):

```bash
npm.cmd run build
npm.cmd test
npx eslint .
npm.cmd run typecheck
npm.cmd run docs:check
node scripts/check-version-sync.mjs
git diff --check integrate/issue-165
```

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md docs/superpowers/specs/2026-09-28-visible-retirements.md docs/superpowers/plans/2026-09-28-visible-retirements.md
git commit -m "docs: changelog and spec for visible retirements"
```
