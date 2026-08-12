# Sharing Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bare `knowl workspace promote` and a bare `knowl cloud stage` open a picker with a recommended selection, instead of refusing.

**Architecture:** One shared constant names the categories worth sharing. One counting function per caller answers "how many candidates does each category have", because the two ask different questions. One picker module renders the multiselect and returns the chosen categories. Both CLI actions call the picker only when no flags were given and stdin is a TTY; every other path is unchanged.

**Tech Stack:** TypeScript (ESM, Node ≥22), Commander 14, `@clack/prompts` (already a dependency), Vitest. **No new runtime dependencies.**

**Spec:** `docs/superpowers/specs/2026-08-12-sharing-picker-design.md`. Read §2 and §3 before Task 1.

## Global Constraints

- Node `>=22`. ESM only — relative imports end in `.js`. **No new runtime dependencies.**
- Verification is `npm.cmd run build` **then** `npm.cmd test`. Finish with `git diff --check`.
- `@clack/prompts` is imported **lazily** (`await import('@clack/prompts')`), matching `src/cli/init-flow.ts:26` and `src/cli/cloud-picker.ts`. `knowl serve` must not pay for a prompt library.
- **No TTY keeps today's behaviour**: the existing refusal naming `--category` and `--id`. A prompt that cannot be answered must not hang CI.
- **The picker never offers to push.** Staging and sending are two phases because the branch gate sits between them.
- **`--apply` is not required on the interactive path.** The confirmation is the apply. It stays required on the flag path.
- Categories with zero candidates are **listed with their zero**, never hidden.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/core/sharing-defaults.ts` | Create: the one definition of which categories are worth sharing, and why each is excluded |
| `src/cli/sharing-picker.ts` | Create: render the multiselect, return chosen categories or null |
| `src/workspace/promote.ts` | Modify: export `countPromotable()` |
| `src/cloud/publish.ts` | Modify: export `countStageable()` |
| `src/cli/program.ts` | Modify: both actions call the picker when bare and interactive |
| `tests/core/sharing-defaults.test.ts` | Create |
| `tests/cli/sharing-picker.test.ts` | Create |
| `tests/workspace/promote.test.ts` | Modify: `countPromotable` |
| `tests/cloud/publish-stage.test.ts` | Modify: `countStageable` |

---

### Task 1: The recommendation, defined once

**Files:**
- Create: `src/core/sharing-defaults.ts`
- Test: `tests/core/sharing-defaults.test.ts`

**Interfaces:**
- Produces:
  - `SHARED_BY_DEFAULT: readonly KnowledgeCategory[]` — `['decision', 'constraint', 'architecture', 'goal', 'skill']`
  - `WITHHELD_BY_DEFAULT: readonly KnowledgeCategory[]` — `['fact', 'state']`
  - `withholdReason(category: KnowledgeCategory): string | null` — the hint shown beside an unticked row, null for the shared five

In `core/` rather than in either caller: the question is "what does another reader need from this repo", and the answer does not change according to whether that reader is a sibling repo or a teammate. Two copies would drift.

- [ ] **Step 1: Write the failing test**

Create `tests/core/sharing-defaults.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { KNOWLEDGE_CATEGORIES } from '../../src/core/types.js';
import {
  SHARED_BY_DEFAULT, WITHHELD_BY_DEFAULT, withholdReason,
} from '../../src/core/sharing-defaults.js';

describe('what is worth sharing by default', () => {
  it('shares the five a peer cannot work without', () => {
    expect([...SHARED_BY_DEFAULT].sort())
      .toEqual(['architecture', 'constraint', 'decision', 'goal', 'skill']);
  });

  it('withholds the two that are this repo talking about itself', () => {
    // fact and state are ~66% of a mature store and churn on every merge: commit-level
    // changelog and PR verdicts. That volume is the pollution the default exists to prevent.
    expect([...WITHHELD_BY_DEFAULT].sort()).toEqual(['fact', 'state']);
  });

  it('covers every category exactly once, so a new one cannot be silently forgotten', () => {
    const covered = [...SHARED_BY_DEFAULT, ...WITHHELD_BY_DEFAULT].sort();
    expect(covered).toEqual([...KNOWLEDGE_CATEGORIES].sort());
    expect(new Set(covered).size).toBe(KNOWLEDGE_CATEGORIES.length);
  });

  it('explains every withheld category and none of the shared ones', () => {
    for (const category of WITHHELD_BY_DEFAULT) {
      expect(withholdReason(category), category).toBeTruthy();
    }
    for (const category of SHARED_BY_DEFAULT) {
      expect(withholdReason(category), category).toBeNull();
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm.cmd test -- tests/core/sharing-defaults.test.ts`
Expected: FAIL — cannot resolve `../../src/core/sharing-defaults.js`.

- [ ] **Step 3: Implement**

Create `src/core/sharing-defaults.ts`:

```ts
import { KNOWLEDGE_CATEGORIES, type KnowledgeCategory } from './types.js';

/**
 * The categories a bare share offers to send, and the ones it leaves for you to tick.
 *
 * One definition for both destinations. `knowl workspace promote` shares with linked local repos
 * and `knowl cloud stage` queues for the team, but the question underneath is the same -- what
 * does another reader need from this repo -- and the answer does not change according to who the
 * reader is. Two copies would drift.
 *
 * Derived from a real store rather than from taste. In this repository `fact` (359) and `state`
 * (194) are 66% of everything active, and both are the repo talking about itself: commit-level
 * changelog and PR verdicts, which churn on every merge. Sending that to a peer buries the
 * knowledge they came for.
 */
export const SHARED_BY_DEFAULT: readonly KnowledgeCategory[] = [
  // A peer cannot integrate without knowing how this repo is shaped.
  'architecture',
  // Hard rules. Cross-repo constraints are exactly what break integrations when unknown.
  'constraint',
  // Choices with reasoning, so a peer does not re-litigate or contradict one.
  'decision',
  // Direction. A peer needs to know where this repo is going before building against it.
  'goal',
  // Method knowledge. KNOWL.md already says method questions belong to the whole workspace:
  // "a sibling repo's pipeline answers them more often than this repo's files do".
  'skill',
];

export const WITHHELD_BY_DEFAULT: readonly KnowledgeCategory[] = ['fact', 'state'];

const REASONS: Partial<Record<KnowledgeCategory, string>> = {
  fact: 'mostly commit-level detail about this repo',
  state: 'this repo\'s own status; churns on every merge',
};

/** The hint shown beside an unticked row, or null for a category shared by default. */
export function withholdReason(category: KnowledgeCategory): string | null {
  return REASONS[category] ?? null;
}

// Every category belongs to exactly one list. A category added to `KnowledgeCategory` and to
// neither list would silently vanish from the picker -- the row would not render, and nobody
// would be told it exists. Checked at module load so the failure is immediate and local.
{
  const covered = new Set<string>([...SHARED_BY_DEFAULT, ...WITHHELD_BY_DEFAULT]);
  const missing = KNOWLEDGE_CATEGORIES.filter(category => !covered.has(category));
  if (missing.length > 0) {
    throw new Error(
      `sharing-defaults.ts does not classify: ${missing.join(', ')}. `
      + 'Add each to SHARED_BY_DEFAULT or WITHHELD_BY_DEFAULT.',
    );
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm.cmd test -- tests/core/sharing-defaults.test.ts`
Expected: PASS, all four cases.

- [ ] **Step 5: Commit**

```bash
git add src/core/sharing-defaults.ts tests/core/sharing-defaults.test.ts
git commit -m "feat(core): define once which categories are worth sharing"
```

---

### Task 2: Counting candidates, per caller

**Files:**
- Modify: `src/workspace/promote.ts` — add `countPromotable`
- Modify: `src/cloud/publish.ts` — add `countStageable`
- Test: `tests/workspace/promote.test.ts`, `tests/cloud/publish-stage.test.ts`

**Interfaces:**
- Produces:
  - `countPromotable(repoName: string): Promise<Record<KnowledgeCategory, number>>` — rows still at `visibility: 'repo'` this repo owns
  - `countStageable(workspaceId: string, repoName: string): Promise<Record<KnowledgeCategory, number>>` — rows this repo owns that are not staged, not pushed, and **not excluded**

Two functions rather than one parameterised one, because the questions differ in more than a flag: promotion asks about `visibility`, staging asks about the ledger and `cloud_excluded`. Both return every category, zeros included, because the picker lists a zero rather than hiding the row.

- [ ] **Step 1: Write the failing tests**

Append to `tests/workspace/promote.test.ts`:

```ts
  it('counts only unpromoted rows this repo owns, and reports a zero for the rest', async () => {
    const { countPromotable } = await import('../../src/workspace/promote.js');
    await initDb(ROOT);
    try {
      const counts = await countPromotable('server');
      // The fixture seeds one decision and one fact, both owned and unpromoted.
      expect(counts.decision).toBe(1);
      // Every category present, so the picker can render a row per category.
      expect(Object.keys(counts).sort()).toEqual([...KNOWLEDGE_CATEGORIES].sort());
      expect(counts.goal).toBe(0);
    } finally { await closeDb(); }
  });
```

Append to `tests/cloud/publish-stage.test.ts`:

```ts
  it('counts what a sweep would stage, excluding what is already staged', async () => {
    const { countStageable } = await import('../../src/cloud/publish.js');
    await stage({ categories: ['decision'], apply: true });

    await initDb(ROOT);
    try {
      const counts = await countStageable(WS, 'github.com/acme/web');
      // The decision is queued now, so it is no longer a candidate.
      expect(counts.decision).toBe(0);
      expect(counts.fact).toBe(1);
    } finally { await closeDb(); }
  });

  it('does not count an excluded atom, because a sweep would skip it anyway', async () => {
    await exclude(ids.fact);

    await initDb(ROOT);
    try {
      const { countStageable } = await import('../../src/cloud/publish.js');
      expect((await countStageable(WS, 'github.com/acme/web')).fact).toBe(0);
    } finally { await closeDb(); }
  });
```

`KNOWLEDGE_CATEGORIES` must be imported in `tests/workspace/promote.test.ts` if it is not already.

- [ ] **Step 2: Run them and watch them fail**

Run: `npm.cmd test -- tests/workspace/promote.test.ts tests/cloud/publish-stage.test.ts`
Expected: FAIL — `countPromotable` and `countStageable` are not exported.

- [ ] **Step 3: Implement**

Add to `src/workspace/promote.ts`:

```ts
/**
 * How many unpromoted rows this repo owns, per category.
 *
 * Every category is present, zeros included: the picker renders a row per category, because
 * "nothing to promote here" has to be visible. A silently short list reads as a bug.
 *
 * Reads the ambient database. The caller owns opening it, like `selectOwnedItems`.
 */
export async function countPromotable(repoName: string): Promise<Record<KnowledgeCategory, number>> {
  const rows = await getClient().execute({
    sql: `SELECT category, COUNT(*) AS n FROM knowledge_items
          WHERE status = 'active' AND visibility = 'repo'
            AND (origin_repo IS NULL OR origin_repo = ?)
          GROUP BY category`,
    args: [repoName],
  });
  const counts = Object.fromEntries(KNOWLEDGE_CATEGORIES.map(c => [c, 0])) as Record<KnowledgeCategory, number>;
  for (const row of rows.rows) {
    const category = String(row.category) as KnowledgeCategory;
    if (category in counts) counts[category] = Number(row.n);
  }
  return counts;
}
```

Add to `src/cloud/publish.ts`:

```ts
/**
 * How many rows a category sweep would stage, per category.
 *
 * Not the same question `countPromotable` asks. Promotion looks at `visibility`; staging looks at
 * the ledger -- an atom already queued or already pushed is not a candidate -- and at
 * `cloud_excluded`, because the sweep filters those out and a picker that offered them would
 * promise something the sweep then silently drops.
 *
 * Reads the ambient database. The caller owns opening it.
 */
export async function countStageable(
  workspaceId: string,
  repoName: string,
): Promise<Record<KnowledgeCategory, number>> {
  const rows = await getClient().execute({
    sql: `SELECT k.category AS category, COUNT(*) AS n
          FROM knowledge_items k
          LEFT JOIN cloud_published p
            ON p.item_id = k.id AND p.remote_workspace = ?
          WHERE k.status = 'active'
            AND (k.origin_repo IS NULL OR k.origin_repo = ?)
            AND (p.item_id IS NULL OR (p.stage_state <> 'pending' AND p.pushed_at IS NULL))
            AND k.id NOT IN (SELECT item_id FROM cloud_excluded)
          GROUP BY k.category`,
    args: [workspaceId, repoName],
  });
  const counts = Object.fromEntries(KNOWLEDGE_CATEGORIES.map(c => [c, 0])) as Record<KnowledgeCategory, number>;
  for (const row of rows.rows) {
    const category = String(row.category) as KnowledgeCategory;
    if (category in counts) counts[category] = Number(row.n);
  }
  return counts;
}
```

Import `KNOWLEDGE_CATEGORIES` in both files if not already present.

- [ ] **Step 4: Run them and watch them pass**

Run: `npm.cmd test -- tests/workspace/promote.test.ts tests/cloud/publish-stage.test.ts`
Expected: PASS, including every pre-existing case.

- [ ] **Step 5: Commit**

```bash
git add src/workspace/promote.ts src/cloud/publish.ts tests/workspace/promote.test.ts tests/cloud/publish-stage.test.ts
git commit -m "feat(cli): count what each destination could actually share"
```

---

### Task 3: The picker

**Files:**
- Create: `src/cli/sharing-picker.ts`
- Test: `tests/cli/sharing-picker.test.ts`

**Interfaces:**
- Consumes: `SHARED_BY_DEFAULT`, `WITHHELD_BY_DEFAULT`, `withholdReason` (Task 1)
- Produces: `pickCategories(input: { verb: string; destination: string; counts: Record<KnowledgeCategory, number>; isTTY?: boolean }): Promise<KnowledgeCategory[] | null>` — the chosen categories, or `null` when there is no TTY or the user cancelled

Returns `null` for both "no TTY" and "cancelled" for the same reason `pickWorkspace` does: the caller's remedy is identical, and it is the behaviour that existed before the picker.

- [ ] **Step 1: Write the failing test**

Create `tests/cli/sharing-picker.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KnowledgeCategory } from '../../src/core/types.js';

const counts = {
  fact: 359, decision: 72, goal: 7, constraint: 90,
  architecture: 101, state: 194, skill: 19,
} as Record<KnowledgeCategory, number>;

describe('pickCategories', () => {
  afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

  it('returns null without prompting when there is no TTY', async () => {
    vi.doMock('@clack/prompts', () => ({
      multiselect: async () => { throw new Error('must not prompt without a TTY'); },
      isCancel: () => false,
    }));

    const { pickCategories } = await import('../../src/cli/sharing-picker.js');
    expect(await pickCategories({ verb: 'promote', destination: 'acme', counts, isTTY: false })).toBeNull();
  });

  it('preticks the five worth sharing and leaves fact and state unticked', async () => {
    let initial: string[] = [];
    vi.doMock('@clack/prompts', () => ({
      multiselect: async (input: { initialValues: string[] }) => {
        initial = input.initialValues;
        return ['decision'];
      },
      isCancel: () => false,
    }));

    const { pickCategories } = await import('../../src/cli/sharing-picker.js');
    await pickCategories({ verb: 'promote', destination: 'acme', counts, isTTY: true });

    expect([...initial].sort()).toEqual(['architecture', 'constraint', 'decision', 'goal', 'skill']);
  });

  it('lists every category with its count, including a zero', async () => {
    let options: Array<{ value: string; label: string; hint?: string }> = [];
    vi.doMock('@clack/prompts', () => ({
      multiselect: async (input: { options: typeof options }) => { options = input.options; return ['decision']; },
      isCancel: () => false,
    }));

    const { pickCategories } = await import('../../src/cli/sharing-picker.js');
    await pickCategories({
      verb: 'promote', destination: 'acme',
      counts: { ...counts, goal: 0 }, isTTY: true,
    });

    // "Nothing to promote here" must be visible; a silently short list reads as a bug.
    const goal = options.find(option => option.value === 'goal');
    expect(goal).toBeDefined();
    expect(goal!.label).toContain('0');
  });

  it('explains why fact and state are unticked', async () => {
    let options: Array<{ value: string; hint?: string }> = [];
    vi.doMock('@clack/prompts', () => ({
      multiselect: async (input: { options: typeof options }) => { options = input.options; return []; },
      isCancel: () => false,
    }));

    const { pickCategories } = await import('../../src/cli/sharing-picker.js');
    await pickCategories({ verb: 'promote', destination: 'acme', counts, isTTY: true });

    expect(options.find(o => o.value === 'fact')!.hint).toBeTruthy();
    expect(options.find(o => o.value === 'decision')!.hint).toBeUndefined();
  });

  it('returns null when the user cancels', async () => {
    const CANCEL = Symbol('cancel');
    vi.doMock('@clack/prompts', () => ({
      multiselect: async () => CANCEL,
      isCancel: (value: unknown) => value === CANCEL,
    }));

    const { pickCategories } = await import('../../src/cli/sharing-picker.js');
    expect(await pickCategories({ verb: 'promote', destination: 'acme', counts, isTTY: true })).toBeNull();
  });

  it('returns an empty array when the user unticks everything, which is not a cancel', async () => {
    // Deliberately distinct from null: "I chose nothing" is an answer, and the caller reports
    // "nothing selected" rather than falling back to the no-TTY refusal.
    vi.doMock('@clack/prompts', () => ({
      multiselect: async () => [],
      isCancel: () => false,
    }));

    const { pickCategories } = await import('../../src/cli/sharing-picker.js');
    expect(await pickCategories({ verb: 'promote', destination: 'acme', counts, isTTY: true })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm.cmd test -- tests/cli/sharing-picker.test.ts`
Expected: FAIL — cannot resolve `../../src/cli/sharing-picker.js`.

- [ ] **Step 3: Implement**

Create `src/cli/sharing-picker.ts`:

```ts
import { KNOWLEDGE_CATEGORIES, type KnowledgeCategory } from '../core/types.js';
import { SHARED_BY_DEFAULT, withholdReason } from '../core/sharing-defaults.js';

/**
 * Ask which categories to share, with a recommendation already ticked.
 *
 * Returns null for both "no TTY" and "cancelled", because the caller's remedy is the same in
 * both cases: print the refusal naming `--category` and `--id`, which is exactly what this
 * command did before the picker existed. An empty array is different and means the user
 * deliberately unticked everything.
 */
export async function pickCategories(input: {
  /** The command the user typed, so the prompt names it: `promote` or `stage`. */
  verb: string;
  /** Where it goes -- a workspace name -- so the prompt says what sharing means here. */
  destination: string;
  counts: Record<KnowledgeCategory, number>;
  isTTY?: boolean;
}): Promise<KnowledgeCategory[] | null> {
  const isTTY = input.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!isTTY) return null;

  // Lazily, matching `init-flow.ts` and `cloud-picker.ts`: the prompt library is only reachable
  // from interactive paths and must not be paid for by `knowl serve`.
  const clack = await import('@clack/prompts');

  const width = Math.max(...KNOWLEDGE_CATEGORIES.map(category => category.length));
  const chosen = await clack.multiselect({
    message: `Which knowledge should ${input.verb} send to "${input.destination}"?`,
    options: KNOWLEDGE_CATEGORIES.map(category => {
      const reason = withholdReason(category);
      return {
        value: category,
        label: `${category.padEnd(width)}  ${input.counts[category] ?? 0}`,
        ...(reason ? { hint: reason } : {}),
      };
    }),
    initialValues: [...SHARED_BY_DEFAULT],
    required: false,
  });

  return clack.isCancel(chosen) ? null : (chosen as KnowledgeCategory[]);
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm.cmd test -- tests/cli/sharing-picker.test.ts`
Expected: PASS, all six cases.

- [ ] **Step 5: Commit**

```bash
git add src/cli/sharing-picker.ts tests/cli/sharing-picker.test.ts
git commit -m "feat(cli): a category picker that arrives with a recommendation"
```

---

### Task 4: Wire both commands

**Files:**
- Modify: `src/cli/program.ts` — the `workspace promote` action and the `cloud stage` action
- Test: manual render, per the CLI-rendering constraint

**Interfaces:**
- Consumes: `pickCategories` (Task 3), `countPromotable` / `countStageable` (Task 2)

**The interactive path does not need `--apply`.** The confirmation is the apply. `--apply` keeps its meaning on the flag path, where there is no prompt to answer.

- [ ] **Step 1: Wire `workspace promote`**

In the `promote` action, after `if (!active) throw new Error(...)` and before `const categories = ...`:

```ts
      // A bare call asks instead of refusing. Flags mean the caller already knows what they
      // want, so the picker stays out of their way entirely.
      let picked: KnowledgeCategory[] | undefined;
      let interactive = false;
      if (!options.category && !options.id) {
        await initDb(root);
        let counts;
        try { counts = await countPromotable(active.repo); }
        finally { await closeDb(); }

        const chosen = await pickCategories({
          verb: 'promote', destination: active.name, counts,
        });
        // Null is "no TTY" or "cancelled". Falling through to `promoteItems` reproduces the
        // refusal this command has always given, which is the right answer for both.
        if (chosen === null) {
          const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
          if (!process.stdin.isTTY) {
            throw new Error(
              `Specify what to promote with --category <list> or --id <id>. `
              + `${total} item(s) are unpromoted; a bare promote would publish all of them.`,
            );
          }
          console.log('Nothing promoted.');
          return;
        }
        if (chosen.length === 0) {
          console.log('Nothing selected, so nothing was promoted.');
          return;
        }
        picked = chosen;
        interactive = true;
      }
```

Then change the `promoteItems` call so the picker's choice is used and its confirmation is the apply:

```ts
      const result = await promoteItems({
        projectRoot: root,
        repoName: active.repo,
        categories: picked ?? categories,
        ids: options.id,
        apply: interactive || options.apply,
      });
```

- [ ] **Step 2: Wire `cloud stage`**

In the `stage` action, after `const config = await loadConfig(root);` and before the `stagePublish` call:

```ts
      if (!config.cloud) {
        console.error('This repository is not connected to a cloud workspace. Run knowl cloud connect.');
        process.exit(1);
      }

      let picked: KnowledgeCategory[] | undefined;
      let interactive = false;
      if (!options.category && !options.id) {
        await initDb(root);
        let counts;
        try { counts = await countStageable(config.cloud.workspaceId, config.workspace?.repo ?? config.cloud.repo); }
        finally { await closeDb(); }

        const chosen = await pickCategories({
          verb: 'stage',
          destination: config.cloud.workspaceName ?? config.cloud.workspaceId,
          counts,
        });
        if (chosen === null) {
          const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
          if (!process.stdin.isTTY) {
            throw new Error(
              'Specify what to stage with --category <list> or --id <id>. '
              + `${total} item(s) are unstaged; a bare stage would queue all of them for the team.`,
            );
          }
          console.log('Nothing staged.');
          return;
        }
        if (chosen.length === 0) {
          console.log('Nothing selected, so nothing was staged.');
          return;
        }
        picked = chosen;
        interactive = true;
      }
```

and pass them through:

```ts
      const result = await stagePublish({
        projectRoot: root,
        config,
        ids: options.id,
        categories: picked ?? options.category?.split(',').map((entry: string) => entry.trim()),
        apply: interactive || options.apply,
      });
```

- [ ] **Step 3: Typecheck, and add the imports**

`src/cli/program.ts` needs `pickCategories` from `./sharing-picker.js`, `countPromotable` from `../workspace/promote.js`, and `countStageable` from `../cloud/publish.js`.

Run: `npm.cmd run typecheck`
Expected: 0 errors.

- [ ] **Step 4: Render both, per the CLI constraint**

```bash
npm.cmd run build
node dist/index.js workspace promote          # picker, five preticked
node dist/index.js workspace promote --help   # --apply still documented
echo "" | node dist/index.js workspace promote   # non-TTY: the refusal, naming a total
```

A command tree that compiles can still render wrongly; this is the step that catches it. The non-TTY run must **refuse**, not hang.

- [ ] **Step 5: Full verification and commit**

```bash
npm.cmd run lint
npm.cmd test
npm.cmd run docs:check
git diff --check
git add src/cli/program.ts
git commit -m "feat(cli): a bare promote and a bare stage ask instead of refusing"
```

---

### Task 5: Document it

**Files:**
- Modify: `docs/reference.md` — the `workspace promote` and `cloud stage` rows

- [ ] **Step 1: Update both command-table rows**

They currently describe the flags only. Each gains a sentence saying a bare call opens a picker with a recommended selection, and that `--apply` is only needed on the flag path.

- [ ] **Step 2: Verify and commit**

```bash
npm.cmd run docs:check
git add docs/reference.md
git commit -m "docs: a bare share asks, and --apply is for the flag path"
```

---

## What this plan deliberately does not do

- **No change to what `promote` does once chosen.** Still a one-column `visibility` update with deliberately no demote.
- **No new MCP surface.** A picker is a human interaction; an agent that wants the recommended set passes it explicitly.
- **No change to the push gate or its confirmation.** The picker never offers to push.
</content>
