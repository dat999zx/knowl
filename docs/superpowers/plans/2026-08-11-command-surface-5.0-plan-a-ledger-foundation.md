# Command Surface 5.0 — Plan A: The Ledger Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the publication ledger able to express exclusion and unstaging without ever losing `remote_version`.

**Architecture:** Two schema changes at migration level 10. A new workspace-independent `cloud_excluded` table holds "never publish this atom". A new `stage_state` column on `cloud_published` carries the staging state explicitly, so `pushed_at` stops being overloaded as a flag and can keep meaning "when this was last successfully pushed". Every ledger function moves onto the explicit state; `remote_version` becomes write-once-by-push, clear-only-by-retract.

**Tech Stack:** TypeScript (ESM, Node ≥22), `@libsql/client`, Vitest. **No new runtime dependencies.**

**Spec:** `docs/superpowers/specs/2026-08-11-command-surface-redesign-design.md` §3.6, §5.2, §5.3. Read those three sections before Task 1.

**Why this plan is first:** Plans B (namespace + status), C (auto-staging) and D (surface cleanup) all read or write this ledger. The review at `6a8eae3` found that the current schema cannot represent what they need, so nothing else can be built correctly until this lands.

## Global Constraints

- Node `>=22`. ESM only — relative imports end in `.js`. **No new runtime dependencies.**
- Verification is `npm.cmd run build` **then** `npm.cmd test`. Finish with `git diff --check`.
- **Never `initDb`/`closeDb` from anything reachable by a tool call.** Constraint `defde27f6f234535`: the MCP server establishes the global context once at startup, so a helper that closes it leaves every later tool call with no database — and no unit test can see it, because a test has no ambient context to destroy.
- **`remote_version` is written by a successful push and cleared only by retraction.** No staging, re-staging, unstaging or exclusion path may touch it. The server treats a republish arriving without `expectedVersion` as a conflict by design, so that an older client cannot acquire overwrite rights by not knowing the field exists.
- **`visibility` is not touched, at all.** Publication state lives in the ledger (decision `ee191dd7db024bec`). `repo` and `workspace` keep their exact current meanings.
- **A new migration level is required for an existing store to get anything.** A database already stamped at level 9 skips `SCHEMA_STATEMENTS` entirely, so `CREATE TABLE IF NOT EXISTS` alone reaches new stores only.
- Migration level goes to **10**. `KNOWL_SCHEMA_VERSION` stays **1** — these changes are additive and an older build can still read the file.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/store/schema-version.ts` | Modify: bump `KNOWL_MIGRATION_LEVEL` to 10, with the changelog comment the file's convention requires |
| `src/store/bootstrap.ts` | Modify: add `cloud_excluded` to `SCHEMA_STATEMENTS`; add `ensureLedgerStageState()` and wire it beside the other `ensure*` migrations |
| `src/cloud/exclusions.ts` | Create: the `cloud_excluded` table's only reader and writer |
| `src/cloud/ledger.ts` | Modify: move every function onto `stage_state`; add `unstagePublish` |
| `tests/cloud/exclusions.test.ts` | Create |
| `tests/cloud/ledger.test.ts` | Modify: existing cases plus the new state transitions |
| `tests/store/migration-level-10.test.ts` | Create: backfill correctness against a store built at level 9 |

Exclusions live in their own module rather than in `ledger.ts` because they are workspace-independent and `ledger.ts` is workspace-keyed throughout — mixing them is what would let an exclusion acquire a workspace by accident.

---

### Task 1: The `cloud_excluded` table

**Files:**
- Modify: `src/store/bootstrap.ts` — add one statement to `SCHEMA_STATEMENTS` near the `cloud_published` definition (currently line 361)
- Modify: `src/store/schema-version.ts:127` — `KNOWL_MIGRATION_LEVEL` 9 → 10
- Test: `tests/cloud/exclusions.test.ts`

**Interfaces:**
- Produces: table `cloud_excluded(item_id TEXT PRIMARY KEY, excluded_at TEXT NOT NULL, reason TEXT)`

- [ ] **Step 1: Write the failing test**

Create `tests/cloud/exclusions.test.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';

const ROOT = path.resolve('./.knowl-exclusions-root');

describe('cloud_excluded', () => {
  beforeEach(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(ROOT, { recursive: true });
    await initDb(ROOT);
  });

  afterEach(async () => {
    await closeDb();
    await fs.rm(ROOT, { recursive: true, force: true });
  });

  it('exists, is keyed by item alone, and carries no workspace', async () => {
    const columns = await getClient().execute('PRAGMA table_info(cloud_excluded)');
    const names = columns.rows.map(row => String(row.name)).sort();
    expect(names).toEqual(['excluded_at', 'item_id', 'reason']);

    const pk = columns.rows.filter(row => Number(row.pk) > 0).map(row => String(row.name));
    expect(pk).toEqual(['item_id']);
  });

  it('rejects a second row for the same item', async () => {
    await getClient().execute({
      sql: 'INSERT INTO cloud_excluded (item_id, excluded_at) VALUES (?, ?)',
      args: ['item-1', '2026-08-11T00:00:00.000Z'],
    });
    await expect(getClient().execute({
      sql: 'INSERT INTO cloud_excluded (item_id, excluded_at) VALUES (?, ?)',
      args: ['item-1', '2026-08-11T00:00:01.000Z'],
    })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm.cmd test -- tests/cloud/exclusions.test.ts`
Expected: FAIL — `no such table: cloud_excluded`.

- [ ] **Step 3: Add the table**

In `src/store/bootstrap.ts`, immediately after the `cloud_published` statement in `SCHEMA_STATEMENTS`:

```ts
  /**
   * Atoms this machine will never publish, whatever else happens.
   *
   * Keyed by item alone and NOT by workspace, deliberately. "Never share this" is a statement
   * about the atom -- a machine-local path, an environment quirk -- and `knowl store --local`
   * runs in repositories that are not connected to any workspace at all, so there would be no
   * workspace to key it under. A separate table rather than a state on `cloud_published` for
   * the same reason: that table's primary key includes the workspace.
   *
   * Machine-local like the ledger itself, and excluded from portable export for the same
   * reason (decision `ee191dd7db024bec`): it is local policy that says nothing about the
   * atom's content and must not follow it to another machine.
   */
  `CREATE TABLE IF NOT EXISTS cloud_excluded (
    item_id TEXT PRIMARY KEY,
    excluded_at TEXT NOT NULL,
    reason TEXT
  );`,
```

In `src/store/schema-version.ts`, replace `export const KNOWL_MIGRATION_LEVEL = 9;` with the comment below plus `= 10`:

```ts
/*
 * Level 10 adds `cloud_excluded` and `cloud_published.stage_state`.
 *
 * The table is additive on the same reasoning as levels 3, 4, 7 and 9: one new table, no
 * backfill possible or needed, because a store that has never excluded anything has nothing
 * to record.
 *
 * The COLUMN is why this level exists rather than riding on the table. `CREATE TABLE IF NOT
 * EXISTS` is a no-op on a store that already has `cloud_published` from level 7, so without
 * the bump every existing store would keep a ledger with no `stage_state` -- and `listStaged`
 * reads that column, so every push would either fail or, worse, read NULL as pending and
 * re-send atoms already published. `ensureLedgerStageState` backfills it, and the backfill
 * direction is deliberately fail-safe: see its docblock.
 */
export const KNOWL_MIGRATION_LEVEL = 10;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm.cmd test -- tests/cloud/exclusions.test.ts`
Expected: PASS, both cases.

- [ ] **Step 5: Commit**

```bash
git add src/store/bootstrap.ts src/store/schema-version.ts tests/cloud/exclusions.test.ts
git commit -m "feat(cloud): add cloud_excluded, keyed by item and not by workspace"
```

---

### Task 2: Reading and writing exclusions

**Files:**
- Create: `src/cloud/exclusions.ts`
- Test: `tests/cloud/exclusions.test.ts` (extend the file from Task 1)

**Interfaces:**
- Consumes: table `cloud_excluded` from Task 1
- Produces:
  - `excludeFromPublish(itemId: string, reason?: string | null): Promise<void>`
  - `clearExclusion(itemId: string): Promise<void>`
  - `isExcluded(itemId: string): Promise<boolean>`
  - `listExcluded(): Promise<Array<{ itemId: string; excludedAt: string; reason: string | null }>>`
  - `filterExcluded(itemIds: string[]): Promise<string[]>` — returns the ids that are NOT excluded, preserving order

`filterExcluded` exists because Plan C's auto-stage seam and the category sweep both need to remove excluded ids from a batch, and doing it with one query rather than N is the difference between a sweep costing one round trip and costing hundreds.

- [ ] **Step 1: Write the failing test**

Append to `tests/cloud/exclusions.test.ts`, inside the same `describe`:

```ts
  it('excludes, reports, lists and clears', async () => {
    const { clearExclusion, excludeFromPublish, isExcluded, listExcluded } =
      await import('../../src/cloud/exclusions.js');

    expect(await isExcluded('item-1')).toBe(false);

    await excludeFromPublish('item-1', 'machine-local path');
    expect(await isExcluded('item-1')).toBe(true);

    const listed = await listExcluded();
    expect(listed).toHaveLength(1);
    expect(listed[0].itemId).toBe('item-1');
    expect(listed[0].reason).toBe('machine-local path');
    expect(listed[0].excludedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await clearExclusion('item-1');
    expect(await isExcluded('item-1')).toBe(false);
    expect(await listExcluded()).toEqual([]);
  });

  it('excluding twice is idempotent rather than an error', async () => {
    const { excludeFromPublish, listExcluded } = await import('../../src/cloud/exclusions.js');

    await excludeFromPublish('item-1', 'first');
    await excludeFromPublish('item-1', 'second');

    const listed = await listExcluded();
    expect(listed).toHaveLength(1);
    // The later reason wins: re-excluding is a restatement, and the newer explanation is the
    // one the user just gave.
    expect(listed[0].reason).toBe('second');
  });

  it('filterExcluded removes excluded ids and preserves order', async () => {
    const { excludeFromPublish, filterExcluded } = await import('../../src/cloud/exclusions.js');

    await excludeFromPublish('b');
    expect(await filterExcluded(['a', 'b', 'c'])).toEqual(['a', 'c']);
    expect(await filterExcluded([])).toEqual([]);
  });

  it('clearing an exclusion that was never set is a no-op, not an error', async () => {
    const { clearExclusion } = await import('../../src/cloud/exclusions.js');
    await expect(clearExclusion('never-seen')).resolves.toBeUndefined();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm.cmd test -- tests/cloud/exclusions.test.ts`
Expected: FAIL — cannot resolve `../../src/cloud/exclusions.js`.

- [ ] **Step 3: Write the implementation**

Create `src/cloud/exclusions.ts`:

```ts
import { getClient } from '../store/database.js';

export type ExclusionRecord = {
  itemId: string;
  excludedAt: string;
  reason: string | null;
};

/**
 * Never publish this atom, whatever else happens.
 *
 * Workspace-independent by design: this runs from `knowl store --local` in repositories that
 * may not be connected to anything, and "machine-local knowledge" is a fact about the atom
 * rather than about one team.
 *
 * Idempotent, with the newer reason winning. Re-excluding something already excluded is a
 * restatement of the same intent, and failing it would make `--local` unusable on a second edit.
 */
export async function excludeFromPublish(itemId: string, reason: string | null = null): Promise<void> {
  await getClient().execute({
    sql: `INSERT INTO cloud_excluded (item_id, excluded_at, reason)
          VALUES (?, ?, ?)
          ON CONFLICT (item_id) DO UPDATE SET
            excluded_at = excluded.excluded_at,
            reason = excluded.reason`,
    args: [itemId, new Date().toISOString(), reason],
  });
}

/**
 * Withdraw an exclusion. Does not stage anything.
 *
 * Deleting the row rather than tombstoning it: an exclusion carries no history worth keeping,
 * and unlike `remote_version` there is nothing here that only this machine knows.
 */
export async function clearExclusion(itemId: string): Promise<void> {
  await getClient().execute({
    sql: 'DELETE FROM cloud_excluded WHERE item_id = ?',
    args: [itemId],
  });
}

export async function isExcluded(itemId: string): Promise<boolean> {
  const result = await getClient().execute({
    sql: 'SELECT 1 FROM cloud_excluded WHERE item_id = ?',
    args: [itemId],
  });
  return result.rows.length > 0;
}

export async function listExcluded(): Promise<ExclusionRecord[]> {
  const result = await getClient().execute(
    'SELECT item_id, excluded_at, reason FROM cloud_excluded ORDER BY excluded_at, item_id',
  );
  return result.rows.map(row => ({
    itemId: String(row.item_id),
    excludedAt: String(row.excluded_at),
    reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
  }));
}

/**
 * The ids that may still be staged, in the order given.
 *
 * One query rather than one per id: the category sweep and the auto-stage seam both call this
 * with a whole batch, and a per-id check turns a sweep into hundreds of round trips.
 */
export async function filterExcluded(itemIds: string[]): Promise<string[]> {
  if (itemIds.length === 0) return [];
  const placeholders = itemIds.map(() => '?').join(', ');
  const result = await getClient().execute({
    sql: `SELECT item_id FROM cloud_excluded WHERE item_id IN (${placeholders})`,
    args: itemIds,
  });
  const excluded = new Set(result.rows.map(row => String(row.item_id)));
  return itemIds.filter(itemId => !excluded.has(itemId));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm.cmd test -- tests/cloud/exclusions.test.ts`
Expected: PASS, all six cases.

- [ ] **Step 5: Commit**

```bash
git add src/cloud/exclusions.ts tests/cloud/exclusions.test.ts
git commit -m "feat(cloud): read and write publication exclusions"
```

---

### Task 3: The `stage_state` column and its fail-safe backfill

**Files:**
- Modify: `src/store/bootstrap.ts` — add `ensureLedgerStageState()` beside `ensureForgetLogColumns` (near line 685), and call it at line 1095 with the other `ensure*` migrations
- Test: `tests/store/migration-level-10.test.ts`

**Interfaces:**
- Produces: `cloud_published.stage_state TEXT NOT NULL DEFAULT 'clear'`, values `'pending' | 'clear'`

**The backfill direction is the whole point of this task.** Adding the column with `DEFAULT 'pending'` would mark every already-pushed row as queued, and the next push would re-send a machine's entire publication history. The default is `'clear'` and rows are promoted to `'pending'` only where the old predicate said they were staged — so a partially-applied or unmigrated row fails toward sending nothing, which is the recoverable direction.

- [ ] **Step 1: Write the failing test**

Create `tests/store/migration-level-10.test.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';

const ROOT = path.resolve('./.knowl-migration-10-root');

/** A ledger row as level 7 wrote it, with no `stage_state` at all. */
async function insertLegacyRow(input: {
  itemId: string;
  pushedAt: string | null;
  retractedAt: string | null;
  remoteVersion: number | null;
}): Promise<void> {
  await getClient().execute({
    sql: `INSERT INTO cloud_published
            (item_id, remote_workspace, remote_version, staged_at, staged_on_branch, pushed_at, retracted_at)
          VALUES (?, 'ws-1', ?, '2026-08-01T00:00:00.000Z', 'main', ?, ?)`,
    args: [input.itemId, input.remoteVersion, input.pushedAt, input.retractedAt],
  });
}

describe('migration level 10 backfill', () => {
  beforeEach(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(ROOT, { recursive: true });
    await initDb(ROOT);
  });

  afterEach(async () => {
    await closeDb();
    await fs.rm(ROOT, { recursive: true, force: true });
  });

  it('maps the old three-column predicate onto explicit states', async () => {
    await insertLegacyRow({ itemId: 'staged', pushedAt: null, retractedAt: null, remoteVersion: null });
    await insertLegacyRow({ itemId: 'pushed', pushedAt: '2026-08-02T00:00:00.000Z', retractedAt: null, remoteVersion: 3 });
    await insertLegacyRow({ itemId: 'retracted', pushedAt: '2026-08-02T00:00:00.000Z', retractedAt: '2026-08-03T00:00:00.000Z', remoteVersion: null });

    const { backfillLedgerStageState } = await import('../../src/store/bootstrap.js');
    await backfillLedgerStageState(getClient());

    const rows = await getClient().execute(
      'SELECT item_id, stage_state FROM cloud_published ORDER BY item_id',
    );
    const states = Object.fromEntries(rows.rows.map(row => [String(row.item_id), String(row.stage_state)]));

    expect(states).toEqual({ pushed: 'clear', retracted: 'clear', staged: 'pending' });
  });

  it('never promotes a pushed row to pending, because that would re-send published history', async () => {
    await insertLegacyRow({ itemId: 'pushed', pushedAt: '2026-08-02T00:00:00.000Z', retractedAt: null, remoteVersion: 9 });

    const { backfillLedgerStageState } = await import('../../src/store/bootstrap.js');
    await backfillLedgerStageState(getClient());

    const rows = await getClient().execute(
      "SELECT COUNT(*) AS n FROM cloud_published WHERE stage_state = 'pending'",
    );
    expect(Number(rows.rows[0].n)).toBe(0);
  });

  it('preserves remote_version through the migration', async () => {
    await insertLegacyRow({ itemId: 'pushed', pushedAt: '2026-08-02T00:00:00.000Z', retractedAt: null, remoteVersion: 42 });

    const { backfillLedgerStageState } = await import('../../src/store/bootstrap.js');
    await backfillLedgerStageState(getClient());

    const rows = await getClient().execute(
      "SELECT remote_version FROM cloud_published WHERE item_id = 'pushed'",
    );
    expect(Number(rows.rows[0].remote_version)).toBe(42);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm.cmd test -- tests/store/migration-level-10.test.ts`
Expected: FAIL — `backfillLedgerStageState` is not exported from `bootstrap.js`.

- [ ] **Step 3: Write the implementation**

In `src/store/bootstrap.ts`, add the `stage_state` column to the `cloud_published` statement in `SCHEMA_STATEMENTS` (so new stores get it directly):

```ts
    stage_state TEXT NOT NULL DEFAULT 'clear',
```

Place it immediately after `retracted_at TEXT,` and before `PRIMARY KEY (item_id, remote_workspace)`.

Then add these two functions beside the other `ensure*` migrations (after `ensureForgetLogColumns`, around line 697):

```ts
/**
 * The ledger's explicit staging state, for a store that already has the table from level 7.
 *
 * Split from `ensureLedgerStageState` so a test can exercise the backfill directly against rows
 * it controls. The column add is the part that must not run twice; the UPDATE is idempotent.
 */
export async function backfillLedgerStageState(client: Client): Promise<void> {
  // Exactly the predicate `listStaged` used before this column existed. A row that satisfied it
  // was staged and unsent; everything else was pushed, retracted, or both.
  await client.execute(
    `UPDATE cloud_published SET stage_state = 'pending'
     WHERE pushed_at IS NULL AND retracted_at IS NULL`,
  );
}

/**
 * Add `stage_state` and derive it from the columns that used to imply it.
 *
 * **The default is `'clear'` and that direction is load-bearing.** `DEFAULT 'pending'` would mark
 * every already-pushed row as queued, and the next `knowl cloud push` would re-send this
 * machine's entire publication history -- irreversibly, since the only way back is a retraction
 * per atom. Defaulting to `'clear'` means a row this migration somehow misses sends nothing,
 * which `knowl cloud stage` can repair; the other direction has no repair.
 *
 * `pushed_at` stops being overloaded once this lands: it goes back to meaning "when this was last
 * successfully pushed" and is no longer nulled to signal a re-stage. That is what makes `unstage`
 * expressible without deleting the row -- and the row holds `remote_version`, the only copy of
 * the server's version on this machine.
 */
async function ensureLedgerStageState(client: Client): Promise<void> {
  if (!(await tableExists(client, 'cloud_published'))) return;
  const columns = await tableColumns(client, 'cloud_published');
  if (columns.includes('stage_state')) return;

  await client.execute(
    "ALTER TABLE cloud_published ADD COLUMN stage_state TEXT NOT NULL DEFAULT 'clear';",
  );
  await backfillLedgerStageState(client);
}
```

Wire it in beside the others, after line 1095 (`await ensureForgetLogColumns(client);`):

```ts
    await ensureLedgerStageState(client);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm.cmd test -- tests/store/migration-level-10.test.ts`
Expected: PASS, all three cases.

- [ ] **Step 5: Commit**

```bash
git add src/store/bootstrap.ts tests/store/migration-level-10.test.ts
git commit -m "feat(cloud): give the ledger an explicit stage state, backfilled fail-safe"
```

---

### Task 4: Move the ledger onto the explicit state

**Files:**
- Modify: `src/cloud/ledger.ts` — `restageForPublish`, `listStaged`, `recordPushed`, `stageForPublish`; add `unstagePublish`
- Test: `tests/cloud/ledger.test.ts`

**Interfaces:**
- Consumes: `cloud_published.stage_state` from Task 3; `filterExcluded` from Task 2
- Produces:
  - `unstagePublish(itemId: string, workspace: string): Promise<boolean>` — true if a pending row was cleared
  - `PublishedRecord` gains `stageState: 'pending' | 'clear'`

**Behavioural refinement this task settles.** `stageForPublish` currently uses `ON CONFLICT DO NOTHING`, which means a sweep skips *any* existing row. Once `unstage` exists, a row can be `clear` and never pushed — and a later sweep should stage it, because a sweep means "publish what is not published" and that atom is not published. The conflict clause therefore updates rows whose `pushed_at IS NULL` and leaves pushed rows alone.

- [ ] **Step 1: Write the failing test**

Append to `tests/cloud/ledger.test.ts`, inside the existing top-level `describe`:

```ts
  it('unstage clears a pending row without touching remote_version', async () => {
    const {
      listStaged, publishedVersion, recordPushed, restageForPublish, stageForPublish, unstagePublish,
    } = await import('../../src/cloud/ledger.js');

    await stageForPublish(['a'], WS, 'main');
    await recordPushed('a', WS, 7);
    await restageForPublish(['a'], WS, 'main');
    expect(await listStaged(WS)).toHaveLength(1);

    expect(await unstagePublish('a', WS)).toBe(true);
    expect(await listStaged(WS)).toHaveLength(0);

    // The invariant: unstaging is not a retraction, so the server's version survives.
    expect(await publishedVersion('a', WS)).toBe(7);
  });

  it('unstage reports false when nothing was pending', async () => {
    const { unstagePublish } = await import('../../src/cloud/ledger.js');
    expect(await unstagePublish('never-staged', WS)).toBe(false);
  });

  it('a re-stage preserves pushed_at instead of nulling it', async () => {
    const { recordPushed, restageForPublish, stageForPublish } = await import('../../src/cloud/ledger.js');
    const { getClient } = await import('../../src/store/database.js');

    await stageForPublish(['a'], WS, 'main');
    await recordPushed('a', WS, 1);
    await restageForPublish(['a'], WS, 'main');

    const rows = await getClient().execute({
      sql: 'SELECT pushed_at, stage_state FROM cloud_published WHERE item_id = ? AND remote_workspace = ?',
      args: ['a', WS],
    });
    expect(rows.rows[0].pushed_at).not.toBeNull();
    expect(String(rows.rows[0].stage_state)).toBe('pending');
  });

  it('a sweep re-stages an unstaged atom that was never pushed, and skips a pushed one', async () => {
    const { listStaged, recordPushed, stageForPublish, unstagePublish } =
      await import('../../src/cloud/ledger.js');

    await stageForPublish(['never-pushed'], WS, 'main');
    await unstagePublish('never-pushed', WS);

    await stageForPublish(['already-pushed'], WS, 'main');
    await recordPushed('already-pushed', WS, 2);

    await stageForPublish(['never-pushed', 'already-pushed'], WS, 'main');

    const staged = (await listStaged(WS)).map(row => row.itemId);
    expect(staged).toEqual(['never-pushed']);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm.cmd test -- tests/cloud/ledger.test.ts`
Expected: FAIL — `unstagePublish` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/cloud/ledger.ts`:

Add to `PublishedRecord`, after `retractedAt`:

```ts
  /** Explicit since level 10. `pending` is what a push works through. */
  stageState: 'pending' | 'clear';
```

Add to `toRecord`, after `retractedAt`:

```ts
    stageState: String(row.stage_state) === 'pending' ? 'pending' : 'clear',
```

Replace the `INSERT` in `stageForPublish` with:

```ts
      sql: `INSERT INTO cloud_published (item_id, remote_workspace, staged_at, staged_on_branch, stage_state)
            VALUES (?, ?, ?, ?, 'pending')
            ON CONFLICT (item_id, remote_workspace) DO UPDATE SET
              staged_at = excluded.staged_at,
              staged_on_branch = excluded.staged_on_branch,
              stage_state = 'pending'
            WHERE cloud_published.pushed_at IS NULL`,
```

Replace the `INSERT` in `restageForPublish` with:

```ts
      sql: `INSERT INTO cloud_published (item_id, remote_workspace, staged_at, staged_on_branch, stage_state)
            VALUES (?, ?, ?, ?, 'pending')
            ON CONFLICT (item_id, remote_workspace) DO UPDATE SET
              staged_at = excluded.staged_at,
              staged_on_branch = excluded.staged_on_branch,
              stage_state = 'pending',
              retracted_at = NULL`,
```

Note what left that clause: `pushed_at = NULL`. It is gone deliberately — the state now says "pending" and `pushed_at` keeps its meaning. Update the function's docblock to say so, replacing the paragraph beginning "`remote_version` is deliberately NOT cleared" with:

```ts
 * Neither `remote_version` nor `pushed_at` is cleared. The version is the only copy of that
 * number on this machine and the republish this call exists to enable is exactly what needs it.
 * `pushed_at` used to be nulled here to signal "staged again", which destroyed the record of when
 * the atom was last sent and left `unstage` with nothing to restore -- `stage_state` carries that
 * signal now.
```

Replace `listStaged`'s SQL:

```ts
    sql: `SELECT * FROM cloud_published
          WHERE remote_workspace = ? AND stage_state = 'pending' AND retracted_at IS NULL
          ORDER BY staged_at, item_id`,
```

Replace `recordPushed`'s SQL:

```ts
    sql: `UPDATE cloud_published SET remote_version = ?, pushed_at = ?, stage_state = 'clear'
          WHERE item_id = ? AND remote_workspace = ?`,
```

Add at the end of the file:

```ts
/**
 * Take an atom out of the queue without unpublishing it.
 *
 * Never `DELETE`. The row holds `remote_version`, the only copy of the server's version on this
 * machine, and knowl-cloud treats a republish arriving without `expectedVersion` as a conflict by
 * design -- so deleting the row to unstage a correction would leave the atom unpushable
 * afterwards. Clearing the state is the whole operation.
 *
 * Returns whether anything was actually pending, so a caller can tell "unstaged" from "there was
 * nothing to unstage" rather than reporting success for a no-op.
 */
export async function unstagePublish(itemId: string, workspace: string): Promise<boolean> {
  const result = await getClient().execute({
    sql: `UPDATE cloud_published SET stage_state = 'clear'
          WHERE item_id = ? AND remote_workspace = ? AND stage_state = 'pending'`,
    args: [itemId, workspace],
  });
  return Number(result.rowsAffected ?? 0) > 0;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm.cmd test -- tests/cloud/ledger.test.ts`
Expected: PASS — the four new cases plus every pre-existing case in the file, unmodified.

If a pre-existing case fails, do not edit it to match. It is pinning behaviour this task was not meant to change; re-read the SQL above against what it asserts.

- [ ] **Step 5: Commit**

```bash
git add src/cloud/ledger.ts tests/cloud/ledger.test.ts
git commit -m "feat(cloud): unstage clears state instead of deleting the row that holds remote_version"
```

---

### Task 5: Prove the invariant end to end

**Files:**
- Test: `tests/cloud/ledger-invariant.test.ts` (create)

**Interfaces:**
- Consumes: everything from Tasks 1–4

This is spec §12.6, written as its own task because it is the assertion the whole plan exists to make true, and it must fail loudly if any later plan regresses it. It asserts the column directly rather than only the outcome — a regression here otherwise surfaces as a server-side conflict far from its cause.

- [ ] **Step 1: Write the test**

Create `tests/cloud/ledger-invariant.test.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import {
  publishedVersion, recordPushed, recordRetracted, restageForPublish, stageForPublish, unstagePublish,
} from '../../src/cloud/ledger.js';

const ROOT = path.resolve('./.knowl-ledger-invariant-root');
const WS = 'ws-invariant';

async function storedVersion(itemId: string): Promise<unknown> {
  const rows = await getClient().execute({
    sql: 'SELECT remote_version FROM cloud_published WHERE item_id = ? AND remote_workspace = ?',
    args: [itemId, WS],
  });
  return rows.rows[0]?.remote_version;
}

describe('remote_version is written by push and cleared only by retract', () => {
  beforeEach(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(ROOT, { recursive: true });
    await initDb(ROOT);
  });

  afterEach(async () => {
    await closeDb();
    await fs.rm(ROOT, { recursive: true, force: true });
  });

  it('survives the full edit / unstage / edit / push cycle', async () => {
    await stageForPublish(['a'], WS, 'main');
    expect(await storedVersion('a')).toBeNull();

    await recordPushed('a', WS, 4);
    expect(Number(await storedVersion('a'))).toBe(4);

    // Edit -> re-stage -> change your mind -> edit again -> re-stage.
    await restageForPublish(['a'], WS, 'main');
    expect(Number(await storedVersion('a'))).toBe(4);

    await unstagePublish('a', WS);
    expect(Number(await storedVersion('a'))).toBe(4);

    await restageForPublish(['a'], WS, 'main');
    expect(Number(await storedVersion('a'))).toBe(4);

    // The second push must still be able to declare what it expects to overwrite.
    expect(await publishedVersion('a', WS)).toBe(4);
  });

  it('is cleared by retraction, and only by retraction', async () => {
    await stageForPublish(['a'], WS, 'main');
    await recordPushed('a', WS, 4);

    await recordRetracted('a', WS);
    expect(await storedVersion('a')).toBeNull();
  });

  it('a sweep never blanks the version of a pushed atom', async () => {
    await stageForPublish(['a'], WS, 'main');
    await recordPushed('a', WS, 11);

    await stageForPublish(['a'], WS, 'main');
    expect(Number(await storedVersion('a'))).toBe(11);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npm.cmd test -- tests/cloud/ledger-invariant.test.ts`
Expected: PASS, all three cases. If any fails, the fault is in Task 4's SQL, not in this test.

- [ ] **Step 3: Run the whole suite**

Run: `npm.cmd run build` then `npm.cmd test`
Expected: everything green. The migration level changed, so cases that assert schema shape or migration level will run — any failure there is real and must be fixed, not skipped.

- [ ] **Step 4: Check the diff and commit**

```bash
git diff --check
git add tests/cloud/ledger-invariant.test.ts
git commit -m "test(cloud): pin the remote_version invariant across the whole edit cycle"
```

---

## What Plan A deliberately does not do

- **No CLI changes.** `knowl cloud unstage`, `knowl store --local` and the rest of the surface are Plan B and Plan D. This plan makes them possible and stops there.
- **No auto-staging.** The seam, `cloud.autoStage`, the machine-local auto-push consent and the snapshot-bound confirmation are Plan C, which consumes `filterExcluded` and `unstagePublish` from here.
- **No `visibility` change.** Per §5.1 and decision `ee191dd7db024bec`, that column keeps its exact meaning.

## Follow-on plans

| Plan | Scope | Depends on |
| --- | --- | --- |
| **B — namespace and status** | Every cloud verb under `knowl cloud`, `publish`→`stage`, login short-circuit, connect picker, `workspaces`, status consolidation, `CloudApi.me()` and identity caching | A (status reports the staged split) |
| **C — automatic staging** | The post-commit seam and its exclusions, `cloud.autoStage`, machine-local auto-push consent, snapshot-bound push confirmation, `MAX_BATCH` | A, B |
| **D — surface cleanup** | `knowl store` / `park` / `handoff`, one-leaf flattening, MCP tool descriptions, guidance regeneration, knowl-cloud web copy and e2e tests | B (shares the rename wave) |
</content>
