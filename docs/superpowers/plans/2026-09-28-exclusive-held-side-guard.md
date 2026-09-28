# Exclusive held-side guard (R3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An implicit same-subject write never retires an active item marked `conflictExclusive`; it is kept beside it.

**Architecture:** One guard line in `resolveDuplicate`, returning the existing `coexist`, placed with the polarity / value-free / channel guards (after the `supersedes` and `sameSubjectTitle` checks). Both writers already route through it.

**Tech Stack:** TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-09-28-exclusive-held-side-guard.md`

## Global Constraints

- Worktree `D:/coding/knowl/.claude/worktrees/issue-165-r3`, branch `fix/issue-165-exclusive-held-side`, based on `integrate/issue-165` (R2 + R5 already merged in). Do not rebase onto `origin/main`.
- An explicit `supersedes` naming the exclusive item still wins. `checkKnowledgeConflict` (`src/store/conflicts.ts:39`) is not changed.
- Docblocks explain WHY, naming the failure. Lowercase conventional commits.

---

### Task 0: Baseline

- [ ] **Step 1:**

```bash
npm.cmd ci
npm.cmd run build
npx vitest run tests/store/duplicate-polarity-guard.test.ts tests/store/supersede-on-write.test.ts tests/store/import-exclusive-conflict.test.ts tests/store/batch-write-integrity.test.ts tests/store/write-channel-guard.test.ts tests/store/value-free-restatement.test.ts
```

Expected: all pass. If not, stop and report.

- [ ] **Step 2:** Confirm no session-handoff path calls the deduped writers:

```bash
git grep -n "storeKnowledgeItemDeduped\|storeKnowledgeAtomsDeduped" -- src/session
```

Expected: no matches (handoffs use `repo.updateKnowledgeItem`). If there are matches, stop and report: the guard would change handoff replacement.

---

### Task 1: The guard

**Files:**
- Modify: `src/store/knowledge-writer.ts` (`resolveDuplicate`, after the `dropsValuesOnly` line)
- Create: `tests/store/exclusive-held-side.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/store/exclusive-held-side.test.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { resolveDuplicate, storeKnowledgeAtomsDeduped, storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import type { KnowledgeItem } from '../../src/core/types.js';

const TITLE = 'Production database engine';
const held = (over: Partial<KnowledgeItem>): KnowledgeItem => ({
  id: 'held-1', category: 'decision', title: TITLE,
  content: 'Production runs on PostgreSQL 16.', status: 'active', provenance: null,
  conflictKey: 'database.production.engine', conflictExclusive: true,
  ...over,
} as KnowledgeItem);
const attack = { category: 'decision' as const, title: TITLE, content: 'Production runs on MySQL 5.7.' };

describe('resolveDuplicate exclusive held-side guard (#165 R3)', () => {
  it('an implicit same-subject write is kept beside an exclusive item', () => {
    expect(resolveDuplicate(attack, held({}))).toBe('coexist');
  });

  it('an explicit supersedes still retires it', () => {
    expect(resolveDuplicate({ ...attack, supersedes: 'held-1' }, held({}))).toBe('supersede');
  });

  it('a non-exclusive item is superseded as before', () => {
    expect(resolveDuplicate(attack, held({ conflictExclusive: false, conflictKey: null }))).toBe('supersede');
  });
});

describe('the report X1 shape through both writers', () => {
  const ROOT = path.resolve('./.knowl-exclusive-held-side-test');
  let projectId = '';
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'exclusive-held')).id;
  });
  afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('single writer: omitting the key no longer retires the exclusive item', async () => {
    const seed = await storeKnowledgeItemDeduped(projectId, {
      category: 'decision', title: 'Token lifetime', content: 'Access tokens expire after 15 minutes.',
      conflictKey: 'auth.token.lifetime', conflictExclusive: true,
    });
    const write = await storeKnowledgeItemDeduped(projectId, {
      category: 'decision', title: 'Token lifetime', content: 'Access tokens expire after 30 days.',
    });
    expect((await repo.getKnowledgeItem(seed.item.id))!.status).toBe('active');
    expect(write.superseded).toBeUndefined();
    expect(write.nearDuplicate?.id).toBe(seed.item.id);
  });

  it('batch writer: the same', async () => {
    const seed = await storeKnowledgeItemDeduped(projectId, {
      category: 'decision', title: 'Backup retention', content: 'Nightly backups are kept for 35 days.',
      conflictKey: 'backup.retention', conflictExclusive: true,
    });
    const batch = await storeKnowledgeAtomsDeduped(projectId, [{
      category: 'decision', title: 'Backup retention', content: 'Nightly backups are kept for 1 day.',
    }]);
    expect((await repo.getKnowledgeItem(seed.item.id))!.status).toBe('active');
    expect(batch.supersededIds).toEqual([]);
    expect(batch.outcomes[0].nearDuplicateId).toBe(seed.item.id);
  });
});
```

- [ ] **Step 2: Run, confirm it fails**

Run: `npx vitest run tests/store/exclusive-held-side.test.ts`
Expected: the "kept beside" and both writer tests FAIL (`'supersede'` / `'superseded'`); "explicit supersedes" and "non-exclusive" pass.

- [ ] **Step 3: Implement.** After the `dropsValuesOnly` line in `resolveDuplicate`:

```ts
  // The author marked this the one active answer to its key. `checkKnowledgeConflict` only
  // stops a writer that volunteers the same key, so a write that simply left the key out
  // retired it anyway: 36 of 36 in the #165 red team, against 36 of 36 refused with the key.
  // Honoured from the held side here; retiring it takes an explicit `supersedes`.
  if (duplicate.conflictExclusive) return 'coexist';
```

- [ ] **Step 4: Run, confirm pass**

Run: `npx vitest run tests/store/exclusive-held-side.test.ts tests/store/duplicate-polarity-guard.test.ts tests/store/supersede-on-write.test.ts tests/store/import-exclusive-conflict.test.ts tests/store/batch-write-integrity.test.ts tests/store/write-channel-guard.test.ts tests/store/value-free-restatement.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/knowledge-writer.ts tests/store/exclusive-held-side.test.ts
git commit -m "fix(store): an item marked exclusive is kept beside an implicit same-subject write"
```

---

### Task 2: Mutants, replay, changelog, full gate

- [ ] **Step 1: Mutation check.** One at a time, run `npx vitest run tests/store/exclusive-held-side.test.ts`, record failures, restore with `git checkout -- src`:
1. Delete the guard line.
2. Move the guard above `if (input.supersedes && input.supersedes === duplicate.id) return 'supersede';`.
3. Change it to `if (duplicate.conflictKey) return 'coexist';`.

Expected: each fails a different set (mutant 3 must fail "non-exclusive… superseded as before"; if it does not, make that test's held item carry a key with `conflictExclusive: false`).

- [ ] **Step 2: Replay.** Read-only against `D:/coding/knowl/.knowl/knowl.db`:

```bash
python -c "import sqlite3;c=sqlite3.connect('file:D:/coding/knowl/.knowl/knowl.db?mode=ro',uri=True);print(c.execute(\"select count(*) from knowledge_items where superseded_by_id is not null\").fetchone(), c.execute(\"select o.title,n.title from knowledge_items o join knowledge_items n on n.id=o.superseded_by_id where o.conflict_exclusive=1\").fetchall())"
```

Expected: 1 retired exclusive item ("Optional transcript search plan review status"). Record it in the report as the one real supersession the rule would have changed.

- [ ] **Step 3: CHANGELOG.** Under the existing `## Unreleased`, after the two #165 entries:

```markdown
### An item marked exclusive is no longer retired by a write that leaves its key out

`conflictExclusive` only refused a second write that carried the same key, so a same-subject write
that simply omitted it retired the exclusive item anyway (#165). The two are now kept side by side;
retire the exclusive one deliberately with `supersedes`. One of 140 real supersessions in this
repository's own store would have needed that.
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
git add CHANGELOG.md docs/superpowers/specs/2026-09-28-exclusive-held-side-guard.md docs/superpowers/plans/2026-09-28-exclusive-held-side-guard.md
git commit -m "docs: changelog and spec for the exclusive held-side guard"
```
