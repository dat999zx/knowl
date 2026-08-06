# Knowl 3.0.2 Recovery and Trust Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the critical silent-total-data-loss path in `knowl snapshot restore`, make snapshot table ownership an explicit and CI-enforced contract, and make imported skill packages land inside the trusted tree as whole atomic directories.

**Architecture:** Four surfaces, in dependency order. Snapshot restore gains a refusal guard (an attachment with no `knowledge_items` is never a restore), stops pruning the file it was asked to restore, and verifies the exact bytes it attaches by copying the source out of reach first. Snapshot table ownership moves from an implicit one-level foreign-key derivation to an explicit registry with a transitive closure and a CI gate that fails when a new table is unclassified. Skill import stops merging files into a live package directory and instead builds each package in a staging directory Knowl created itself, then swaps whole directories, refusing symlink and junction parents.

**Tech Stack:** TypeScript (ESM, `node:` builtins), vitest, `@libsql/client`, SQLite.

## Global Constraints

- Baseline is **3.0.1** at commit `36c7471`. Every line reference below was read from that tree; re-check with `grep` before editing if the tree has moved.
- Node `>=22`; no `engines` change. No new runtime dependency.
- Test roots follow the existing convention: `path.resolve('./.knowl-<name>-test')`, created in `beforeAll`, removed in `afterAll`.
- Use `KNOWL_SCHEMA_VERSION` from `src/store/schema-version.ts`; never hardcode a version.
- Commit messages use Conventional Commits.
- Development host is Windows; CI is `ubuntu-latest`. Gate platform-specific tests with `it.skipIf` / `it.runIf`, but note that **the symlink tests in Task 6 must run on both** — Windows junctions and POSIX symlinks are different reparse mechanisms and the fix must handle both.
- `PRAGMA foreign_keys = ON` is set at `src/store/bootstrap.ts:22`. Every `DELETE` in the restore path cascades. Assume it.

## Evidence base

Findings, verdicts, and reproductions are in
[docs/audit-2026-08-05-verified.md](../../audit-2026-08-05-verified.md), which verifies and
corrects [docs/audit-2026-08-05-external-review.md](../../audit-2026-08-05-external-review.md).
Do not re-derive them; do re-run the probes if the tree has moved.

## Two facts measured on Windows that the implementation depends on

Both were measured on the development host with Node 24. Neither is obvious, and getting either
wrong produces a fix that appears to work and does not.

1. **`fs.lstat().isSymbolicLink()` returns `true` for a Windows directory junction.** A junction
   is a reparse point, not a symlink, but Node reports it as one — and `isDirectory()` returns
   `false` for it. So a single `lstat` check covers POSIX symlinks and Windows junctions
   together. Junctions need no elevation to create, so this is a real reachable path, not a
   theoretical one.

2. **`fs.rename(stagingDir, existingNonEmptyDir)` fails with `EPERM` on Windows** (and
   `ENOTEMPTY`/`EEXIST` on POSIX). A directory swap therefore **cannot** be a single rename onto
   the live package. It must be: rename the live package aside to a backup name, rename staging
   into place, then delete the backup. Task 6 depends on this.

## Out of scope — already planned elsewhere

[2026-08-04-hardening-and-ci-3.2.0.md](2026-08-04-hardening-and-ci-3.2.0.md) already covers
hash-pinned skill approval with an environment allowlist and `timeout`/`maxBuffer` ceilings
(Task 1), bounded streaming JSONL import (Task 2), atomic owner-only config and diagnostics
writes (Task 3), generated README sections (Task 4), and CI gates (Task 5). The external
review's entire "v3.1 hardening" list is that plan. Do not duplicate it here.

**One item should be pulled forward if 3.1.0 slips:** the `timeout` on `spawnSync`
(`src/skills/registry.ts:268,296`). `spawnSync` blocks the Node event loop, so a skill that
never exits freezes the whole MCP server, not just its own call. It is a one-line change inside
3.1.0's Task 1; if that release is more than a few weeks out, land the `timeout` alone.

## Deferred with a decision point

**Whether `snapshot restore` should become a whole-file database replacement** rather than a
logical subset restore. The external review argues for it and the argument is sound. It is not
in this plan because it changes restore semantics, needs live-handle closing and `-wal`/`-shm`
reconciliation, and needs cross-platform rename testing — none of which belong in a hotfix that
exists to stop data loss. Task 5 makes the current partial semantics **explicit, complete and
CI-enforced**, which is the prerequisite for making that decision on evidence. Revisit in 3.1.0.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/store/snapshots.ts` | Snapshot create/restore | Modify: empty-attachment guard, source protection, verify-the-attached-bytes, transitive restore closure |
| `src/store/snapshot-tables.ts` | The restore table-ownership registry | Create |
| `src/store/retention.ts` | Retention policy | Modify: `pruneSnapshots` accepts a set of protected paths |
| `src/store/portability.ts` | JSONL export/import | Modify: per-package planning and whole-directory atomic install |
| `src/skills/registry.ts` | Skill execution | Modify: stop auto-running `fallback` |
| `tests/store/snapshot-restore-safety.test.ts` | Data-loss regressions | Create |
| `tests/store/snapshot-table-ownership.test.ts` | Registry completeness gate | Create |
| `tests/store/import-skill-containment.test.ts` | Symlink/junction and atomic-swap regressions | Create |
| `tests/skills/fallback-entrypoint.test.ts` | Unrequested-execution regression | Create |
| `README.md` | Docs | Modify: snapshot section |
| `package-lock.json` | Lockfile | Modify: version |
| `.github/workflows/ci.yml` | CI | Modify: lockfile-drift gate |
| `.github/workflows/cd.yml` | CD | Modify: npm provenance |

---

### Task 1: Refuse an attachment that holds no `knowledge_items`

This is the single load-bearing guard. `restoreStatements`
(`src/store/snapshots.ts:115-142`) builds its statement list from what it finds in
`snapshot_restore.sqlite_schema`. When that attachment is empty — which SQLite produces
silently, because `ATTACH` **creates** a missing database file rather than failing — `present`
is empty, so `dependents` and `standalone` are empty, and the emitted list degrades to exactly
one statement:

```sql
DELETE FROM knowledge_items
```

Every re-insert is skipped because `sharedColumns` finds no columns in the attachment and
`continue`s. The cascade takes assertions, evidence links, access, skill rows and embeddings
with it, and the post-restore integrity audit then affirms that the resulting empty store is
healthy. `restoreSnapshot` returns normally.

A restore that emits zero `INSERT` statements is not a restore. Refuse before anything is
deleted.

This guard alone closes the whole class, including routes Task 2 does not cover: a snapshot on
a disconnected network share, a file removed by another process, an operator typo that names a
path that does not exist.

**Files:**
- Modify: `src/store/snapshots.ts:115-142`
- Test: `tests/store/snapshot-restore-safety.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no new exports. `restoreStatements` keeps its signature `(client: Client) => Promise<string[]>` and gains a throw.

- [ ] **Step 1: Write the failing test**

Create `tests/store/snapshot-restore-safety.test.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { createSnapshot, restoreSnapshot } from '../../src/store/snapshots.js';

const TEST_ROOT = path.resolve('./.knowl-snapshot-restore-safety-test');

async function itemCount(): Promise<number> {
  return Number((await getClient().execute('SELECT count(*) AS n FROM knowledge_items')).rows[0]?.n ?? 0);
}

describe('snapshot restore safety', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
    const project = await repo.createProject(TEST_ROOT, 'Safety');
    await repo.createKnowledgeItem(project.id, { category: 'fact', title: 'Survivor', content: 'Still here.' });
  });

  beforeEach(async () => {
    await fs.rm(path.join(TEST_ROOT, '.knowl', 'snapshots'), { recursive: true, force: true });
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  // The pre-restore snapshot prunes to SNAPSHOT_KEEP and protects only itself, so the file
  // being restored is deleted before ATTACH reads it -- and ATTACH then creates it empty.
  it('never empties the store when the restore source is pruned out from under it', async () => {
    const oldest = await createSnapshot(TEST_ROOT);
    await new Promise(resolve => setTimeout(resolve, 20));
    await createSnapshot(TEST_ROOT);
    await new Promise(resolve => setTimeout(resolve, 20));
    await createSnapshot(TEST_ROOT);

    const before = await itemCount();
    expect(before).toBeGreaterThan(0);

    // Either it restores correctly or it refuses. What it must never do is succeed and
    // leave an empty store.
    await restoreSnapshot(TEST_ROOT, oldest.path, { confirm: true }).catch(() => {});

    expect(await itemCount()).toBe(before);
  });

  it('refuses a source path that does not exist rather than creating it', async () => {
    const before = await itemCount();
    const missing = path.join(TEST_ROOT, '.knowl', 'snapshots', 'not-there.db');
    await expect(restoreSnapshot(TEST_ROOT, missing, { confirm: true })).rejects.toThrow();
    expect(await itemCount()).toBe(before);
  });
});
```

- [ ] **Step 2: Run the test to verify the first case fails**

Run: `npx vitest run tests/store/snapshot-restore-safety.test.ts`

Expected: the first test FAILS with `expected +0 to be 1` — the store was emptied and the
restore reported success. The second test passes already (`fs.access` at
`src/store/snapshots.ts:220` catches a missing source).

- [ ] **Step 3: Add the guard**

In `src/store/snapshots.ts`, at the top of `restoreStatements`, immediately after `present` is
built (line 120):

```ts
  // ATTACH *creates* a missing database rather than failing, so an attachment can be a
  // perfectly valid empty file. Every table lookup below then finds nothing, the INSERT loop
  // skips every table for want of shared columns, and the statement list degrades to a bare
  // `DELETE FROM knowledge_items` -- which cascades through assertions, evidence links,
  // access, skill rows and embeddings and leaves a store the post-restore audit calls healthy.
  // A restore that inserts nothing is not a restore.
  if (!present.has('knowledge_items')) {
    throw new Error(
      'The attached snapshot holds no knowledge_items table, so there is nothing to restore. ' +
      'Refusing: continuing would delete the live store and insert nothing. ' +
      'The snapshot file was verified and then moved, removed, or replaced before it could be read.',
    );
  }
```

- [ ] **Step 4: Run the tests to verify both pass**

Run: `npx vitest run tests/store/snapshot-restore-safety.test.ts`

Expected: PASS. The first test now takes the refusal branch — the store is intact and
`restoreSnapshot` threw.

- [ ] **Step 5: Run the existing snapshot suite for regressions**

Run: `npx vitest run tests/store/snapshot-verification.test.ts`

Expected: PASS, unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/store/snapshots.ts tests/store/snapshot-restore-safety.test.ts
git commit -m "fix(snapshots): refuse an attachment with no knowledge_items instead of emptying the store"
```

---

### Task 2: Stop pruning the snapshot the user asked to restore

Task 1 turned the wipe into a refusal. This turns the refusal into a correct restore.

`restoreSnapshot` takes its pre-restore snapshot at `src/store/snapshots.ts:224`, and
`createSnapshot` ends in `pruneSnapshots(snapshotDir, SNAPSHOT_KEEP, snapshotPath)` (line 64).
`pruneSnapshots` protects exactly one path — the file it just wrote — and deletes everything
past the keep window (`src/store/retention.ts:206`). With `SNAPSHOT_KEEP = 3` and the new
snapshot holding one slot, only the **two newest** pre-existing snapshots survive. The restore
source is not protected, so restoring anything older than the second-newest deletes it, along
with its manifest.

Under the default retention that is the steady state: a user with three snapshots who wants to
go back furthest hits it every time.

**Files:**
- Modify: `src/store/retention.ts:176-218`
- Modify: `src/store/snapshots.ts:38-67,224`
- Test: `tests/store/snapshot-restore-safety.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1's guard (the test asserts a successful restore, which only distinguishes from a refusal once this task lands).
- Produces:
  - `pruneSnapshots(snapshotDir: string, keep?: number, protect?: string | string[]): Promise<string[]>` — `protect` now accepts an array; a single string still works.
  - `createSnapshot(projectRoot: string, options?: { protect?: string[] }): Promise<Snapshot>` — `options.protect` names extra files the prune must not delete.

- [ ] **Step 1: Write the failing test**

Append to `tests/store/snapshot-restore-safety.test.ts`, inside the same `describe`:

```ts
  it('restores the oldest snapshot and leaves it on disk', async () => {
    const project = (await repo.listProjects())[0];
    const oldest = await createSnapshot(TEST_ROOT);
    await new Promise(resolve => setTimeout(resolve, 20));
    await createSnapshot(TEST_ROOT);
    await new Promise(resolve => setTimeout(resolve, 20));
    await createSnapshot(TEST_ROOT);

    const expected = await itemCount();
    // Written after every snapshot, so a correct restore removes it.
    await repo.createKnowledgeItem(project.id, { category: 'fact', title: 'Later', content: 'Added after.' });
    expect(await itemCount()).toBe(expected + 1);

    await restoreSnapshot(TEST_ROOT, oldest.path, { confirm: true });

    expect(await itemCount()).toBe(expected);
    // The file the operator restored from is still there, with its manifest.
    expect((await fs.stat(oldest.path)).size).toBeGreaterThan(0);
    await expect(fs.stat(oldest.manifestPath)).resolves.toBeTruthy();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/store/snapshot-restore-safety.test.ts -t 'leaves it on disk'`

Expected: FAIL — Task 1's guard throws `The attached snapshot holds no knowledge_items table`,
because the source was pruned before `ATTACH`.

- [ ] **Step 3: Let `pruneSnapshots` protect a set**

Replace the body of `pruneSnapshots` in `src/store/retention.ts` (lines 176-218):

```ts
export async function pruneSnapshots(
  snapshotDir: string,
  keep = SNAPSHOT_KEEP,
  protect?: string | string[],
): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(snapshotDir);
  } catch {
    return [];
  }

  const protectedPaths = new Set(
    (protect === undefined ? [] : Array.isArray(protect) ? protect : [protect]).map(one => path.resolve(one)),
  );

  // Counted rather than taken from the set's size: a protected path can name a snapshot
  // outside this directory -- `snapshot restore` accepts any path -- and one that is not here
  // is not occupying a slot here.
  let protectedHere = 0;
  const snapshots: Array<{ file: string; mtimeMs: number; name: string }> = [];
  for (const name of names) {
    // Shape, not everything in the directory: a file a human parked here is not ours.
    if (!name.endsWith('.db')) continue;
    const file = path.join(snapshotDir, name);
    if (protectedPaths.has(path.resolve(file))) { protectedHere += 1; continue; }
    try {
      snapshots.push({ file, name, mtimeMs: (await fs.stat(file)).mtimeMs });
    } catch {
      // Gone already.
    }
  }

  snapshots.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));

  const removed: string[] = [];
  // Every protected snapshot in this directory occupies one of the kept slots, because it is
  // a snapshot too.
  for (const stale of snapshots.slice(Math.max(keep - protectedHere, 0))) {
    try {
      await fs.rm(stale.file, { force: true });
      // A manifest never outlives its snapshot: an orphan manifest is a checksum for a file
      // that is not there, which reads as corruption.
      await fs.rm(`${stale.file}.manifest.json`, { force: true });
      removed.push(stale.file);
    } catch {
      // Locked or already gone; the next snapshot will try again.
    }
  }
  return removed;
}
```

Update the doc comment above it (lines 169-175) — replace the last sentence with:

```
 * `protect` names snapshots this prune must not take: the one being written right now, and --
 * during a restore -- the one being restored from. Naming the second is not politeness. The
 * prune runs between the restore's manifest check and its ATTACH, so deleting the source there
 * left ATTACH to create an empty database in its place and the restore to delete a store it
 * could not refill.
```

- [ ] **Step 4: Let `createSnapshot` forward extra protected paths**

In `src/store/snapshots.ts`, change the signature at line 38 and the prune call at line 64:

```ts
export async function createSnapshot(
  projectRoot: string,
  options: { protect?: string[] } = {},
): Promise<Snapshot> {
```

```ts
  const pruned = await pruneSnapshots(snapshotDir, SNAPSHOT_KEEP, [snapshotPath, ...(options.protect ?? [])]);
```

- [ ] **Step 5: Protect the source at the restore call site**

In `restoreSnapshot`, at `src/store/snapshots.ts:224`:

```ts
  // The source is named as protected because this prune runs between the manifest check above
  // and the ATTACH below. Without it, restoring anything but the two newest snapshots deleted
  // the very file being restored.
  const preRestore = await createSnapshot(root, { protect: [source] });
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/store/snapshot-restore-safety.test.ts tests/store/snapshot-verification.test.ts`

Expected: PASS, all cases. The first test now restores rather than refusing, and still asserts
the store is not emptied.

- [ ] **Step 7: Run the retention suite**

Run: `npx vitest run tests/store -t 'prune'`

Expected: PASS. `pruneSnapshots` is backward compatible — a single string `protect` still works.

- [ ] **Step 8: Commit**

```bash
git add src/store/retention.ts src/store/snapshots.ts tests/store/snapshot-restore-safety.test.ts
git commit -m "fix(snapshots): protect the restore source from the pre-restore prune"
```

---

### Task 3: Verify the bytes that are actually attached

Tasks 1 and 2 close the reachable data-loss path. This closes the shape that produced it.

`verifySnapshotManifest` proves the file on disk at `src/store/snapshots.ts:222`. `ATTACH`
reads that path again at line 227. Between the two, Knowl performs a `VACUUM INTO`, a `stat`, a
SHA-256, a file write and a directory prune — and any other process can do anything at all. The
proof is stale by the time it is used, which is what turned a pruned file into a wiped store.

The fix is check-then-use on the same bytes: copy the source somewhere nothing else reaches,
verify the copy, attach the copy. As a bonus this fixes the concern already noted in the
comment at lines 229-230 — WAL sidecars now land beside a throwaway copy rather than beside a
file Knowl is only supposed to read.

**Files:**
- Modify: `src/store/snapshots.ts:182-208,210-261`
- Test: `tests/store/snapshot-restore-safety.test.ts` (extend)

**Interfaces:**
- Consumes: Task 2's `createSnapshot(root, { protect })`.
- Produces: `verifySnapshotManifest` is split into two internal helpers. Neither is exported; the `SnapshotManifest` type and `restoreSnapshot`'s signature are unchanged.

- [ ] **Step 1: Write the failing test**

Append to `tests/store/snapshot-restore-safety.test.ts`:

```ts
  it('attaches the bytes it verified, not the path it verified', async () => {
    const project = (await repo.listProjects())[0];
    const snapshot = await createSnapshot(TEST_ROOT);
    const expected = await itemCount();
    await repo.createKnowledgeItem(project.id, { category: 'fact', title: 'Later', content: 'Added after.' });

    // Stand in for anything that can touch the file between check and use: another process,
    // a sync client, an operator. Replaced *after* creation, so the manifest still describes
    // the original bytes.
    const decoy = path.join(TEST_ROOT, '.knowl', 'decoy.db');
    await fs.writeFile(decoy, '');
    const original = await fs.readFile(snapshot.path);

    const swap = (async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      await fs.writeFile(snapshot.path, await fs.readFile(decoy));
    })();

    await Promise.allSettled([restoreSnapshot(TEST_ROOT, snapshot.path, { confirm: true }), swap]);

    // Whatever happened, the store is never left empty by a file swapped mid-restore.
    expect(await itemCount()).toBeGreaterThan(0);
    await fs.writeFile(snapshot.path, original);
  });
```

- [ ] **Step 2: Run the test to verify it is flaky-to-failing before the fix**

Run: `npx vitest run tests/store/snapshot-restore-safety.test.ts -t 'bytes it verified'`

Expected: this test is timing-dependent by nature and may pass by luck before the fix. Do not
treat a pass here as proof. The deterministic proof is Task 1's guard plus the fact that after
this task the copy is unreachable by name. Run it three times; it must pass all three after the
fix and must never leave the store empty.

- [ ] **Step 3: Split manifest reading from byte verification**

In `src/store/snapshots.ts`, replace `verifySnapshotManifest` (lines 182-208) with:

```ts
/**
 * Read and range-check the sidecar manifest. Says nothing about the bytes.
 *
 * A checksum proves the bytes are intact, not who wrote them: whoever produces a snapshot can
 * compute a valid checksum for it. This is an integrity check against corruption and truncated
 * copies, and it does not claim more. What it must not do is pass silently -- the manifest was
 * previously optional, so a snapshot with none was restored with no verification at all, which
 * is the one situation where the previous state is already gone.
 */
async function readSnapshotManifest(source: string): Promise<SnapshotManifest> {
  const manifestPath = `${source}.manifest.json`;
  let manifest: SnapshotManifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as SnapshotManifest;
  } catch (error: any) {
    throw new Error(error.code === 'ENOENT'
      ? `Snapshot manifest "${manifestPath}" was not found. Restore requires the manifest written beside the snapshot.`
      : `Snapshot manifest "${manifestPath}" is unreadable: ${error.message}`);
  }

  if (!Number.isInteger(manifest.schemaVersion) || manifest.schemaVersion > KNOWL_SCHEMA_VERSION) {
    throw new Error(
      `Snapshot was written with schema version ${manifest.schemaVersion}; this build reads up to ` +
      `${KNOWL_SCHEMA_VERSION}. Upgrade Knowl before restoring it.`,
    );
  }
  return manifest;
}

/**
 * Prove one specific file matches a manifest.
 *
 * Separate from reading the manifest so the caller can verify the copy it is about to attach
 * rather than the path it read the manifest from. Those were the same call, and the gap
 * between them -- a VACUUM, a stat, a hash, a write and a directory prune -- was wide enough
 * that a pruned source became an empty ATTACH and a restore deleted a store it could not
 * refill.
 */
async function verifySnapshotBytes(file: string, manifest: SnapshotManifest): Promise<void> {
  const stat = await fs.stat(file);
  if (stat.size !== manifest.byteSize) {
    throw new Error(`Snapshot size ${stat.size} does not match its manifest size ${manifest.byteSize}.`);
  }
  if (manifest.sha256 !== await sha256(file)) {
    throw new Error('Snapshot checksum does not match its manifest.');
  }
}
```

- [ ] **Step 4: Copy, verify the copy, attach the copy**

In `restoreSnapshot`, replace lines 222-255 (from `await verifySnapshotManifest(source);` down
to and including the `finally` block) with:

```ts
  const manifest = await readSnapshotManifest(source);

  // Copied out of the snapshot directory before anything else runs, and everything after this
  // point reads the copy. `.knowl/` rather than `.knowl/snapshots/`, so the pre-restore
  // prune -- which matches on `.db` -- cannot see it. This is also why the WAL sidecars the
  // attachment creates land beside a throwaway file instead of beside a snapshot Knowl is
  // only supposed to read.
  const staged = path.join(path.dirname(destination), `.restore-${crypto.randomUUID().slice(0, 8)}.db`);
  await fs.copyFile(source, staged);

  try {
    await verifySnapshotBytes(staged, manifest);

    // The source is named as protected because this prune runs inside the restore. Without
    // it, restoring anything but the two newest snapshots deleted the very file being
    // restored -- and before the copy above, that deletion reached the file ATTACH was about
    // to open.
    const preRestore = await createSnapshot(root, { protect: [source] });
    const client = getClient();
    // ATTACH cannot run inside a transaction, so it stays outside the wrapper on both sides.
    await client.execute(`ATTACH DATABASE '${quoteSqlPath(staged)}' AS snapshot_restore`);
    try {
      const integrity = await client.execute('PRAGMA snapshot_restore.integrity_check');
      const verdict = String(integrity.rows[0]?.integrity_check ?? '');
      if (verdict !== 'ok') throw new Error(`Snapshot failed SQLite integrity_check: ${verdict}`);

      const stamped = Number((await client.execute('PRAGMA snapshot_restore.user_version')).rows[0]?.user_version ?? 0);
      if (stamped > KNOWL_SCHEMA_VERSION) {
        throw new Error(
          `Snapshot database is stamped with schema version ${stamped}; this build reads up to ` +
          `${KNOWL_SCHEMA_VERSION}. Upgrade Knowl before restoring it.`,
        );
      }

      // Through the shared wrapper rather than a raw BEGIN. A transaction belongs to the
      // connection and this process holds exactly one, so an unserialised BEGIN here could
      // interleave with any other writer into `BEGIN; BEGIN;` -- which SQLite refuses with
      // SQLITE_ERROR, not SQLITE_BUSY, so nothing retries it. Restore is the worst possible
      // place for a half-applied transaction.
      await withClientTransaction(async () => {
        for (const statement of await restoreStatements(client)) {
          await client.execute(statement);
        }
      });
    } finally {
      await client.execute('DETACH DATABASE snapshot_restore');
    }

    const report = await auditKnowledgeStore();
    if (report.findings.some(finding => finding.severity === 'error')) {
      throw new SnapshotRestoreAuditError(preRestore.path, report.findings);
    }
    return { preRestore, findings: report.findings };
  } finally {
    // Sidecars too: the attachment may have written them beside the copy.
    for (const suffix of ['', '-wal', '-shm']) {
      await fs.rm(`${staged}${suffix}`, { force: true }).catch(() => {});
    }
  }
```

Note the structural change: `preRestore` is now declared inside the `try`, so the `return` moves
inside it too. Delete the old trailing `const report = ...` / `return` block at lines 256-260.

- [ ] **Step 5: Run the tests three times**

Run: `npx vitest run tests/store/snapshot-restore-safety.test.ts tests/store/snapshot-verification.test.ts`

Repeat three times. Expected: PASS every time, and no `.restore-*.db` left behind:

```bash
ls .knowl-snapshot-restore-safety-test/.knowl/ 2>/dev/null | grep restore- && echo "LEAK" || echo "clean"
```

Expected: `clean` (the test root is removed in `afterAll`, so run the check mid-suite if you
want to see it; the `finally` above is what guarantees it).

- [ ] **Step 6: Commit**

```bash
git add src/store/snapshots.ts tests/store/snapshot-restore-safety.test.ts
git commit -m "fix(snapshots): verify and attach the same bytes by staging the source out of reach"
```

---

### Task 4: Restore the full dependency closure, including `evidence` and `knowledge_commit_items`

`restoreStatements` walks foreign keys exactly **one level** from `knowledge_items`
(`src/store/snapshots.ts:85-97`), then adds `knowledge_commits` as a hardcoded standalone. Two
concrete losses follow, both confirmed against the schema:

- **`knowledge_commit_items`** references `knowledge_commits`, not `knowledge_items`
  (`src/store/bootstrap.ts:80-81`). `DELETE FROM knowledge_commits` cascades it away and nothing
  puts it back. Per `src/store/retention.ts:565-568`, that table is precisely what turns
  blast-radius lookup from an unindexable leading-wildcard `LIKE` scan into an equality search.
  A successful restore therefore silently degrades blast radius, with no error and no notice.
- **`evidence`** is a *parent* of `knowledge_evidence` and of
  `knowledge_assertions.source_evidence_id` (`src/store/bootstrap.ts:96,112`), so a
  dependents-only walk never reaches it. Snapshot-era assertions are relinked to current-era
  evidence, and evidence modified since the snapshot is not rolled back. No code path currently
  deletes `evidence` rows, so this does not fail today — it is a latent constraint failure the
  moment evidence GC is added, and a mixed-time correctness defect right now.

Fix both by making the walk transitive and naming the parent tables the knowledge graph owns.

**Files:**
- Modify: `src/store/snapshots.ts:69-142`
- Test: `tests/store/snapshot-restore-safety.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1's guard, Task 3's staged attachment.
- Produces: `restoreStatements` unchanged in signature. `tablesReferencingItems` is replaced by `restoreClosure(client: Client, present: Set<string>): Promise<{ parents: string[]; dependents: string[] }>`, not exported.

- [ ] **Step 1: Write the failing test**

Append to `tests/store/snapshot-restore-safety.test.ts`:

```ts
  it('restores the commit-to-item index and the evidence rows, not just their links', async () => {
    const client = getClient();
    const project = (await repo.listProjects())[0];
    const item = await repo.createKnowledgeItem(project.id, {
      category: 'fact', title: 'Anchored', content: 'Has evidence.',
    });
    await client.execute({
      sql: 'INSERT INTO evidence (id, type, locator, observed_at) VALUES (?, ?, ?, ?)',
      args: ['ev-restore-1', 'file', 'src/x.ts', new Date().toISOString()],
    });
    await client.execute({
      sql: 'INSERT INTO knowledge_evidence (knowledge_item_id, evidence_id, relationship) VALUES (?, ?, ?)',
      args: [item.id, 'ev-restore-1', 'supports'],
    });

    const count = async (table: string) =>
      Number((await client.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n ?? 0);

    const expectedCommitItems = await count('knowledge_commit_items');
    const expectedEvidence = await count('evidence');
    expect(expectedCommitItems).toBeGreaterThan(0);

    const snapshot = await createSnapshot(TEST_ROOT);

    // Move both tables away from their snapshot-era values.
    await client.execute({
      sql: 'INSERT INTO evidence (id, type, locator, observed_at) VALUES (?, ?, ?, ?)',
      args: ['ev-restore-2', 'file', 'src/y.ts', new Date().toISOString()],
    });
    await repo.createKnowledgeItem(project.id, { category: 'fact', title: 'Later', content: 'After.' });
    expect(await count('evidence')).toBe(expectedEvidence + 1);
    expect(await count('knowledge_commit_items')).toBeGreaterThan(expectedCommitItems);

    await restoreSnapshot(TEST_ROOT, snapshot.path, { confirm: true });

    expect(await count('knowledge_commit_items')).toBe(expectedCommitItems);
    expect(await count('evidence')).toBe(expectedEvidence);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/store/snapshot-restore-safety.test.ts -t 'commit-to-item index'`

Expected: FAIL. `knowledge_commit_items` reads `0` (cascaded away, never restored) and
`evidence` reads `expectedEvidence + 1` (never touched).

- [ ] **Step 3: Replace the one-level walk with a transitive closure**

In `src/store/snapshots.ts`, replace `tablesReferencingItems` (lines 69-97) with:

```ts
/**
 * Tables the knowledge graph owns that nothing in it points *at*.
 *
 * The dependent walk below finds children. It cannot find parents, because a foreign key runs
 * one way: `knowledge_evidence.evidence_id` and `knowledge_assertions.source_evidence_id` both
 * reference `evidence`, and neither tells `evidence` about it. So a restore rebuilt the links
 * and left the rows they point at at their current values -- snapshot-era assertions attached
 * to present-day evidence, and evidence edited since the snapshot not rolled back at all.
 *
 * `knowledge_commits` is here for the same reason from the other direction: it has no foreign
 * key into items, but restoring items without their commits leaves the audit trail describing
 * a store that no longer exists.
 */
const RESTORE_ROOTS = ['knowledge_items', 'evidence', 'knowledge_commits'] as const;

/**
 * Every table a restore has to rewrite, derived rather than listed, and derived *transitively*.
 *
 * The previous walk stopped one foreign key from `knowledge_items`, which missed everything
 * that depends on a dependent. `knowledge_commit_items` references `knowledge_commits`, so
 * deleting commits cascaded it away and nothing put it back -- and that table is what makes
 * blast radius an equality search rather than a leading-wildcard scan (see
 * `compactKnowledgeCommits`). A successful restore silently degraded it.
 *
 * Returned parents-first so foreign keys resolve as rows land; callers delete in reverse.
 */
async function restoreClosure(client: Client, present: Set<string>): Promise<string[]> {
  const tables = (await client.execute(
    `SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  )).rows.map(row => String(row.name));

  const references = new Map<string, string[]>();
  for (const name of tables) {
    const fks = await client.execute(`PRAGMA foreign_key_list(${name})`);
    references.set(name, [...new Set(fks.rows.map(fk => String(fk.table)))]);
  }

  // Breadth-first from the roots, so a table joins the moment anything already in the set is
  // its parent. Ordered by insertion, which is parents-before-children by construction.
  const ordered: string[] = [];
  const seen = new Set<string>();
  const queue = RESTORE_ROOTS.filter(root => present.has(root));
  for (const root of queue) { seen.add(root); ordered.push(root); }

  for (let index = 0; index < ordered.length; index += 1) {
    const parent = ordered[index];
    for (const name of tables) {
      if (seen.has(name) || !present.has(name)) continue;
      if (!(references.get(name) ?? []).includes(parent)) continue;
      seen.add(name);
      ordered.push(name);
    }
  }

  // FTS shadow tables are maintained by the triggers `bootstrap` defines, so they rebuild
  // themselves as rows land. Writing them directly would fight those triggers.
  return ordered.filter(name => !name.startsWith('knowledge_items_fts'));
}
```

- [ ] **Step 4: Use the closure in `restoreStatements`**

Replace the body of `restoreStatements` (lines 115-142) with:

```ts
async function restoreStatements(client: Client): Promise<string[]> {
  const present = new Set(
    (await client.execute(
      `SELECT name FROM snapshot_restore.sqlite_schema WHERE type = 'table'`,
    )).rows.map(row => String(row.name)),
  );

  // ATTACH *creates* a missing database rather than failing, so an attachment can be a
  // perfectly valid empty file. Every table lookup below then finds nothing, the INSERT loop
  // skips every table for want of shared columns, and the statement list degrades to a bare
  // `DELETE FROM knowledge_items` -- which cascades through assertions, evidence links,
  // access, skill rows and embeddings and leaves a store the post-restore audit calls healthy.
  // A restore that inserts nothing is not a restore.
  if (!present.has('knowledge_items')) {
    throw new Error(
      'The attached snapshot holds no knowledge_items table, so there is nothing to restore. ' +
      'Refusing: continuing would delete the live store and insert nothing. ' +
      'The snapshot file was verified and then moved, removed, or replaced before it could be read.',
    );
  }

  const ordered = await restoreClosure(client, present);
  const statements: string[] = [];

  // Children first, then parents: relying on the cascade to clear dependents is what hid the
  // original defect, and an explicit delete says which tables this function owns.
  for (const table of [...ordered].reverse()) statements.push(`DELETE FROM ${table}`);

  // Parents first on the way back in, so foreign keys resolve as rows land.
  for (const table of ordered) {
    const columns = await sharedColumns(client, table);
    if (!columns.length) continue;
    const list = columns.join(', ');
    statements.push(`INSERT INTO ${table} (${list}) SELECT ${list} FROM snapshot_restore.${table}`);
  }
  return statements;
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/store/snapshot-restore-safety.test.ts tests/store/snapshot-verification.test.ts`

Expected: PASS, all cases including the new one.

- [ ] **Step 6: Commit**

```bash
git add src/store/snapshots.ts tests/store/snapshot-restore-safety.test.ts
git commit -m "fix(snapshots): restore the transitive closure so commit items and evidence come back"
```

---

### Task 5: Make table ownership an explicit contract that CI enforces

Task 4 fixes the tables that are wrong today. This stops the next one from being wrong.

Restore is a **partial** operation and always will be while it works by table: sessions, host
bindings, tombstones, code indexes and `drift_state` describe the current host and working
tree, not the knowledge, and rolling them back would be wrong. That is a defensible design —
but right now it is not a design, it is whatever the foreign-key walk happens to reach. Nothing
records the decision, nothing tells an operator, and a table added next month joins one side or
the other by accident.

Note also that `src/store/snapshots.ts:69-84` currently claims `DELETE FROM knowledge_items`
cascaded into `drift_state`. It cannot: `drift_state` has no foreign key to `knowledge_items`,
its primary key is `project_root` (`src/store/bootstrap.ts:190-194`). Fix the comment while the
registry is being written — the same confusion about which tables restore owns is what produced
the defects in Task 4.

**Files:**
- Create: `src/store/snapshot-tables.ts`
- Modify: `src/store/snapshots.ts:69-84` (comment), and `restoreClosure` to assert against the registry
- Test: `tests/store/snapshot-table-ownership.test.ts` (create)

**Interfaces:**
- Consumes: Task 4's `restoreClosure`.
- Produces:
  - `export type SnapshotTablePolicy = 'restored' | 'preserved' | 'rebuilt';`
  - `export const SNAPSHOT_TABLE_POLICY: Readonly<Record<string, SnapshotTablePolicy>>`
  - `export function classifySnapshotTable(name: string): SnapshotTablePolicy | undefined`

- [ ] **Step 1: Write the failing test**

Create `tests/store/snapshot-table-ownership.test.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { classifySnapshotTable, SNAPSHOT_TABLE_POLICY } from '../../src/store/snapshot-tables.js';

const TEST_ROOT = path.resolve('./.knowl-snapshot-ownership-test');

describe('snapshot table ownership', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  // The gate. A table added without a policy is a table whose behaviour under recovery
  // nobody decided -- which is exactly how `knowledge_commit_items` came to be destroyed
  // by a successful restore.
  it('classifies every application table in a bootstrapped store', async () => {
    const live = (await getClient().execute(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )).rows.map(row => String(row.name));

    const unclassified = live.filter(name => classifySnapshotTable(name) === undefined);
    expect(unclassified, `Unclassified tables. Add each to SNAPSHOT_TABLE_POLICY in src/store/snapshot-tables.ts with a reason: ${unclassified.join(', ')}`).toEqual([]);
  });

  it('does not classify tables that no longer exist', async () => {
    const live = new Set((await getClient().execute(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )).rows.map(row => String(row.name)));

    const stale = Object.keys(SNAPSHOT_TABLE_POLICY).filter(name => !live.has(name));
    expect(stale, `Policy names tables that are not in the schema: ${stale.join(', ')}`).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/store/snapshot-table-ownership.test.ts`

Expected: FAIL with `Cannot find module '../../src/store/snapshot-tables.js'`.

- [ ] **Step 3: Write the registry**

Create `src/store/snapshot-tables.ts`:

```ts
/**
 * What `snapshot restore` does with each table, decided rather than derived.
 *
 * Restore is a partial operation. That is a design decision -- a store's sessions, host
 * bindings, code index and drift watermark describe the machine and working tree it is running
 * on right now, and rolling those back to a week ago would be wrong. But until this file
 * existed the split was not a decision, it was whatever a one-level foreign-key walk happened
 * to reach, which is how `knowledge_commit_items` came to be destroyed by a *successful*
 * restore and `evidence` came to be silently left at present-day values.
 *
 * Three states, and every table has exactly one:
 *
 * - `restored`  emptied and refilled from the snapshot. The knowledge graph and its history.
 * - `preserved` untouched. Describes the current host, working tree or operator intent, not
 *               the knowledge, so the snapshot's copy is not the truer one.
 * - `rebuilt`   derived data that regenerates itself as restored rows land -- the FTS shadow
 *               tables, which `bootstrap` maintains with triggers. Writing them directly would
 *               fight those triggers.
 *
 * `tests/store/snapshot-table-ownership.test.ts` fails when a table in a bootstrapped store is
 * missing from this map, so adding a table forces the decision instead of deferring it.
 */
export type SnapshotTablePolicy = 'restored' | 'preserved' | 'rebuilt';

export const SNAPSHOT_TABLE_POLICY: Readonly<Record<string, SnapshotTablePolicy>> = {
  // --- the knowledge graph and its history -------------------------------------------------
  knowledge_items: 'restored',
  knowledge_assertions: 'restored',
  evidence: 'restored',
  knowledge_evidence: 'restored',
  knowledge_access: 'restored',
  knowledge_commits: 'restored',
  // The commit-to-item index. Cascaded away with commits and never refilled before 3.0.2;
  // `compactKnowledgeCommits` documents that it is what makes blast radius an equality search.
  knowledge_commit_items: 'restored',
  skill_steps: 'restored',
  skill_metadata: 'restored',
  knowledge_embeddings: 'restored',

  // --- this machine, this working tree, this operator's intent -----------------------------
  // A tombstone records that someone deliberately deleted an item. Restoring older knowledge
  // is not a statement that they changed their mind, so the delete stands.
  knowledge_tombstones: 'preserved',
  // Sessions and their events belong to hosts that are running now. A restored session is a
  // session no host is in.
  memory_sessions: 'preserved',
  memory_session_events: 'preserved',
  host_session_bindings: 'preserved',
  // Watermarks for MCP calls made by the process that is running now.
  mcp_call_commits: 'preserved',
  // The code index describes the working tree on disk, which a restore does not touch.
  code_files: 'preserved',
  code_symbols: 'preserved',
  code_symbol_edges: 'preserved',
  // Last git commit the drift check ran against, keyed by project root. Git history is what
  // moves here, and a snapshot of the knowledge store says nothing about it.
  drift_state: 'preserved',

  // --- derived, trigger-maintained ---------------------------------------------------------
  knowledge_items_fts: 'rebuilt',
  knowledge_items_fts_config: 'rebuilt',
  knowledge_items_fts_content: 'rebuilt',
  knowledge_items_fts_data: 'rebuilt',
  knowledge_items_fts_docsize: 'rebuilt',
  knowledge_items_fts_idx: 'rebuilt',
};

export function classifySnapshotTable(name: string): SnapshotTablePolicy | undefined {
  return SNAPSHOT_TABLE_POLICY[name];
}
```

- [ ] **Step 4: Run the test and reconcile the registry against the real schema**

Run: `npx vitest run tests/store/snapshot-table-ownership.test.ts`

Expected: PASS. **If it fails**, the failure message names the exact tables to fix — the list
above was read from a bootstrapped store on 2026-08-05, and tables created lazily by a
migration on first use may not have been present. Do not delete the assertion to make it pass:
add each named table with a one-line reason in the right section. If a table is genuinely
ambiguous, `preserved` is the safe default, because it destroys nothing.

- [ ] **Step 5: Assert the derived closure agrees with the registry**

In `src/store/snapshots.ts`, add the import and a check at the end of `restoreClosure`, just
before the `return`:

```ts
import { classifySnapshotTable } from './snapshot-tables.js';
```

```ts
  const derived = ordered.filter(name => !name.startsWith('knowledge_items_fts'));
  // The registry is the contract; the walk is an implementation of it. When they disagree,
  // one of them is a bug and the operator should not find out during a recovery.
  const disagreement = derived.filter(name => classifySnapshotTable(name) !== 'restored');
  if (disagreement.length > 0) {
    throw new Error(
      `Restore would rewrite ${disagreement.join(', ')}, which SNAPSHOT_TABLE_POLICY does not mark ` +
      'as restored. Reconcile src/store/snapshot-tables.ts with the schema before restoring.',
    );
  }
  return derived;
```

Replace the existing `return ordered.filter(...)` line with the block above.

- [ ] **Step 6: Fix the inaccurate `drift_state` comment**

In `src/store/snapshots.ts`, in the comment block at lines 69-84, replace:

```
 * cascades into eight, so `knowledge_assertions`, `knowledge_evidence`, `knowledge_access`
 * and `drift_state` were emptied and never refilled.
```

with:

```
 * cascades further, so `knowledge_assertions`, `knowledge_evidence` and `knowledge_access`
 * were emptied and never refilled. (An earlier version of this note also named `drift_state`.
 * It has no foreign key into items and was never cascaded -- it is `preserved` by policy, not
 * by accident. See `snapshot-tables.ts`.)
```

- [ ] **Step 7: Run the full store suite**

Run: `npx vitest run tests/store`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/store/snapshot-tables.ts src/store/snapshots.ts tests/store/snapshot-table-ownership.test.ts
git commit -m "feat(snapshots): make restore table ownership an explicit CI-enforced registry"
```

---

### Task 6: Contain skill imports in real directories, and install them atomically

Two defects, one fix.

**Containment is lexical, not real.** `planSkillInstalls`
(`src/store/portability.ts:322-343`) validates that the resolved target string sits under
`.knowl/skills/<name>`, which it does. Then
`src/store/portability.ts:612-613` runs `fs.mkdir(..., { recursive: true })` and `fs.rename`,
both of which **follow a symlinked or junctioned parent**. Reproduced on Windows with a
junction, which needs no elevation:

```
lexical relative = "payload.txt" -> passes containment check: true
file landed at real path: ...\symtest\outside\payload.txt
```

The likelier trigger is benign, not hostile: a user symlinks a skill directory to share skills
between projects, then imports an export, and the files land outside the tree.

**Installation is not atomic, and not a replacement.** Files are renamed one at a time after
`COMMIT` (`src/store/portability.ts:609-618`), so a failure on file 2 leaves file 1 installed
and the database committed. And because only the incoming files are written, a package imported
over an existing one **merges** — files the old package had and the new one does not survive,
including scripts the old manifest referenced.

Fix all three by building each package in a directory Knowl created itself, then swapping whole
directories.

**Remember fact 2 from the header:** `fs.rename(staging, existingNonEmptyDir)` fails with
`EPERM` on Windows. The swap must be backup-then-rename, not a single rename.

**Files:**
- Modify: `src/store/portability.ts:312-343,491-502,605-618`
- Test: `tests/store/import-skill-containment.test.ts` (create)

**Interfaces:**
- Consumes: `validateSkillName` and `normalizeSkillFilePath` from `src/skills/registry.ts` (already imported at `src/store/portability.ts:4`).
- Produces (module-internal, not exported):
  - `type SkillPackagePlan = { name: string; files: Array<{ relative: string; content: string }> }`
  - `function planSkillPackages(skills: any[]): SkillPackagePlan[]`
  - `async function installSkillPackages(projectRoot: string, packages: SkillPackagePlan[]): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `tests/store/import-skill-containment.test.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { EXPORT_FORMAT_VERSION, importKnowledge } from '../../src/store/portability.js';

const TEST_ROOT = path.resolve('./.knowl-import-containment-test');

/** A minimal valid export carrying one skill package. */
async function writeStream(file: string, skill: { name: string; files: Array<{ path: string; content: string }> }) {
  const records = [
    { type: 'header', format: 'knowl-jsonl', version: EXPORT_FORMAT_VERSION, origin: null },
    { type: 'skill_package', name: skill.name, files: skill.files },
  ];
  const body = `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  await fs.writeFile(file, `${body}${JSON.stringify({ type: 'manifest', sha256 })}\n`, 'utf8');
}

describe('imported skill containment', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
    await repo.createProject(TEST_ROOT, 'Containment');
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.rm(path.resolve('./.knowl-import-containment-outside'), { recursive: true, force: true }).catch(() => {});
  });

  // Junction on Windows, symlink on POSIX. Both are reparse points that mkdir and rename
  // follow, and `fs.lstat().isSymbolicLink()` is true for both.
  it('refuses to install through a symlinked or junctioned package directory', async () => {
    const skills = path.join(TEST_ROOT, '.knowl', 'skills');
    const outside = path.resolve('./.knowl-import-containment-outside');
    await fs.mkdir(skills, { recursive: true });
    await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(outside, { recursive: true });
    await fs.rm(path.join(skills, 'escapee'), { recursive: true, force: true }).catch(() => {});
    await fs.symlink(outside, path.join(skills, 'escapee'), 'junction');

    const stream = path.join(TEST_ROOT, 'escape.jsonl');
    await writeStream(stream, { name: 'escapee', files: [{ path: 'payload.txt', content: 'PWNED' }] });

    await expect(importKnowledge(stream, { projectRoot: TEST_ROOT })).rejects.toThrow(/symlink|junction|reparse/i);
    await expect(fs.readdir(outside)).resolves.toEqual([]);
  });

  it('replaces a package rather than merging into it', async () => {
    const dir = path.join(TEST_ROOT, '.knowl', 'skills', 'replaceme');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'stale.sh'), 'echo old', 'utf8');
    await fs.writeFile(path.join(dir, 'SKILL.md'), '# old', 'utf8');

    const stream = path.join(TEST_ROOT, 'replace.jsonl');
    await writeStream(stream, { name: 'replaceme', files: [{ path: 'SKILL.md', content: '# new' }] });

    await importKnowledge(stream, { projectRoot: TEST_ROOT });

    expect(await fs.readdir(dir)).toEqual(['SKILL.md']);
    expect(await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8')).toBe('# new');
  });

  it('leaves no staging directories behind', async () => {
    const skills = path.join(TEST_ROOT, '.knowl', 'skills');
    const leftovers = (await fs.readdir(skills)).filter(name => name.startsWith('.import-'));
    expect(leftovers).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/store/import-skill-containment.test.ts`

Expected: FAIL on the first two cases — the import succeeds and `PWNED` lands in the outside
directory, and `stale.sh` survives the replacement.

- [ ] **Step 3: Plan per package instead of per file**

In `src/store/portability.ts`, replace the `SkillInstall` type and `planSkillInstalls`
(lines 312-343) with:

```ts
type SkillPackagePlan = { name: string; files: Array<{ relative: string; content: string }> };

/**
 * Validate every incoming package as a whole, before anything is written.
 *
 * Grouped by package rather than flattened to files because installation is a package-level
 * operation: a skill is its directory, and half of one is not a skill. Names are validated with
 * the same rule package creation uses -- no dots, no separators -- which makes traversal
 * unrepresentable rather than merely detected.
 *
 * Note what this does *not* do: it computes no absolute target. Lexical containment was the
 * previous defence and it is not one. `path.resolve` reasons about strings; `mkdir` and
 * `rename` reason about the filesystem, and a junction under `.knowl/skills` satisfies the
 * first and defeats the second. Containment is established in `installSkillPackages`, by
 * writing only into directories Knowl created itself.
 */
function planSkillPackages(skills: any[]): SkillPackagePlan[] {
  const plans: SkillPackagePlan[] = [];
  const seen = new Set<string>();
  for (const skill of skills) {
    validateSkillName(skill.name);
    if (seen.has(skill.name)) throw new Error(`Duplicate imported skill package "${skill.name}".`);
    seen.add(skill.name);

    const files: SkillPackagePlan['files'] = [];
    for (const file of skill.files ?? []) {
      if (typeof file?.content !== 'string') {
        throw new Error(`Invalid imported skill file content for "${file?.path}".`);
      }
      files.push({ relative: normalizeSkillFilePath(file.path), content: file.content });
    }
    plans.push({ name: skill.name, files });
  }
  return plans;
}
```

- [ ] **Step 4: Install whole directories, refusing reparse points**

Add below `planSkillPackages`:

```ts
/** True for a POSIX symlink and for a Windows directory junction; both are followed by rename. */
async function isReparsePoint(target: string): Promise<boolean> {
  try {
    return (await fs.lstat(target)).isSymbolicLink();
  } catch (error: any) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Install each package as one directory swap, inside a base Knowl proved is a real directory.
 *
 * Three defects share this fix.
 *
 * Containment was lexical: every path resolved under `.knowl/skills/<name>` as a *string*,
 * and then `mkdir` and `rename` followed a junction sitting at that name and wrote outside the
 * tree. Reproduced on Windows, where a junction needs no elevation. So nothing is written into
 * a path the import can influence: files go into a staging directory `mkdtemp` created
 * directly under the verified base, which means Knowl created every ancestor and imported data
 * had no opportunity to insert a link into the chain.
 *
 * Installation was not atomic: N renames after `COMMIT`, so file 2 failing left file 1
 * installed and the database committed. A package now lands in one rename, or not at all.
 *
 * Installation was a merge, not a replacement: only incoming files were written, so a package
 * imported over an existing one kept whatever the old one had and the new one lacks --
 * including scripts the old manifest referenced. The whole directory is now replaced.
 *
 * The swap is backup-then-rename rather than a single rename because renaming onto a non-empty
 * directory fails: EPERM on Windows, ENOTEMPTY on POSIX. Measured, not assumed.
 */
async function installSkillPackages(projectRoot: string, packages: SkillPackagePlan[]): Promise<void> {
  if (packages.length === 0) return;
  const base = path.resolve(projectRoot, '.knowl', 'skills');
  await fs.mkdir(base, { recursive: true });
  if (await isReparsePoint(base)) {
    throw new Error(
      `"${base}" is a symlink, junction, or reparse point. Knowl will not install imported skills ` +
      'through one, because every path under it resolves somewhere it cannot vouch for.',
    );
  }

  for (const plan of packages) {
    const destination = path.join(base, plan.name);
    if (await isReparsePoint(destination)) {
      throw new Error(
        `Skill package directory "${destination}" is a symlink, junction, or reparse point. ` +
        'Refusing to install through it: the files would land outside .knowl/skills. ' +
        'Remove or replace it with a real directory and import again.',
      );
    }

    const staging = await fs.mkdtemp(path.join(base, '.import-'));
    const backup = `${destination}.knowl-replacing`;
    let swapped = false;
    try {
      for (const file of plan.files) {
        const target = path.join(staging, ...file.relative.split('/'));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, file.content, 'utf8');
      }

      // Renaming onto a non-empty directory fails on every platform, so the live package moves
      // aside first. Between these two renames the package is momentarily absent; the backup
      // is what a crash there leaves behind, under a name no skill can hold.
      await fs.rm(backup, { recursive: true, force: true });
      const existed = await fs.stat(destination).then(() => true, () => false);
      if (existed) await fs.rename(destination, backup);
      try {
        await fs.rename(staging, destination);
        swapped = true;
      } catch (error) {
        if (existed) await fs.rename(backup, destination).catch(() => {});
        throw error;
      }
      await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
    } finally {
      if (!swapped) await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }
}
```

- [ ] **Step 5: Rewire the import to plan early and install after commit**

In `importKnowledge`, replace lines 491-502:

```ts
  if (!options.projectRoot && skills.length > 0) throw new Error('Skill package import requires a project root.');
  // Planned before anything is written, so a malformed package cannot leave a half-written
  // filesystem behind a rolled-back database. Content stays in memory rather than staged:
  // staging now happens per package, inside the verified base, at install time.
  const skillPackages = options.projectRoot ? planSkillPackages(skills) : [];
```

Delete the `staging` variable and its write loop entirely. In the `catch` block at lines
599-603, remove the `if (staging) await fs.rm(staging, ...)` line. Then replace lines 605-618
with:

```ts
  // After COMMIT: the database is already durable by this point, so a failure here is
  // reported rather than swallowed -- an import that silently omitted its skill files would
  // look like a success. Each package lands as one directory swap, so a failure on the third
  // package leaves the first two installed whole and the third untouched, rather than leaving
  // one package half-written.
  await installSkillPackages(options.projectRoot!, skillPackages);
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/store/import-skill-containment.test.ts`

Expected: PASS, all three cases.

- [ ] **Step 7: Run the existing import and skill suites**

Run: `npx vitest run tests/store/import-skill-safety.test.ts tests/skills tests/store/portability*.test.ts`

Expected: PASS. The lexical-traversal regressions from 3.0.1 still hold — `validateSkillName`
and `normalizeSkillFilePath` are unchanged and still run first.

- [ ] **Step 8: Commit**

```bash
git add src/store/portability.ts tests/store/import-skill-containment.test.ts
git commit -m "fix(import): install skill packages as atomic directory swaps and refuse reparse points"
```

---

### Task 7: Stop running an entrypoint nobody asked for

`runSkillPackage` (`src/skills/registry.ts:359-362`) runs the `fallback` entrypoint
automatically whenever the requested one exits non-zero. The caller asked for one execution and
gets two, the second not named in the request.

On its own that is a surprise. Combined with `autoRun` being a boolean in the package's own
manifest — the package grants its own permission, which 3.1.0's Task 1 fixes properly — it means
a package can guarantee its `fallback` runs by making its `default` fail.

The fix is not to remove `fallback` but to require it to be asked for. A caller who wants the
chain can request it.

**Files:**
- Modify: `src/skills/registry.ts:314-374`
- Test: `tests/skills/fallback-entrypoint.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `runSkillPackage(projectRoot: string, name: string, entrypointName?: string, args?: string[], options?: { allowFallback?: boolean }): Promise<SkillRunResult>` — the new final parameter defaults to `false`. `SkillRunResult` is unchanged.

- [ ] **Step 1: Write the failing test**

Create `tests/skills/fallback-entrypoint.test.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSkillPackage, runSkillPackage } from '../../src/skills/registry.js';

const TEST_ROOT = path.resolve('./.knowl-fallback-test');

describe('fallback entrypoints', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(TEST_ROOT, { recursive: true });
    await createSkillPackage(TEST_ROOT, {
      name: 'two-doors',
      purpose: 'probe',
      files: [
        { path: 'fail.js', content: 'process.exit(3);' },
        { path: 'mark.js', content: "require('fs').writeFileSync(process.env.KNOWL_SKILL_DIR + '/ran', 'yes');" },
      ],
      entrypoints: {
        default: { type: 'script', path: 'fail.js', autoRun: true },
        fallback: { type: 'script', path: 'mark.js', autoRun: true },
      },
    });
  });

  afterAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('does not run the fallback unless the caller asked for it', async () => {
    const marker = path.join(TEST_ROOT, '.knowl', 'skills', 'two-doors', 'ran');
    await fs.rm(marker, { force: true }).catch(() => {});

    const result = await runSkillPackage(TEST_ROOT, 'two-doors');

    expect(result.usedEntrypoint).toBe('default');
    expect(result.attempts).toHaveLength(1);
    await expect(fs.stat(marker)).rejects.toThrow();
  });

  it('runs the fallback when the caller opts in', async () => {
    const marker = path.join(TEST_ROOT, '.knowl', 'skills', 'two-doors', 'ran');
    await fs.rm(marker, { force: true }).catch(() => {});

    const result = await runSkillPackage(TEST_ROOT, 'two-doors', 'default', [], { allowFallback: true });

    expect(result.usedEntrypoint).toBe('fallback');
    expect(result.attempts).toHaveLength(2);
    await expect(fs.stat(marker)).resolves.toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify the first case fails**

Run: `npx vitest run tests/skills/fallback-entrypoint.test.ts`

Expected: the first test FAILS — `usedEntrypoint` is `fallback`, `attempts` has length 2, and
the marker file exists. The second test passes already.

- [ ] **Step 3: Make the chain opt-in**

In `src/skills/registry.ts`, change the signature at lines 314-319:

```ts
export async function runSkillPackage(
  projectRoot: string,
  name: string,
  entrypointName = 'default',
  args: string[] = [],
  options: { allowFallback?: boolean } = {}
): Promise<SkillRunResult> {
```

and replace lines 359-362:

```ts
  let attempt = await runNamed(entrypointName);
  // Opt-in, not automatic. A failed entrypoint used to chain straight into `fallback`, so a
  // caller who asked for one execution got two and the second was never named in the request.
  // A package that wants its fallback run can be asked for it; it should not be able to arrange
  // its own second attempt by failing the first.
  if (
    options.allowFallback
    && attempt.exitCode !== 0
    && entrypointName !== 'fallback'
    && skill.manifest.entrypoints.fallback
  ) {
    attempt = await runNamed('fallback');
  }
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/skills/fallback-entrypoint.test.ts`

Expected: PASS, both cases.

- [ ] **Step 5: Check every call site**

Run: `grep -rn "runSkillPackage" src/ tests/`

Expected: call sites in `src/mcp/tools.ts` and `src/cli/program.ts` compile unchanged, because
the new parameter is optional. Read each one and confirm none of them **relied** on the
automatic chain. If a call site did, pass `{ allowFallback: true }` explicitly there and say so
in the commit body.

- [ ] **Step 6: Run the skill suites**

Run: `npx vitest run tests/skills`

Expected: PASS. If an existing test asserted the automatic chain, update it to pass
`{ allowFallback: true }` — that test was asserting the defect.

- [ ] **Step 7: Commit**

```bash
git add src/skills/registry.ts tests/skills/fallback-entrypoint.test.ts
git commit -m "fix(skills): require callers to opt into the fallback entrypoint"
```

---

### Task 8: Fix the lockfile, gate the drift, and produce publish provenance

Three small release-hygiene defects, all confirmed:

- `package.json` says `3.0.1`; `package-lock.json` says `3.0.0` at both `version` and
  `packages[""].version`. A tarball built from the lockfile disagrees with the package.
- Nothing in CI would have caught that.
- `.github/workflows/cd.yml` requests `id-token: write` and comments that it is for the OIDC
  exchange, but `npm publish` is called without `--provenance` and `package.json` has no
  `publishConfig.provenance`. The permission is granted and unused; no attestation is produced.

**Files:**
- Modify: `package-lock.json`
- Modify: `package.json` (`publishConfig`)
- Modify: `.github/workflows/ci.yml`
- Create: `scripts/check-lockfile-version.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm run check:lockfile` exits non-zero on version disagreement.

- [ ] **Step 1: Write the failing check**

Create `scripts/check-lockfile-version.mjs`:

```js
#!/usr/bin/env node
// The published tarball is built from package.json and resolved from package-lock.json. When
// the two disagree about the version, a release advertises one number and installs another --
// which 3.0.1 shipped with, unnoticed, because nothing looked.
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));

const problems = [];
if (lock.version !== pkg.version) problems.push(`package-lock.json version is ${lock.version}, expected ${pkg.version}`);
if (lock.packages?.['']?.version !== pkg.version) {
  problems.push(`package-lock.json packages[""].version is ${lock.packages?.['']?.version}, expected ${pkg.version}`);
}

if (problems.length > 0) {
  console.error(`Lockfile version drift:\n  ${problems.join('\n  ')}\nRun: npm install --package-lock-only`);
  process.exit(1);
}
console.log(`Lockfile version matches package.json (${pkg.version}).`);
```

Add to `package.json` scripts:

```json
    "check:lockfile": "node scripts/check-lockfile-version.mjs",
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run check:lockfile`

Expected: FAIL, exit 1, reporting `3.0.0` where `3.0.1` was expected on both lines.

- [ ] **Step 3: Regenerate the lockfile**

Run: `npm install --package-lock-only`

- [ ] **Step 4: Run it again to verify it passes**

Run: `npm run check:lockfile`

Expected: `Lockfile version matches package.json (3.0.1).`

Verify nothing else moved:

```bash
git diff --stat package-lock.json
```

Expected: a small diff touching the two version fields. If dependency resolutions also changed,
inspect them — this task must not smuggle in a dependency bump. Revert and rerun with
`--package-lock-only` on a clean tree if so.

- [ ] **Step 5: Gate it in CI**

In `.github/workflows/ci.yml`, add after the `Install dependencies` step:

```yaml
      - name: Check lockfile version
        run: npm run check:lockfile
```

- [ ] **Step 6: Produce provenance on publish**

The CD workflow already requests `id-token: write`. Make it produce something. In
`package.json`:

```json
  "publishConfig": {
    "access": "public",
    "provenance": true
  },
```

- [ ] **Step 7: Verify the packed tarball**

Run: `npm pack --dry-run`

Expected: the tarball lists `dist`, `README.md`, `CHANGELOG.md`, `LICENSE` and reports version
`3.0.1`. Provenance itself cannot be verified locally — it is generated by npm in CI when
`id-token` is present — so confirm the wiring by reading the CD job, and check the published
package page after release.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json scripts/check-lockfile-version.mjs .github/workflows/ci.yml
git commit -m "chore(release): fix lockfile version drift, gate it in CI, and enable publish provenance"
```

---

### Task 9: Correct the README snapshot section and release

The README describes a restore that no longer exists, and describes it wrongly in **both**
directions — the dangerous one being that it tells users their assertions survive a restore
when in fact they are replaced.

- `README.md:732` — "validates the manifest when one is present." It is **required**
  (`src/store/snapshots.ts:182-191`, since 3.0.1).
- `README.md:733-734` — "The restored subset is items, knowledge commits, skill rows, and
  embeddings. Assertions, evidence and links, access telemetry, sessions, code indexes, and
  tombstones are not restored." Assertions, evidence links, access, skill rows and embeddings
  **are** restored, and after Task 4 so are `evidence` and `knowledge_commit_items`.

**Files:**
- Modify: `README.md:722-735`
- Modify: `CHANGELOG.md`
- Modify: `package.json` (version)

**Interfaces:**
- Consumes: Task 5's `SNAPSHOT_TABLE_POLICY`, which is now the source of truth this prose must agree with.
- Produces: nothing.

- [ ] **Step 1: Rewrite the snapshot section**

Replace `README.md:731-734` with:

```markdown
Snapshot creation uses SQLite `VACUUM INTO` and writes a checksum manifest. The manifest is
**required** on restore, not optional: restore verifies its schema version, byte size and
SHA-256, copies the snapshot out of the snapshot directory, and re-verifies the copy it is
about to read — then checks that copy's own SQLite `integrity_check` and `user_version` before
any destructive statement runs. Restore also takes a pre-restore snapshot first, and refuses to
delete the snapshot it was asked to restore from.

Restore is a **partial** operation, and which half is which is a decision recorded in
`src/store/snapshot-tables.ts` rather than a side effect of the schema. Restored: knowledge
items, assertions, evidence and its links, access telemetry, knowledge commits and the
commit-to-item index, skill rows, and embeddings. Preserved at their current values: memory
sessions and their events, host bindings, tombstones, MCP call watermarks, the code index, and
the drift watermark — each describes the machine and working tree you are on now, not the
knowledge. Full-text search indexes rebuild themselves as rows land. A test fails if any table
in the schema is missing from that registry, so restore behaviour cannot drift by accident.
```

- [ ] **Step 2: Verify the prose against the registry**

Run: `node -e "const m=require('./dist/store/snapshot-tables.js');" 2>/dev/null || npx tsx -e "import {SNAPSHOT_TABLE_POLICY} from './src/store/snapshot-tables.js'; const g=(p)=>Object.entries(SNAPSHOT_TABLE_POLICY).filter(([,v])=>v===p).map(([k])=>k); console.log('restored:', g('restored').join(', ')); console.log('preserved:', g('preserved').join(', '));"`

Expected: the two lists match the README prose exactly. Fix the prose, not the registry, if they
disagree.

- [ ] **Step 3: Add the version-state header to the historical audit ledger**

At the top of `docs/audit-2026-08-04.md`, immediately below the `# Knowl audit — 2026-08-04`
line, insert:

```markdown
> **Status: historical.** These audits ran against `fork/mainline-2.16`. Findings were
> remediated across 3.0.0 and 3.0.1 and re-validated on 2026-08-04 and 2026-08-05. This file is
> evidence of what was found and when — it is **not** a statement of current security state.
> For that, read [audit-2026-08-05-verified.md](audit-2026-08-05-verified.md).
```

- [ ] **Step 4: Write the changelog**

Add to `CHANGELOG.md` above the `## 3.0.1` section:

```markdown
## 3.0.2

### Fixed

- **Critical: `snapshot restore` could delete every knowledge item and report success.** The
  pre-restore snapshot prunes the snapshot directory to its retention limit and protected only
  the file it had just written, so restoring anything older than the second-newest snapshot
  deleted the source. `ATTACH` then created an empty database in its place, the restore emitted
  a bare `DELETE FROM knowledge_items`, the cascade took assertions, evidence links, access,
  skill rows and embeddings with it, and the integrity audit affirmed the empty store was
  healthy. Restore now refuses an attachment holding no `knowledge_items`, protects the source
  from the prune, and verifies the exact bytes it attaches by staging them outside the snapshot
  directory first.
- Restore now rewrites the full transitive dependency closure. `knowledge_commit_items` — the
  index that makes blast-radius lookup an equality search — was cascaded away and never
  refilled. `evidence` rows were left at present-day values while the links pointing at them
  were rolled back.
- Which tables restore owns is now an explicit registry (`src/store/snapshot-tables.ts`) with a
  test that fails when a table in the schema is unclassified.
- Imported skill packages install as atomic whole-directory swaps into a base Knowl verified is
  a real directory. Previously, files were renamed one at a time after the database committed —
  so a partial install was possible, an import merged into an existing package instead of
  replacing it, and a symlink or Windows junction under `.knowl/skills` was followed, landing
  files outside the tree despite passing the lexical containment check.
- A failed skill entrypoint no longer chains automatically into `fallback`; callers opt in.
- `package-lock.json` records the right version again, and CI now fails on drift.

### Changed

- `npm publish` produces provenance attestation, which the release workflow already had the
  OIDC permission for.
- README's snapshot section describes what restore actually does.
```

- [ ] **Step 5: Bump the version and the lockfile**

```bash
npm version 3.0.2 --no-git-tag-version
npm run check:lockfile
```

Expected: `Lockfile version matches package.json (3.0.2).`

- [ ] **Step 6: Full verification**

Run all four, and paste the real output into the commit body — not a summary of it:

```bash
npm run build
npx tsc --noEmit
npm test
npm run check:lockfile
```

Expected: build clean, 0 type errors, every test passing, lockfile matching. **Do not proceed on
a partial pass.** If anything fails, fix it before committing.

- [ ] **Step 7: Commit and tag**

```bash
git add README.md CHANGELOG.md docs/audit-2026-08-04.md package.json package-lock.json
git commit -m "docs(snapshots): describe the restore that exists, and release 3.0.2"
git tag v3.0.2
```

Do not push the tag until a human has reviewed the diff. The tag triggers publish.

---

## Self-Review Notes

**Coverage against the verified audit.** Every P0 and P1 finding not already owned by the
3.1.0 plan has a task:

| Finding | Task |
| --- | --- |
| K-NEW-1 critical silent wipe | 1, 2 |
| K-NEW-2 TOCTOU preflight | 3 |
| §3 restore table ownership (`evidence`, `knowledge_commit_items`, and the rest) | 4, 5 |
| §2 symlink/junction escape | 6 |
| §4 non-atomic skill install | 6 |
| K-NEW-4 skill import merges instead of replacing | 6 |
| K-NEW-5 unrequested fallback execution | 7 |
| K-NEW-6 inaccurate `drift_state` comment | 5 |
| §12 lockfile drift | 8 |
| K-NEW-7 unused OIDC permission | 8 |
| §14 README snapshot drift, audit ledger version state | 9 |

**Deliberately not here, with the reason:**

- §5 skill approval model, §6 streaming import, §10 config writes, §11 diagnostics, §13 CI
  matrix — all owned by `2026-08-04-hardening-and-ci-3.2.0.md`.
- K-NEW-3 `spawnSync` timeout — owned by that plan's Task 1. Pull forward as a standalone
  one-liner if 3.1.0 slips more than a few weeks, because a hung skill freezes the whole
  server.
- §7 viewer graph scaling and §9 viewer bootstrap-token redirect — **not owned by any plan.**
  Both are real and confirmed, neither is a data-loss or containment issue, and neither belongs
  in a hotfix. They need their own plan; write it after 3.0.2 ships.
- §8 process-wide transaction queue — downgraded to a Cloud prerequisite. `src/store/database.ts:152-157`
  documents the tradeoff and correctly rejects the naive per-connection queue. When it is
  revisited, the queue must key on the connection resolved *after* the wait, not the one
  captured before it.
- Whole-file database restore — the decision point described at the top of this plan. Task 5
  builds the registry that makes deciding it possible.

**Type consistency checked.** `createSnapshot(root, { protect })` is introduced in Task 2 and
used in Task 3. `restoreClosure(client, present)` is introduced in Task 4 and extended in Task 5.
`classifySnapshotTable` is defined in Task 5 and imported in Task 5's step 5.
`planSkillPackages` / `installSkillPackages` / `SkillPackagePlan` are defined and used within
Task 6 only. `runSkillPackage`'s new fifth parameter is optional, so Task 7 breaks no caller.

**One ordering constraint that is not obvious:** Task 1 must land before Task 2. Task 2's test
asserts a *successful* restore, which is indistinguishable from the pre-fix wipe unless Task 1's
guard is already converting that case into a refusal.
