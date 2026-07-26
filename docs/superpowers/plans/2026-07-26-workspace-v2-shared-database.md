# Workspace v2 (Shared Database) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status: provisional.** Five of its decisions depend on questions only v1 usage can answer — see "What v1 must answer first". Do not start Task 1 until those are settled; the tasks are shaped so that answering them changes scope, not architecture.

**Goal:** Give linked repos one shared knowledge database that they all read and write, with a single owning repo per item and an explicit visibility, so cross-repo `knowl_update`, conflict detection and dedup work — the things federation structurally cannot do.

**Architecture:** A workspace database at `~/.knowl/workspaces/<name>/knowl.db` becomes the `knowledge` storage role. Each repo's `<repo>/.knowl/knowl.db` stays exactly where it is, serving the `local` and `session` roles — code index, host bindings, watermarks, telemetry. Migration copies rather than moves, is journalled, fences writes per repo, and flips mode last by writing one file.

**Tech Stack:** TypeScript (ESM, NodeNext), libSQL + Drizzle, vitest, tsup, commander, MCP SDK.

**Source spec:** `docs/superpowers/specs/2026-07-26-multi-repo-workspace-design.md`, section "v2 — the shared database".

**Depends on:** 2.4.0 and the whole of `2026-07-26-workspace-v1-federation.md`.

## What v1 must answer first

| Question | Why it blocks | What changes |
| --- | --- | --- |
| Does `linked` mode earn its keep? | If category routing works, `shared` may be the only mode worth maintaining | Tasks 3 and 9 shrink to one mode; the `workspace` connection role disappears |
| Do agents condition on the `repo` label? | Task 11's ranking work is justified by it | If not, drop the weighting work and keep ties-to-local |
| Is the advisory applies-to table worth building? | Nothing mutating reads it, and an empty table breaks nothing | Task 4 disappears entirely |
| Should `visibility` be mutable after write? | Promotion is a one-column update; demotion is a retraction with no mechanism | Promotion-only stays; demotion needs a design that does not exist |
| Is per-atom batch routing the right partial-failure semantic? | Alternative is rejecting mixed batches | Task 8's response shape |

## Global Constraints

- Windows dev machine. `npm.cmd`, `npx.cmd`. Grep tool rather than `rg`.
- Test `npm.cmd test`; build `npm.cmd run build`; typecheck baseline **15 pre-existing errors**.
- Relative imports carry `.js`.
- **Bump `KNOWL_SCHEMA_VERSION`** in `src/store/schema-version.ts` in the task that first makes a database unreadable by 2.4.x. That is the whole point of shipping the guard first.
- **The export format bumps to version 2** when `origin_repo`, `visibility` and `lifecycle_hash` become portable fields. A version-1 reader must refuse version 2 rather than silently dropping ownership.
- **No destructive operation without a journal.** `migrate`, `promote` in linked mode, and `unlink` all move items between databases; a crash halfway through any of them must be resumable.
- A repo with no workspace behaves exactly as today. Task 12 asserts it.

## File Structure

| File | Responsibility | Tasks |
| --- | --- | --- |
| `src/store/storage-roles.ts` | `knowledge` resolves to the workspace database in `shared` mode; `local`/`session` never move | 1 |
| `src/store/schema-version.ts` | Version bump gating the shared schema | 1 |
| `src/workspace/journal.ts` | **New.** Durable per-repo state machine for migrate/promote/unlink | 5 |
| `src/workspace/fence.ts` | **New.** `knowl_meta` write fence during migration | 6 |
| `src/workspace/migrate.ts` | **New.** Dry-run, copy, re-embed, activate | 6, 7 |
| `src/store/import-policy.ts` | `metadata-divergent` verdict | 2 |
| `src/store/freshness.ts` | `lifecycle_hash` alongside `content_hash` | 2 |
| `src/store/portability.ts` | Lifecycle convergence, tombstone monotonicity, format v2 | 2, 3 |
| `src/store/knowledge-writer.ts` | `routeWrite` below every write surface | 8 |
| `src/store/gc.ts` | Purge disabled in a workspace | 10 |
| `src/store/snapshots.ts` | Restore refused in `shared` mode | 10 |
| `src/store/bootstrap.ts` | Applies-to table; FTS rebuild with ownership columns | 4, 11 |

---

### Task 1: `shared` mode redirects the knowledge role only

Extend `resolveStorage(root, config)` so `knowledge` resolves to the workspace database when the manifest says `mode: 'shared'`, while `local` and `session` stay at `<repo>/.knowl/`. Bump `KNOWL_SCHEMA_VERSION` to 2.

**Mode lives only in the manifest.** Not in any repo's config. That is what makes activation a single atomic file write in Task 7, and it is why the revised spec's original design — flipping mode across the manifest *and* every repo's config — was replaced: that is a multi-writer cutover with no atomicity, and a crash midway leaves a mixed-mode state with no recovery procedure.

Tests: `shared` redirects `knowledge` and nothing else; `local` is byte-identical across both modes; the code index and session database are unaffected; an unlinked repo is unchanged.

---

### Task 2: Lifecycle convergence

`content_hash` covers title, content, reasoning, source and paths. Equal hashes classify as `identical` (`import-policy.ts:15-21`) and the plan skips the item entirely (`portability.ts:130`), so status, freshness, supersession, origin and visibility never propagate — promotion and retirement cannot cross machines.

Add `lifecycle_hash` over `status`, `freshness`, `superseded_by_id`, `origin_repo`, `visibility`. `classifyIncomingItem` compares both and gains a fourth verdict, `metadata-divergent`, resolved by the existing `newer` policy and applied as a metadata-only `UPDATE` that writes `content_hash` **verbatim**.

**Do not widen `content_hash`.** It would change every existing item's identity and break the verbatim adoption that makes re-import idempotent — the same trap that killed path qualification. `confidence` is excluded from the lifecycle hash: it moves on ordinary use and would make almost every item permanently divergent.

Tests: promote → export → import on a second machine converges; a content-identical, lifecycle-identical item is still `identical` and still skipped; a metadata-only update leaves `content_hash` unchanged; re-import after a metadata update is a no-op.

---

### Task 3: Deletes only move forward

Import plans an insert without consulting local tombstones, so a stale export resurrects an item deleted after that export was taken. The tombstone upsert overwrites `deleted_at` unconditionally (`portability.ts:193-207`), so an old tombstone rewinds a newer one.

Consult tombstones before planning an insert, skipping when the tombstone is newer than the incoming item's `updated_at`; make the upsert conditional on `excluded.deleted_at > knowledge_tombstones.deleted_at`. Bump the export header to version 2 and make a version-1 reader refuse version 2.

Tests: a stale export cannot resurrect a newer delete; an old tombstone does not rewind a newer one; a v1 reader refuses a v2 file; a v2 reader accepts a v1 file with missing fields defaulted.

---

### Task 4: The advisory applies-to table

**Build only if v1 says it is worth it.** It exists solely to boost and filter retrieval; nothing reads it for a lifecycle decision, and an empty table breaks nothing.

```sql
CREATE TABLE knowledge_item_repos (
  knowledge_item_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  repo_name         TEXT NOT NULL,
  PRIMARY KEY (knowledge_item_id, repo_name)
);
CREATE INDEX idx_knowledge_item_repos_name ON knowledge_item_repos(repo_name);
```

Tests: membership boosts ranking; it never adds or removes a result under any filter; `repos: ["x"]` still matches on `origin_repo` alone.

---

### Task 5: The migration journal

`<workspace-dir>/migration.json` holding per-repo state `pending` → `fenced` → `exported` → `imported` → `done`. **The journal, not the filesystem, is the source of truth**, so a crash resumes rather than restarts.

Tests: a killed process resumes at the recorded state; a completed repo is not re-migrated; a corrupt journal fails loudly rather than silently restarting.

---

### Task 6: Fence, snapshot, copy

Per repo: set a `migrating` marker in `knowl_meta` making every knowledge write fail with a clear message; export at the fence; import into the workspace setting `origin_repo` and routing `visibility` by category; re-embed anything not matching the pinned identity; mark local knowledge retired and bump its `user_version`; lift the fence.

**The fence is not optional.** Without it a write landing between export and activation is simply lost — it goes into a database that stops being read the moment mode flips, and nothing reports it. The fence is per repo and short-lived, so other repos stay usable.

**Copy, never move.** The canonical path is never renamed: an old client opening `<repo>/.knowl/knowl.db` and finding nothing would create a *fresh* database and never meet the version guard.

Tests: a write during the fence fails with the migration message; killing the process after export leaves mode unflipped and the repo usable; migrate is idempotent; the local file still exists at its canonical path afterwards with a bumped `user_version`.

---

### Task 7: Atomic activation

Flip `mode` in `workspace.json` once, after every repo reports `done`. One file write, so no mixed-mode state can exist.

Tests: mode does not flip while any repo is not `done`; after activation every repo resolves `knowledge` to the workspace database; before activation every repo still resolves to its own.

---

### Task 8: Write routing below every surface

`routeWrite(atom, context) → { visibility, originRepo }` in `knowledge-writer`, **beneath** the MCP tools — synthesis, candidate promotion and the extraction pipeline all create items without passing through a tool handler, and routing at the MCP layer would be bypassed by every one of them.

Default is category-driven: `decision`, `constraint`, `architecture`, `goal` → `workspace`; `fact`, `state`, `skill` → repo. `skill` never crosses. Batch writes partition by destination, each partition in its own transaction, with a per-atom destination reported; a failing partition does not roll back the others.

Tests: a synthesis-created item is routed, not defaulted; a mixed batch reports per-atom destinations; one failing partition leaves the others committed; an explicit `namespace` overrides the category default in both directions.

---

### Task 9: Ownership enforcement in one database

In a shared database every repo's items sit in one table, so the ownership rules that were structural in v1 become checks. A repo may mutate only items it originated. Duplicate detection spans owners; resolution is clamped to `coexist` across an owner boundary (already done in v1 Task 8 — verify it still holds when both items are in the same file).

Tests: `knowl_update` refuses a foreign item; GC only collects items the running repo originated; drift in one repo cannot stale another's; a write in one repo cannot supersede another's item as a duplicate.

---

### Task 10: Block what cannot be made safe

| Operation | Change |
| --- | --- |
| GC purge | **Disabled in a workspace.** The commit records only the base item (`gc.ts:219`) while cascades take assertions, evidence links, telemetry, skill steps and embeddings — `gc undo` cannot exist. Archive and compress remain and are reversible |
| `restoreSnapshot` | Refused in `shared` mode: it would roll back every repo and pass the integrity audit doing it |
| `createSnapshot` | Refused unless `--all-repos`: it would write every repo's knowledge into one repo's `.knowl/snapshots/` |
| `exportKnowledge` | Defaults to `origin_repo = <current>` |
| Change notification | Only changes whose `origin_repo` is the current repo. Hardcoded, not configurable |

---

### Task 11: FTS rebuild with ownership columns

`knowledge_items_fts` and its three triggers are `CREATE ... IF NOT EXISTS` (`bootstrap.ts:33-41`, `165-184`), so adding `origin_repo` and `visibility` as `UNINDEXED` columns is a silent no-op on every existing database. Requires a versioned drop, recreate and backfill from `knowledge_items`, gated on `user_version` so it runs exactly once.

**Filter before capping.** Cap-then-filter can return zero local results when a chatty repo fills the candidate window.

---

### Task 12: Concurrency

`BEGIN IMMEDIATE` for every read-modify-write; optimistic concurrency on `knowledge_items` (`UPDATE ... WHERE version = ?`, retry on zero rows); bounded retry with jittered backoff and a hard deadline rather than a tuned `busy_timeout`.

Acceptance is a number: **8 concurrent writers, zero escaped `SQLITE_BUSY`, zero lost updates, p95 write under 50 ms on local disk.** The test must detect lost updates *by content* — a test asserting only "no corruption, no unhandled error" passes on today's code while losing writes.

Network and synced folders are **refused, not warned about**, by a runtime probe of the volume's locking behavior — not a list of folder-name patterns, which misses mapped drives, junctions and self-hosted servers.

---

### Task 13: `unlink`, and the no-workspace guarantee

`unlink` un-retires the local knowledge tables and flips mode back, journalled like migrate. Copy-back is `knowl export --repo <name>` then `knowl import` — shipped machinery with a divergence policy, not a bespoke flag.

Then the end-to-end regression: a project with no workspace returns identical results, writes no attribution, and produces byte-identical CLI output.

---

## Self-review

**Spec coverage.** Storage redirection → 1. Lifecycle convergence → 2. Tombstone monotonicity and format v2 → 3. Applies-to → 4. Journal → 5. Fence and copy → 6. Atomic activation → 7. Routing → 8. Ownership → 9. Blocked operations → 10. FTS → 11. Concurrency → 12. Unlink and regression → 13.

**Deliberately excluded.** Cross-repo code symbol index — `indexCode` deletes every row absent from the current root, so sharing it means a composite key, a matching composite foreign key, a locator format change breaking four consumers plus persisted `evidence.locator` rows, and a full table rebuild. That is a feature-sized project for an index of files on one machine. The code index stays in the `local` role.

**Known gap.** This plan is specified at the level of intent, interfaces and test obligations, not full TDD code — deliberately, because five of its decisions are open pending v1. Expand each task to full steps when its scope is settled. A plan claiming completeness it does not have is worse than one that says where it thins out.
