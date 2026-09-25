# Value-free restatement guard (R5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A same-subject write that drops the held item's values and adds none is kept beside it instead of retiring it.

**Architecture:** One pure function, `dropsValuesOnly`, beside `differsOnlyInPolarity` in `src/store/knowledge-writer.ts`, and one guard line in `resolveDuplicate` returning the existing `coexist`. Applies on every channel; an explicit `supersedes` still wins.

**Tech Stack:** TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-09-25-value-free-restatement-guard.md`

## Global Constraints

- Independent of the R2 plan. Branch `fix/issue-165-value-free-restatement` off `origin/main`, in its own worktree `D:/coding/knowl/.claude/worktrees/issue-165-r5`. If R2 has merged first, rebase; the two guard lines sit next to each other and do not interact.
- Value token = a match of `/[A-Za-z0-9_][A-Za-z0-9_.\/-]*/g` within a sentence, trailing dots stripped, that is digit-bearing, or capitalised and not the sentence's first word. Compared lowercased. Body only, never title.
- Sentence split: `/(?<=[.!?])\s+|\n+/`, the one `reversalCueSentences` uses.
- Docblocks explain WHY, naming the failure. Lowercase conventional commits.

---

### Task 0: Worktree and baseline

- [ ] **Step 1:**

```bash
cd D:/coding/knowl
git fetch origin
git worktree add -b fix/issue-165-value-free-restatement .claude/worktrees/issue-165-r5 origin/main
cd .claude/worktrees/issue-165-r5
cp ../issue-165-write-guards/docs/superpowers/specs/2026-09-25-value-free-restatement-guard.md docs/superpowers/specs/
cp ../issue-165-write-guards/docs/superpowers/plans/2026-09-25-value-free-restatement-guard.md docs/superpowers/plans/
npm.cmd ci --ignore-scripts
npm.cmd run build
npx vitest run tests/store/duplicate-polarity-guard.test.ts tests/store/supersede-on-write.test.ts
```

Expected: pass. If not, stop: they fail before our change.

---

### Task 1: `dropsValuesOnly` and the guard

**Files:**
- Modify: `src/store/knowledge-writer.ts` (new function after `polarityTokensDiffer` ~305; one line in `resolveDuplicate` ~601)
- Create: `tests/store/value-free-restatement.test.ts`

**Interfaces:**
- Produces: `export function dropsValuesOnly(incoming: { content: string }, held: { content: string }): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// tests/store/value-free-restatement.test.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { dropsValuesOnly, resolveDuplicate, storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import type { KnowledgeItem } from '../../src/core/types.js';

const BACKUP = 'Nightly database backups are retained for 35 days and encrypted at rest.';
const VAGUE = 'Nightly database backups are retained for the value documented in the ops runbook and encrypted at rest.';

describe('dropsValuesOnly', () => {
  it('fires when the incoming write drops the held value and adds none (the #165 N2 shape)', () => {
    expect(dropsValuesOnly({ content: VAGUE }, { content: BACKUP })).toBe(true);
  });

  it('fires on a dropped mid-sentence proper noun', () => {
    expect(dropsValuesOnly(
      { content: 'Card payments are processed through a hosted page.' },
      { content: 'Card payments are processed through Stripe Checkout.' },
    )).toBe(true);
  });

  it('does not fire on a correction that swaps the value', () => {
    expect(dropsValuesOnly(
      { content: 'Nightly database backups are retained for 90 days and encrypted at rest.' },
      { content: BACKUP },
    )).toBe(false);
  });

  it('does not fire when every value is kept and prose is added', () => {
    expect(dropsValuesOnly(
      { content: `${BACKUP} Restores are tested monthly.` },
      { content: BACKUP },
    )).toBe(false);
  });

  it('does not fire when the held item carries no values', () => {
    expect(dropsValuesOnly(
      { content: 'Backups are kept for a while.' },
      { content: 'Backups are kept for some time and encrypted.' },
    )).toBe(false);
  });

  it('does not fire when a value is swapped, even if another is dropped', () => {
    expect(dropsValuesOnly(
      { content: 'Backups are retained for 90 days.' },
      { content: 'Backups are retained for 35 days in eu-central-1.' },
    )).toBe(false);
  });

  it('does not count a sentence-initial capital as a value', () => {
    // Were "Postgres" counted, the held item would carry a value the incoming one drops.
    expect(dropsValuesOnly(
      { content: 'the project data is stored locally.' },
      { content: 'Postgres stores the project data.' },
    )).toBe(false);
  });

  it('reads a version and a region as one token each', () => {
    expect(dropsValuesOnly(
      { content: 'All customer data is stored in the primary region.' },
      { content: 'All customer data is stored in eu-central-1 on v5.23.1.' },
    )).toBe(true);
  });
});

const held = (content: string): KnowledgeItem => ({
  id: 'held-1', category: 'fact', title: 'Database backup retention', content, status: 'active', provenance: null,
} as KnowledgeItem);

describe('resolveDuplicate value-free guard', () => {
  it('clamps a value-dropping restatement to coexist', () => {
    expect(resolveDuplicate({ category: 'fact', title: 'Database backup retention', content: VAGUE }, held(BACKUP))).toBe('coexist');
  });

  it('an explicit supersedes still wins', () => {
    expect(resolveDuplicate({ category: 'fact', title: 'Database backup retention', content: VAGUE, supersedes: 'held-1' }, held(BACKUP))).toBe('supersede');
  });

  it('a value-changing correction still supersedes', () => {
    expect(resolveDuplicate(
      { category: 'fact', title: 'Database backup retention', content: 'Nightly database backups are retained for 90 days and encrypted at rest.' },
      held(BACKUP),
    )).toBe('supersede');
  });
});

describe('a value-free restatement through a real write', () => {
  const ROOT = path.resolve('./.knowl-value-free-restatement-test');
  let projectId = '';
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'value-free')).id;
  });
  afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('leaves both active and reports the held one', async () => {
    const seed = await storeKnowledgeItemDeduped(projectId, { category: 'fact', title: 'Database backup retention', content: BACKUP });
    const vague = await storeKnowledgeItemDeduped(projectId, { category: 'fact', title: 'Database backup retention', content: VAGUE });

    expect((await repo.getKnowledgeItem(seed.item.id))!.status).toBe('active');
    expect(vague.superseded).toBeUndefined();
    expect(vague.nearDuplicate?.id).toBe(seed.item.id);
  });
});
```

- [ ] **Step 2: Run, confirm it fails**

Run: `npx vitest run tests/store/value-free-restatement.test.ts`
Expected: FAIL, `dropsValuesOnly` is not exported.

- [ ] **Step 3: Implement**

After `polarityTokensDiffer` in `src/store/knowledge-writer.ts`:

```ts
/**
 * The value-bearing words of a body: digit-bearing (`35`, `eu-central-1`, `v5.23.1`) or
 * capitalised mid-sentence (`PostgreSQL`, `Stripe`, `UTC`). Lowercased for comparison.
 */
function valueTokens(content: string): Set<string> {
  const values = new Set<string>();
  for (const sentence of content.split(/(?<=[.!?])\s+|\n+/)) {
    const words = sentence.match(/[A-Za-z0-9_][A-Za-z0-9_.\/-]*/g) ?? [];
    words.forEach((raw, index) => {
      const word = raw.replace(/\.+$/, '');
      if (/\d/.test(word) || (index > 0 && /[A-Z]/.test(word))) values.add(word.toLowerCase());
    });
  }
  return values;
}

/**
 * Whether an incoming body drops some of the held body's values and adds none of its own.
 *
 * THE FAILURE THIS EXISTS FOR (#165, N2). "Nightly database backups are retained for 35 days"
 * was retired by the same sentence with "35 days" replaced by "the value documented in the ops
 * runbook": 36 of 36 red-team writes, after which "35 days" was nowhere in the top three results.
 * The write asserts nothing false. It is emptier, and superseding trades the value for its
 * absence. Honest agents produce the same shape when they paraphrase a precise fact vaguely.
 *
 * NOT A SECURITY BOUNDARY. An attacker who swaps the value instead of dropping it adds a value
 * token and is not caught here; that is the channel guard's job.
 *
 * ponytail: lexical, so a value written as ordinary words ("two reviewer approvals", "always
 * redacted") is invisible to it -- 3 of the report's 12 subjects. Catching those needs meaning,
 * not tokens. Replayed over 140 real supersessions this fires on none.
 */
export function dropsValuesOnly(incoming: { content: string }, held: { content: string }): boolean {
  const heldValues = valueTokens(held.content);
  if (heldValues.size === 0) return false;
  const incomingValues = valueTokens(incoming.content);
  for (const value of incomingValues) if (!heldValues.has(value)) return false;
  return incomingValues.size < heldValues.size;
}
```

In `resolveDuplicate`, after the polarity line (and after R2's channel line, if present):

```ts
  if (dropsValuesOnly(input, duplicate)) return 'coexist';
```

- [ ] **Step 4: Run, confirm pass**

Run: `npx vitest run tests/store/value-free-restatement.test.ts tests/store/duplicate-polarity-guard.test.ts tests/store/supersede-on-write.test.ts`
Expected: PASS. `supersede-on-write`'s "40 percent" → "90 percent" case adds a value, so it still supersedes.

- [ ] **Step 5: Commit**

```bash
git add src/store/knowledge-writer.ts tests/store/value-free-restatement.test.ts
git commit -m "fix(store): a restatement that drops a fact's values is kept beside it"
```

---

### Task 2: Mutants, replay, changelog, full gate, PR

- [ ] **Step 1: Mutation check.** One at a time, run `npx vitest run tests/store/value-free-restatement.test.ts`, record failures, then `git checkout -- src`:

1. Replace the `for ... return false` "adds none" loop with nothing.
2. Change `return incomingValues.size < heldValues.size;` to `return true;`.
3. Change `index > 0 &&` to `index >= 0 &&` (sentence-initial capitals count).
4. Delete the guard line in `resolveDuplicate`.

Expected: each fails a different set. If one survives, add the missing test first.

- [ ] **Step 2: Replay against the real store.** From the main checkout, `python C:/Users/Admin/AppData/Local/Temp/r5replay.py`. Expected: `caps 0 of <N>` real supersessions, `N2 caught caps 9 /12`. Put both in the PR body.

- [ ] **Step 3: CHANGELOG** under `## Unreleased` (create above the latest version heading if absent):

```markdown
### A restatement that drops a fact's values no longer retires it

A same-subject write that removed a fact's numbers, versions or names and added none of its own
used to supersede it, so "retained for 35 days" could be replaced by "retained for the value in
the runbook" and the value vanished from results (#165). The two are now kept side by side.
Values written as ordinary words are not detected. Replayed over 140 real supersessions, this
fires on none of them.
```

- [ ] **Step 4: Full gate** (tests backgrounded; do not edit `src` while they run):

```bash
npm.cmd run build
npm.cmd test
npx eslint .
npm.cmd run typecheck
npm.cmd run docs:check
node scripts/check-version-sync.mjs
git diff --check origin/main
```

Compare any failure against a detached `origin/main` baseline before calling it a regression.

- [ ] **Step 5: Commit, push, PR**

```bash
git add CHANGELOG.md docs/superpowers/specs/2026-09-25-value-free-restatement-guard.md docs/superpowers/plans/2026-09-25-value-free-restatement-guard.md
git commit -m "docs: changelog and spec for the value-free restatement guard"
git push -u origin fix/issue-165-value-free-restatement
gh pr create -R dat999zx/knowl --title "fix(store): a restatement that drops a fact's values is kept beside it (#165 R5)" --body-file <body>
gh pr checks --watch
```
