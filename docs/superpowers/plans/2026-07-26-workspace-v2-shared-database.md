# Workspace v2 (Shared Database) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status: not executable. Blocked on one product decision, and thinner than it claimed.** An
earlier revision of this line said "complete and buildable"; that was an overclaim, contradicted by
this plan's own self-review, and external review called it correctly. Tasks 6–14 are design intent
with test obligations, not steps. Do not run this document task-by-task.

**Blocking decision, not a task:** see "The cross-owner editing contradiction". Until it is
settled, the goal below cannot be stated honestly, because Task 10 forbids the capability the goal
promises.

**Goal (as previously stated, and now in question):** give linked repos an *optional* shared
knowledge database so cross-repo `knowl_update`, cross-owner duplicate detection and workspace-wide
conflict detection work. `linked` mode stays the default and stays supported; `shared` would be a
second mode, not a migration target.

**Three of this plan's tasks have shipped as v1 bugfixes** and are struck from the task list below:
lifecycle convergence, ownership portability and tombstone monotonicity, in commits `f0d4ff3` and
`7725d02`. They never needed `shared` mode, which is why they were sequenced first, and taking them
out is most of what this plan actually delivered.

**Architecture:** A workspace database at `~/.knowl/workspaces/<name>/knowl.db` becomes the
`knowledge` storage role. Each repo's `<repo>/.knowl/knowl.db` stays exactly where it is, serving
the `local` and `session` roles — code index, host bindings, watermarks, telemetry. Migration
copies rather than moves, is journalled, fences writes per repo, and flips mode last by writing one
file.

**Tech Stack:** TypeScript (ESM, NodeNext), libSQL + Drizzle, vitest, tsup, commander, MCP SDK.

**Source spec:** `docs/superpowers/specs/2026-07-26-multi-repo-workspace-design.md`, section "v2 — the shared database".

**Depends on:** 2.4.0, the whole of `2026-07-26-workspace-v1-federation.md`, and two follow-ups
that closed prerequisites the earlier draft assumed were already true:

- `2aa7f92` — `origin_repo` is stamped at write time (`src/store/write-ownership.ts`, called from
  `createKnowledgeItem` at `src/store/repository.ts:134`). This plan's ownership rules are
  unstateable without it: in one shared table, an unowned row has no answer to who may edit,
  collect or export it. v1 survived the gap because a repo's database held only its own items.
- `8f899f8` — `workspace join` runs the same gate as `workspace add` (`assertSafeToLink`,
  `src/workspace/membership.ts`), and a repo name is retired only when the repo still owns atoms.
  Both entry points must agree on embedding identity before several repos write one vector space.

---

## What v1 answered

Recorded in full in Knowl as decision `21f3504656964cdc`. Condensed:

| Question | Answer | Effect |
| --- | --- | --- |
| Does `linked` mode earn its keep? | **Yes — it is the shipped product.** Peer-labelled federated query, semantic cross-repo ranking (MRR 1.0 semantic / 0.833 positional, `docs/evals/cross-repo-baseline.json`), promote, and per-peer commit watermarks delivering cross-repo notification (2.6.0). | The question inverts: `shared` must justify itself. Both modes ship; no forced migration. |
| Do agents condition on the `repo` label? | **Unknown — never measured.** The label reaches them (`CompactKnowledgeItem` carries `repo`/`namespace`; notification cards carry `[repo]`). Behaviour change was not observed because no sustained multi-repo work has happened. | Keep v1's ties-to-local. **Add no ranking weight.** |
| Is the advisory applies-to table worth building? | **No.** Its only purpose was ranking by repo, which the row above makes unjustified. Nothing read it for a lifecycle decision. | **Cut.** Shape preserved in an appendix so a later reader sees it was decided against, not overlooked. |
| Should `visibility` be mutable after write? | **Promotion only.** The friction v1 produced was the ownership gap blocking promote (fixed), not an inability to demote. | Demotion stays out of scope. |
| Is per-atom batch routing the right partial-failure semantic? | **Yes, on reasoning not measurement.** v1 could not produce data — the question is unreachable until `shared` exists. Rejecting mixed batches pushes agents into per-atom calls, which `knowl_ingest_atoms` exists to prevent. | Task 9's shape unchanged, flagged as reasoned. |

---

## The cross-owner editing contradiction

**This plan promises a capability it also forbids, and that voids most of its justification.**

The goal claims cross-repo `knowl_update` and "editing or superseding an item owned by another
repo". Task 10 then clamps cross-owner resolution to `coexist` and refuses an explicit `supersedes`
naming a foreign item — deliberately, and for a good reason: a write in repo A silently retiring
repo B's knowledge is exactly the failure a single owner per item exists to prevent.

Both positions are defensible. Holding both is not. And v1 already refuses foreign edits
(`assertOwnedItem`, `src/mcp/tools.ts:972`), so as written **v2 adds no editing capability over v1
at all.**

That leaves exactly one unique capability: detecting that two repos hold contradictory or duplicate
knowledge. Which is the thing the cheaper alternative below already provides.

Three ways out, none of them a task in this plan:

1. **Drop cross-owner editing as a claimed benefit.** Honest, and reduces v2 to conflict detection
   — at which point read-only `knowl_conflicts` across peers wins outright on cost.
2. **Design an explicit authorization workflow**: a foreign edit becomes a proposal the owning repo
   accepts or rejects, with its own state, storage, surfacing and conflict rules. That is a
   feature-sized design that does not exist, and it is not obviously cheaper in `shared` mode than
   as a federated exchange.
3. **Allow foreign edits outright**, and accept that any repo can retire any other's knowledge.
   This needs an argument nobody has made.

**Until one is chosen, this plan cannot be executed**, because Task 10's tests and the goal
contradict each other and there is no way to satisfy both.

## Recommendation

**Do not build this.** Stronger than the previous revision's "not yet", because the contradiction
above removes one of the two benefits rather than deferring it.

What v2 uniquely provides, after that: detecting that two repos hold contradictory or duplicate
knowledge. Cross-owner editing is not on the list, per the section above.

What it costs: Tasks 6–8 and 13 — a journalled migration, a per-repo write fence, an atomic
cutover, and making N short-lived processes safely share one SQLite file. Task 13 alone carries a
numeric acceptance bar because its failure mode is silent lost writes.

Against that, every problem real v1 usage surfaced was fixable inside `linked` mode, and all now
are: unowned writes (`2aa7f92`), an unguarded second entry point and a needlessly burned repo name
(`8f899f8`). None needed one database.

**Build when one of these is true**, not before:

- An agent is observed needing to correct knowledge owned by another repo, and export-then-import
  from that repo is measurably worse than editing in place.
- Two linked repos are found holding contradictory active knowledge that federation's read-only
  path could not surface.
- Peer scanning is *measured* as the bottleneck against `docs/evals/cross-repo-suite.json` — not
  assumed from repo count.

**Cheaper alternative for the second bullet:** read-only `knowl_conflicts` across peers. It buys
cross-repo conflict detection with no shared database, no migration and no concurrency work. If
only that capability is wanted, build it instead of this plan.

---

## What review should check first

Five load-bearing claims, each verified against current source on 2026-07-29. A reviewer who
refutes any of these changes the plan, so they are listed separately rather than buried in tasks.

**1. There is one process-wide database handle, and it is the thing being redirected.**
`src/store/database.ts:13-17` holds a single `dbInstance`/`clientInstance` pair; `initDb(root)`
points it at `resolveStorage(root).knowledge` (`database.ts:35`). **29 modules** reach it through
`getDb()`/`getClient()`. Three of them own tables that must *not* move:
`code_files`/`code_symbols`/`code_symbol_edges` (`src/code/symbol-index.ts:132-176`),
`host_session_bindings` (`src/store/host-session-bindings.ts:35-214`), and `mcp_call_commits`
(`src/store/mcp-call-commits.ts:35-66`).

*Consequence:* redirecting `knowledge` without first splitting the handle moves the code index and
host bindings into the shared database. `indexCode` deletes every row absent from the current root
(`symbol-index.ts:156-163`), so one repo's index run would wipe every other repo's. **Task 1 exists
because of this and must precede Task 2.** The earlier draft went straight to path resolution and
would have shipped that bug.

**2. Import already drops ownership, today, in v1.** `exportKnowledge` writes whole item objects
(`portability.ts:34`) and `mapRowToKnowledgeItem` spreads the row (`repository.ts:82-92`), so
`originRepo` and `visibility` (`schema.ts:17,19`) *are* in the file. But `ITEM_COLUMNS`
(`portability.ts:71`) lists 21 columns and includes neither, and both the insert
(`portability.ts:169`) and the update (`portability.ts:179-184`) use it.

*Consequence:* export→import silently resets ownership to NULL and visibility to `'repo'`. This is
a v1 bug independent of v2, and it is load-bearing here because Task 14's `unlink` copy-back is
specified as export-then-import. Fixed in Task 4.

**3. Tombstones can rewind, in two places.** `recordTombstone` overwrites `deleted_at`
unconditionally (`tombstones.ts:19-22`), and import's tombstone upsert does the same
(`portability.ts:202-206`). Import also plans an insert without consulting local tombstones
(`portability.ts:130-131`), so a stale export resurrects a newer delete. Fixing only the import
path leaves the same bug reachable through ordinary GC.

**4. Import classifies before it opens its transaction.** Classification reads at
`portability.ts:116-119`; `BEGIN;` is at `portability.ts:163`. Under one shared database that is a
lost-update window, not a theoretical one.

**5. The version guard is already in place, so the schema bump works.** `assertSchemaSupported`
(`schema-version.ts:46-49`) refuses a database whose `user_version` exceeds this build's. That is
why 2.4.0 shipped it first, and why Task 2's bump to `2` is safe rather than merely declared.

---

## Global Constraints

- Windows dev machine. `npm.cmd`, `npx.cmd`. Grep tool rather than `rg`.
- Test `npm.cmd test`; build `npm.cmd run build`; typecheck baseline **15 pre-existing errors**.
- Relative imports carry `.js`.
- **Bump `KNOWL_SCHEMA_VERSION`** (`src/store/schema-version.ts:11`) in Task 2 — the task that
  first makes a database unreadable by 2.4.x.
- **The export format bumps to version 2** in Task 4, when `origin_repo`, `visibility` and
  `lifecycle_hash` become portable fields. A version-1 reader must refuse version 2 rather than
  silently dropping ownership (`portability.ts:100` is the check to extend).
- **No destructive operation without a journal.** `migrate`, `promote` in linked mode, and `unlink`
  all move items between databases; a crash halfway through any of them must be resumable.
- A repo with no workspace behaves exactly as today. Task 14 asserts it, and every task before it
  must leave that assertion passing.
- **Tasks 3–5 shipped as v1 bugfixes** in `f0d4ff3` and `7725d02`. They were behaviour-preserving in
  `linked` mode, fixed live defects, and never needed `shared` mode. Task 1 is in the same category
  and remains available on its own terms.

## Task order and dependencies

```
Phase A — foundations, no behaviour change in linked mode
  1  split the storage context           (blocks 2; independently valuable)
  2  shared mode redirects knowledge      (needs 1)
  3  lifecycle convergence                SHIPPED f0d4ff3, corrected 7725d02
  4  ownership through export/import      SHIPPED f0d4ff3
  5  tombstones only move forward         SHIPPED f0d4ff3

Phase B — the migration
  6  migration journal                    (needs 2)
  7  fence, snapshot, copy                (needs 6, 3, 4)
  8  atomic activation                    (needs 7)

Phase C — shared-database semantics
  9  write routing below every surface    (needs 2)
 10  ownership enforcement in one database(needs 2)
 11  block what cannot be made safe       (needs 2)
 12  FTS rebuild with ownership columns   (needs 2)
 13  concurrency                          (needs 2; hardest, gates release)

Phase D — exit and guarantee
 14  unlink, federation dormancy, regression
```

## File Structure

| File | Responsibility | Tasks |
| --- | --- | --- |
| `src/store/database.ts` | Role-keyed handles; `getLocalDb`/`getLocalClient` | 1 |
| `src/code/symbol-index.ts`, `src/store/host-session-bindings.ts`, `src/store/mcp-call-commits.ts` | Move to the local handle | 1 |
| `src/store/storage-roles.ts` | `knowledge` resolves to the workspace database in `shared` mode | 2 |
| `src/store/schema-version.ts` | Version bump gating the shared schema | 2 |
| `src/store/namespaces.ts`, `src/store/snapshots.ts`, `src/workspace/resolve.ts` | The three other `resolveStorage` callers, updated together | 2 |
| `src/store/freshness.ts` | `lifecycle_hash` alongside `content_hash` | 3 |
| `src/store/import-policy.ts` | `metadata-divergent` verdict | 3 |
| `src/store/portability.ts` | Ownership columns, format v2, tombstone ordering | 3, 4, 5 |
| `src/store/tombstones.ts` | Monotonic `deleted_at` | 5 |
| `src/workspace/journal.ts` | **New.** Durable per-repo state machine | 6 |
| `src/workspace/fence.ts` | **New.** `knowl_meta` write fence | 7 |
| `src/workspace/migrate.ts` | **New.** Dry-run, copy, re-embed, activate, unlink | 7, 8, 14 |
| `src/store/knowledge-writer.ts` | `routeWrite`; cross-owner clamp | 9, 10 |
| `src/store/gc.ts`, `src/store/snapshots.ts`, `src/store/change-watermark.ts` | Blocked or scoped in a workspace | 11 |
| `src/store/bootstrap.ts` | FTS rebuild with ownership columns | 12 |
| `src/workspace/resolve.ts`, `src/workspace/federated-query.ts` | Federation dormant in `shared` mode | 14 |

---

### Task 1: Split the storage context

**Files:**
- Modify: `src/store/database.ts`, `src/code/symbol-index.ts`, `src/store/host-session-bindings.ts`, `src/store/mcp-call-commits.ts`
- Test: `tests/store/storage-context.test.ts`

**Interfaces:**
- `getLocalDb(): LibSQLDatabase<typeof schema>` and `getLocalClient(): Client`
- `getDb()` / `getClient()` keep their signatures and return the **knowledge** handle
- `closeDb()` closes every role

**Context the implementer needs:** this is the task the earlier draft was missing, and nothing
after it is safe without it. `database.ts:13-17` keeps one handle; `initDb` points it at the
`knowledge` path (`database.ts:35`). Today `local` and `knowledge` are the same file
(`storage-roles.ts:31,33`), so the distinction is invisible — which is exactly why it has to be
made *before* they diverge, not after.

Modules that own or read local-role tables through the knowledge handle:

| Module | Tables | Why it must stay local |
| --- | --- | --- |
| `src/code/symbol-index.ts:132-176` | `code_files`, `code_symbols`, `code_symbol_edges` | `indexCode` deletes every row absent from the current root (`156-163`). Shared, one repo's index run wipes every other's. |
| `src/store/evidence-repository.ts:145-149` | reads `code_symbols` | `resolveSymbolEvidence` checks a stored signature hash against the index. A *reader* of a local table, not an owner — and the kind of caller a table-only inventory misses. |
| `src/store/host-session-bindings.ts:35-214` | `host_session_bindings` | Binds a *host session* on this machine to a memory session. Meaningless across repos, and holds the per-peer watermark JSON (`165-188`). |
| `src/store/mcp-call-commits.ts:35-66` | `mcp_call_commits` | Keyed by `project_root`. Every repo writing one table makes the key load-bearing where it is currently incidental. |

**The inventory above is still not proven complete, and that is the task's main risk.** It was
assembled by grepping `getDb()`/`getClient()` across 29 modules and reasoning about each table.
`evidence-repository.ts` was missed on the first pass precisely because it reads a local table
without owning one. **Step 1 of this task is to produce a table-to-role map covering every table
`bootstrapSchema` creates, and a caller-to-role map for all 29 modules**, checked in as a test
fixture so a new caller landing on the wrong handle fails rather than works by luck.

**A foreign key crosses the split, and the naive assignment breaks it.**
`host_session_bindings.memory_session_id` references `memory_sessions.id` with
`ON DELETE CASCADE` (`src/store/schema.ts:123`). `memory_sessions` is reached through
`getClient()` (`src/store/session-repository.ts:17`), so moving bindings to `local` while sessions
follow `knowledge` puts the two sides of a foreign key in different files, and creating a binding
fails because the referenced session is not there.

Three options, and the task must pick one before writing code:

1. **`memory_sessions` is local too.** Defensible: a memory session is machine-and-repo scoped, like
   the binding that points at it. But `session-repository` is reached under
   `withNamespaceDatabase(sessionNamespace(root))` in some paths and the bare handle in others, so
   this needs the caller map above before it can be asserted.
2. **Drop the foreign key** and enforce the relationship in code. Cheap, and loses cascade delete —
   which is what currently cleans up bindings when a session is removed.
3. **Bindings follow `knowledge`.** Wrong: the per-peer watermark is machine-local state, and in a
   shared database every repo's bindings would collide in one table.

Option 1 is most likely correct, but it is a decision with consequences, not a detail.

The pool is keyed by path (`connection-pool.ts`, `acquireClient(dbPath)`), so in `linked` mode both
roles resolve to the same file and get the **same pooled client**. There is no second connection in
the common case, and `getClient() === getLocalClient()` holds — assert it, because it is what makes
this task a no-op today.

`withDbPath` (`database.ts:58-71`) swaps the process-wide handle for namespace reads; after this
task it swaps **only the knowledge slot**, so a session-namespace read cannot move the code index.

Both files receive the full schema from bootstrap. Unused tables stay empty; that is cheaper and
safer than a second schema variant, and it means an unlinked repo's file is byte-comparable to
today's.

- [ ] **Step 1: Write the failing test**

Create `tests/store/storage-context.test.ts`:

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, getLocalClient, initDb, initDbPath } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

const ROOT = path.resolve('./.knowl-storage-context');
const ELSEWHERE = path.resolve('./.knowl-storage-context-shared/knowl.db');

describe('storage context', () => {
  beforeEach(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.rm(path.dirname(ELSEWHERE), { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await saveConfig(ROOT, { ...DEFAULT_CONFIG });
  });
  afterEach(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.rm(path.dirname(ELSEWHERE), { recursive: true, force: true }).catch(() => {});
  });

  it('serves both roles from one pooled client when they resolve to one file', async () => {
    // The whole point of doing this before the paths diverge: today it is a no-op, and this
    // assertion is what proves it.
    await initDb(ROOT);
    expect(getLocalClient()).toBe(getClient());
  });

  it('keeps the code index on the local handle when knowledge points elsewhere', async () => {
    // A source file, so the index has something to write. Asserting only
    // `local >= 0` would pass on an empty repo while proving nothing -- and would still
    // pass if indexCode had written every row into the shared database.
    await fs.writeFile(path.join(ROOT, 'sample.ts'), 'export function sample() { return 1; }\n');
    await initDb(ROOT);
    await initDbPath(ELSEWHERE, { configRoot: ROOT, role: 'knowledge' });

    const { indexCode } = await import('../../src/code/symbol-index.js');
    await indexCode(ROOT);

    const local = await getLocalClient().execute('SELECT COUNT(*) AS n FROM code_files');
    const shared = await getClient().execute('SELECT COUNT(*) AS n FROM code_files');
    expect(Number(local.rows[0].n)).toBeGreaterThan(0);
    expect(Number(shared.rows[0].n)).toBe(0);
  });

  it('keeps host bindings local', async () => {
    await initDb(ROOT);
    await initDbPath(ELSEWHERE, { configRoot: ROOT, role: 'knowledge' });

    const { bindHostSession } = await import('../../src/store/host-session-bindings.js');
    await bindHostSession({ host: 'test', hostSessionId: 's1', memorySessionId: 'm1' });

    const shared = await getClient().execute('SELECT COUNT(*) AS n FROM host_session_bindings');
    const local = await getLocalClient().execute('SELECT COUNT(*) AS n FROM host_session_bindings');
    expect(Number(local.rows[0].n)).toBe(1);
    expect(Number(shared.rows[0].n)).toBe(0);
  });

  it('keeps mcp call commits local', async () => {
    // Named separately because it has to be exercised separately. Folding it into the
    // binding test above named a table the test never touched.
    await initDb(ROOT);
    await initDbPath(ELSEWHERE, { configRoot: ROOT, role: 'knowledge' });

    const { recordMcpCallCommit } = await import('../../src/store/mcp-call-commits.js');
    await recordMcpCallCommit({ projectRoot: ROOT, toolName: 'knowl_query', fromRowid: 0, toRowid: 1 });

    const shared = await getClient().execute('SELECT COUNT(*) AS n FROM mcp_call_commits');
    const local = await getLocalClient().execute('SELECT COUNT(*) AS n FROM mcp_call_commits');
    expect(Number(local.rows[0].n)).toBe(1);
    expect(Number(shared.rows[0].n)).toBe(0);
  });

  it('resolves symbol evidence against the local index, not the shared database', async () => {
    // The reader that a table-only inventory missed.
    await fs.writeFile(path.join(ROOT, 'sample.ts'), 'export function sample() { return 1; }\n');
    await initDb(ROOT);
    const { indexCode } = await import('../../src/code/symbol-index.js');
    await indexCode(ROOT);
    await initDbPath(ELSEWHERE, { configRoot: ROOT, role: 'knowledge' });

    const { resolveSymbolEvidence } = await import('../../src/store/evidence-repository.js');
    const locator = String((await getLocalClient().execute('SELECT locator FROM code_symbols LIMIT 1')).rows[0].locator);
    // Resolves against a populated index rather than reporting "symbol gone" because it
    // looked in a database that has no code index at all.
    expect((await resolveSymbolEvidence({ locator } as never)).status).not.toBe('missing');
  });

  it('closes every role', async () => {
    await initDb(ROOT);
    await initDbPath(ELSEWHERE, { configRoot: ROOT, role: 'knowledge' });
    await closeDb();
    expect(() => getClient()).toThrow(/not been initialized/i);
    expect(() => getLocalClient()).toThrow(/not been initialized/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run tests/store/storage-context.test.ts`
Expected: FAIL — `getLocalClient` does not exist and `initDbPath` takes no `role`.

- [ ] **Step 3: Write minimal implementation**

In `src/store/database.ts`, replace the five module-level singletons with a role-keyed registry:

```typescript
type Handle = {
  db: LibSQLDatabase<typeof schema>;
  client: Client;
  databasePath: string;
  configRoot: string;
};

// Keyed by role rather than one pair of singletons. In linked mode both roles resolve to the
// same path and `acquireClient` returns the same pooled client, so this is a no-op today --
// which is the only safe moment to introduce it.
const handles = new Map<'local' | 'knowledge', Handle>();
```

`initDb(projectRoot)` populates **both** roles from `resolveStorage(projectRoot)`.
`initDbPath(dbPath, { configRoot, role = 'knowledge' })` populates one.

`getDb`/`getClient`/`getProjectRoot`/`getConfigRoot` read the `knowledge` handle and keep their
current error text, so no caller changes. Add `getLocalDb`/`getLocalClient` reading `local`,
falling back to `knowledge` when no local handle is registered — a namespace swap registers only
`knowledge`, and a session read must not crash for want of a code index.

`closeDb()` clears the map and calls `releaseAll()` exactly once, keeping the comment at
`database.ts:116-118` about Windows WAL sidecars.

`withDbPath` swaps only the `knowledge` handle and restores it in `finally`.

Then change the three local-role modules from `getClient()` to `getLocalClient()` — a mechanical
substitution in `symbol-index.ts`, `host-session-bindings.ts` and `mcp-call-commits.ts`. Do not
change any other module: everything else is knowledge-role or session-role and stays as it is.

- [ ] **Step 4: Run test to verify it passes** — PASS, 4 tests
- [ ] **Step 5: Verify suite and typecheck** — full suite green, 15 errors
- [ ] **Step 6: Commit**

```
refactor(store): give local and knowledge roles separate handles

One process-wide client served every role, so redirecting knowledge would have
taken the code index, host session bindings and mcp call commits with it.
indexCode deletes every row absent from the current root, which in a shared
database means one repo's index run wiping every other repo's.

Both roles resolve to the same file today and the pool is keyed by path, so
they share one pooled client and this changes no behaviour -- which is the only
safe moment to make the split.
```

---

### Task 2: `shared` mode redirects the knowledge role only

**Files:**
- Modify: `src/store/database.ts` (**the one that matters — see below**), `src/store/storage-roles.ts`, `src/store/schema-version.ts`, `src/workspace/manifest.ts`, `src/store/namespaces.ts`, `src/store/snapshots.ts`, `src/workspace/resolve.ts`
- Test: `tests/store/shared-mode-storage.test.ts`, `tests/store/shared-mode-initdb.test.ts`

**Interfaces:**
- `resolveStorage(root, config?, workspace?)` — when the workspace's mode is `shared`,
  `knowledge` resolves to `<workspace-dir>/knowl.db`
- `KNOWL_SCHEMA_VERSION` becomes `2`
- `WorkspaceManifest.mode` already exists (`manifest.ts:6,27`) and already defaults to `'linked'`
  on read (`manifest.ts:59`) — no schema work needed there, only the redirect

**Context the implementer needs:** **mode lives only in the manifest.** Not in any repo's config.
That is what makes activation a single atomic file write in Task 8. Flipping mode across the
manifest *and* every repo's config is a multi-writer cutover with no atomicity: a crash midway
leaves some repos `shared` and others not, with no recovery procedure and no way to tell which
state you are in.

**`initDb` is the call site that decides whether this feature exists at all.** `resolveStorage` has
four callers: `database.ts:35`, `namespaces.ts:13` (`projectNamespace`), `snapshots.ts:18`
(`databasePath`) and `resolve.ts:45` (peer database paths). An earlier revision of this task listed
the last three and omitted the first — which is the one every CLI command and every MCP write goes
through. `initDb(projectRoot)` calls `resolveStorage(projectRoot)` with no workspace argument, so
the resolver tests would all have passed while every real write still landed in the repo's own
database. **A resolver test is not evidence that the feature works.**

The obstacle is that `initDb` is synchronous in spirit and `resolveWorkspace` is async and reads
the manifest from disk. Options:

1. **`initDb` resolves the workspace itself** (it is already `async`), accepting one manifest read
   per open. Simple, and the read is small and cacheable per root.
2. **Callers pass an already-resolved workspace.** Faster, but `initDb` has many call sites and any
   one that forgets silently writes to the wrong database — the same class of bug as the omission
   above.

Option 1, with the per-root cache `src/store/write-ownership.ts` already established for exactly
this problem.

**The other three callers must move in the same commit.** The header comment on
`storage-roles.ts:14-18` names the hazard — the paths "agree only by coincidence", and "a query and
a snapshot reading different files is not a failure anything reports".

`tests/store/shared-mode-initdb.test.ts` is the test that would have caught the omission: link two
repos into a `shared` workspace on disk, run a real `knowl_store` through the writer, and assert
the row lands in the workspace database and **not** in either repo's own file. It must drive the
production entry point, not `resolveStorage`.

`resolve.ts:45` is the subtle one: in `shared` mode there are no peer databases, because everyone
is in the same file. It must resolve peers to the shared path, and Task 14 makes federation dormant
so nothing scans them.

`local` and `session` never move.

- [ ] **Step 1: Write the failing test**

Create `tests/store/shared-mode-storage.test.ts`:

```typescript
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveStorage } from '../../src/store/storage-roles.js';
import { KNOWL_SCHEMA_VERSION } from '../../src/store/schema-version.js';
import { createManifest } from '../../src/workspace/manifest.js';
import { workspaceDir } from '../../src/workspace/paths.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import type { ActiveWorkspace } from '../../src/workspace/resolve.js';

const ROOT = path.resolve('./some-repo');
const active = (mode: 'linked' | 'shared'): ActiveWorkspace => ({
  name: 'ws', repo: 'server', peers: [],
  manifest: { ...createManifest('ws', null), mode },
});

describe('shared mode storage', () => {
  it('redirects knowledge to the workspace database', () => {
    process.env.KNOWL_HOME = path.resolve('./.knowl-shared-home');
    expect(resolveStorage(ROOT, DEFAULT_CONFIG, active('shared')).knowledge)
      .toBe(path.join(workspaceDir('ws'), 'knowl.db'));
    delete process.env.KNOWL_HOME;
  });

  it('leaves local and session anchored to the repo in both modes', () => {
    process.env.KNOWL_HOME = path.resolve('./.knowl-shared-home');
    for (const mode of ['linked', 'shared'] as const) {
      const storage = resolveStorage(ROOT, DEFAULT_CONFIG, active(mode));
      expect(storage.local).toBe(path.join(ROOT, '.knowl', 'knowl.db'));
      expect(storage.session).toBe(path.join(ROOT, '.knowl', 'session.db'));
    }
    delete process.env.KNOWL_HOME;
  });

  it('leaves knowledge in the repo under linked mode', () => {
    expect(resolveStorage(ROOT, DEFAULT_CONFIG, active('linked')).knowledge)
      .toBe(path.join(ROOT, '.knowl', 'knowl.db'));
  });

  it('is unchanged with no workspace at all', () => {
    const storage = resolveStorage(ROOT);
    expect(storage.knowledge).toBe(path.join(ROOT, '.knowl', 'knowl.db'));
    expect(storage.local).toBe(storage.knowledge);
  });

  it('bumps the schema version, so 2.4.x refuses a shared database', () => {
    expect(KNOWL_SCHEMA_VERSION).toBeGreaterThanOrEqual(2);
  });
});
```

Add to the same file a caller-agreement test — the failure `storage-roles.ts` exists to prevent:

```typescript
  it('agrees across every resolveStorage caller in shared mode', async () => {
    process.env.KNOWL_HOME = path.resolve('./.knowl-shared-home');
    const ws = active('shared');
    const { projectNamespace } = await import('../../src/store/namespaces.js');
    const { knowledgeDatabasePath } = await import('../../src/store/snapshots.js');
    const expected = resolveStorage(ROOT, DEFAULT_CONFIG, ws).knowledge;
    // A query and a snapshot reading different files is not a failure anything reports.
    expect(projectNamespace(ROOT, ws).databasePath).toBe(expected);
    expect(knowledgeDatabasePath(ROOT, ws)).toBe(expected);
    delete process.env.KNOWL_HOME;
  });
```

- [ ] **Step 2: Run test to verify it fails** — `resolveStorage` takes two arguments and ignores mode
- [ ] **Step 3: Write minimal implementation**

```typescript
export function resolveStorage(
  root: string,
  _config?: ProjectConfig,
  workspace?: { manifest: { name: string; mode?: WorkspaceMode } } | null,
): ResolvedStorage {
  const knowlDir = path.join(root, '.knowl');
  const local = path.join(knowlDir, 'knowl.db');
  // Only `knowledge` is ever redirected. `local` holds the code index, host bindings and
  // watermarks; indexCode deletes every row absent from the current root, so a shared code
  // index would let one repo's index run wipe every other repo's. See Task 1.
  const knowledge = workspace?.manifest.mode === 'shared'
    ? path.join(workspaceDir(workspace.manifest.name), 'knowl.db')
    : local;
  return { local, session: path.join(knowlDir, 'session.db'), knowledge };
}
```

Thread the optional workspace through `projectNamespace`, `snapshots.databasePath` (exported as
`knowledgeDatabasePath` for the test above) and `resolve.ts`'s peer mapping. Bump
`KNOWL_SCHEMA_VERSION` to `2` with a comment naming this change as the reason.

**Import-cycle warning:** `storage-roles.ts` importing `workspace/paths.js` is fine (`paths.ts` has
no store imports), but it must not import `workspace/manifest.js` for the `WorkspaceMode` type —
`manifest.ts` imports from `store/embedding-identity.js`. Declare the mode union structurally in
the parameter type, as written above.

- [ ] **Step 4: Run test to verify it passes** — PASS, 6 tests
- [ ] **Step 5: Verify suite and typecheck** — 15 errors
- [ ] **Step 6: Commit**

---

### Task 3: Lifecycle convergence — **SHIPPED** (`f0d4ff3`, corrected by `7725d02`)

Built as a v1 bugfix. Kept below as the record of what was decided and why.

**One thing the first attempt got wrong, worth carrying into any similar task.** It treated a
missing lifecycle hash as agreement, reasoning that a version-1 export carries none and every legacy
file would otherwise read as divergent. But a version-1 export *does* carry the underlying fields —
it serialises whole item objects — so the absence of a hash was never an absence of information. The
effect was that a promotion exported by an older build silently never converged, and because the
column is added without a backfill, every pre-existing row hit the same path. Both sides now derive
the fingerprint from the fields when no hash is stored. **The lesson: a fallback that discards
information available elsewhere is a silent feature-off switch, not a compatibility shim.**

**Files:**
- Modify: `src/store/freshness.ts`, `src/store/import-policy.ts`, `src/store/portability.ts`, `src/store/schema.ts`, `src/store/bootstrap.ts`
- Test: `tests/store/lifecycle-hash.test.ts`

**Interfaces:**
- `hashKnowledgeLifecycle(input: { status; freshness; supersededById; originRepo; visibility }): string`
- `knowledge_items.lifecycle_hash TEXT` (additive column, no version bump needed)
- `classifyIncomingItem` returns `'new' | 'identical' | 'divergent' | 'metadata-divergent'`

**Context the implementer needs:** `content_hash` covers title, content, reasoning, source and
paths (`freshness.ts:20-38`). Equal hashes classify as `identical` (`import-policy.ts:20`) and the
import plan skips the item outright (`portability.ts:132`). So promoting an item to workspace
visibility, retiring it, superseding it or marking it stale changes nothing an export can carry —
the receiving side keeps its old copy and the two never converge. That breaks `promote` across
machines, Task 14's copy-back, and any workspace export.

**Do not widen `content_hash`.** It would change every existing item's identity and break the
verbatim adoption that makes re-import idempotent (`portability.ts:173-184`) — the same trap that
killed path qualification during design. `confidence` is excluded from the lifecycle hash
deliberately: it moves on ordinary use and would make almost every item permanently divergent.

**This task fixes a live v1 bug** and is worth taking whether or not v2 is built.

- [ ] **Step 1: Write the failing test**

Create `tests/store/lifecycle-hash.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { hashKnowledgeContent, hashKnowledgeLifecycle } from '../../src/store/freshness.js';
import { classifyIncomingItem } from '../../src/store/import-policy.js';

const base = { status: 'active', freshness: 'fresh', supersededById: null, originRepo: 'server', visibility: 'repo' };

describe('lifecycle hash', () => {
  it('changes when visibility changes', () => {
    expect(hashKnowledgeLifecycle({ ...base, visibility: 'workspace' })).not.toBe(hashKnowledgeLifecycle(base));
  });

  it('changes when status, supersession or owner changes', () => {
    expect(hashKnowledgeLifecycle({ ...base, status: 'superseded' })).not.toBe(hashKnowledgeLifecycle(base));
    expect(hashKnowledgeLifecycle({ ...base, supersededById: 'abc' })).not.toBe(hashKnowledgeLifecycle(base));
    expect(hashKnowledgeLifecycle({ ...base, originRepo: 'api' })).not.toBe(hashKnowledgeLifecycle(base));
  });

  it('excludes confidence, which moves on ordinary use', () => {
    // Including it would make almost every item permanently divergent.
    expect(hashKnowledgeLifecycle({ ...base, confidence: 0.5 } as never)).toBe(hashKnowledgeLifecycle(base));
  });

  it('leaves content_hash untouched, so item identity is unchanged', () => {
    const content = { title: 'T', content: 'C', reasoning: null, source: null, affectedPaths: null };
    const before = hashKnowledgeContent(content);
    hashKnowledgeLifecycle({ ...base, visibility: 'workspace' });
    expect(hashKnowledgeContent(content)).toBe(before);
  });
});

describe('classifyIncomingItem', () => {
  const local = { id: 'x', contentHash: 'c1', lifecycleHash: 'l1', updatedAt: '2026-01-02T00:00:00.000Z', version: 2 };

  it('is identical when both hashes match', () => {
    expect(classifyIncomingItem({ ...local }, local)).toBe('identical');
  });

  it('is metadata-divergent when only the lifecycle hash differs', () => {
    // The case that silently did not converge: a promoted item exported and imported
    // elsewhere kept its old visibility.
    expect(classifyIncomingItem({ ...local, lifecycleHash: 'l2' }, local)).toBe('metadata-divergent');
  });

  it('is divergent when the content hash differs, whatever the lifecycle hash', () => {
    expect(classifyIncomingItem({ ...local, contentHash: 'c2' }, local)).toBe('divergent');
    expect(classifyIncomingItem({ ...local, contentHash: 'c2', lifecycleHash: 'l2' }, local)).toBe('divergent');
  });

  it('is new when there is no local row', () => {
    expect(classifyIncomingItem({ ...local }, undefined)).toBe('new');
  });

  it('treats a missing incoming lifecycle hash as matching, so v1 exports still import', () => {
    expect(classifyIncomingItem({ ...local, lifecycleHash: undefined }, local)).toBe('identical');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Write minimal implementation**

In `src/store/freshness.ts`:

```typescript
/**
 * A fingerprint over the fields that decide an item's lifecycle rather than its content.
 *
 * Separate from `content_hash` on purpose. Widening content_hash to cover these would change
 * every existing item's identity and break the verbatim adoption that makes re-import
 * idempotent -- the same trap that killed path qualification.
 *
 * `confidence` is excluded: it moves on ordinary use, and including it would leave almost
 * every item permanently divergent.
 */
export function hashKnowledgeLifecycle(input: {
  status?: string | null;
  freshness?: string | null;
  supersededById?: string | null;
  originRepo?: string | null;
  visibility?: string | null;
}): string {
  return createHash('sha256').update(JSON.stringify({
    status: input.status ?? 'active',
    freshness: input.freshness ?? DEFAULT_FRESHNESS,
    supersededById: input.supersededById ?? null,
    originRepo: input.originRepo ?? null,
    visibility: input.visibility ?? 'repo',
  })).digest('hex');
}
```

In `src/store/import-policy.ts`, add `lifecycleHash?: string | null` to `ImportCandidate` and
`LocalItemRow`, and:

```typescript
export function classifyIncomingItem(
  incoming: ImportCandidate,
  local: LocalItemRow | undefined,
): 'new' | 'identical' | 'divergent' | 'metadata-divergent' {
  if (!local) return 'new';
  if (String(incoming.contentHash ?? '') !== String(local.contentHash ?? '')) return 'divergent';
  // A v1 export carries no lifecycle hash. Treat its absence as agreement rather than as a
  // difference, or every legacy file imports as metadata-divergent.
  if (incoming.lifecycleHash == null) return 'identical';
  return String(incoming.lifecycleHash) === String(local.lifecycleHash ?? '') ? 'identical' : 'metadata-divergent';
}
```

In `src/store/portability.ts`, extend the local-row SELECT (`:116-119`) to read `lifecycle_hash`,
add a `metadata` plan action resolved by the existing `newer` policy, and apply it as a
metadata-only update that **writes `content_hash` verbatim** so the next round classifies as
identical and the two sides stop trading updates.

Add `lifecycle_hash` as an additive column in `bootstrap.ts` beside `ensureOwnershipColumns`
(`bootstrap.ts:391-404` is the pattern to follow), backfilled for existing rows, plus the Drizzle
column in `schema.ts`.

Write the hash wherever the fields it covers change: `createKnowledgeItem` and
`updateKnowledgeItem` in `repository.ts`, and `promoteItems` in `workspace/promote.ts`.

- [ ] **Step 4: Run test to verify it passes** — PASS, 10 tests
- [ ] **Step 5: Verify suite and typecheck** — 15 errors
- [ ] **Step 6: Commit**

---

### Task 4: Ownership survives export and import — **SHIPPED** (`f0d4ff3`)

Built as a v1 bugfix. One thing the task did not anticipate: **promotion had to start advancing
`updated_at`.** Divergence resolution orders by it and keeps local on a tie, so a promotion that
left the timestamp alone was a change no other machine could ever prefer — the fix to the column
list would have been inert without it. `content_hash` still does not move.

**Files:**
- Modify: `src/store/portability.ts`
- Test: `tests/store/export-ownership.test.ts`

**Context the implementer needs:** **this is a live v1 bug, verified.** `ITEM_COLUMNS`
(`portability.ts:71`) lists 21 columns and includes neither `origin_repo` nor `visibility`, while
export emits both (`portability.ts:34` writing the whole item; `repository.ts:82-92` spreading the
row; `schema.ts:17,19`). Both the insert (`:169`) and the update (`:179-184`) use `ITEM_COLUMNS`.

So today: export a workspace-visible item owned by `server`, import it anywhere, and it comes back
owned by nobody with visibility `'repo'`. Nothing reports it. Task 14 specifies copy-back as
export-then-import, so this must be fixed before that task can be believed.

The export header bumps to **version 2** (`portability.ts:31`), because the file now carries fields
a version-1 reader would drop. A version-1 reader must **refuse** version 2 rather than silently
dropping ownership — extend the check at `portability.ts:100`. A version-2 reader accepts a
version-1 file with the missing fields defaulted (`origin_repo` NULL, `visibility` `'repo'`), which
is exactly what a v1 export means.

`lifecycle_hash` from Task 3 joins the same column list and the same format bump. Sequence Task 3
first so this is one format change rather than two.

**Test obligations:**
- A round trip preserves `origin_repo` and `visibility` (the regression test for the bug).
- A version-1 file imports with ownership defaulted, not rejected.
- A version-1 *reader* refuses a version-2 file with a message naming the version.
- The manifest checksum still validates after the header change.
- Column count in `ITEM_COLUMNS` matches the placeholder count — the `new Array(21)` at
  `portability.ts:169` is a hardcoded literal and is the obvious thing to get wrong; derive it from
  the column list instead.

- [ ] **Steps 1–6** following the established pattern.

---

### Task 5: Deletes only move forward — **SHIPPED** (`f0d4ff3`)

Built as a v1 bugfix. One thing the task did not anticipate: **blocking an item's insert had to
block its dependents.** Assertions and evidence links carry a foreign key to `knowledge_items`, so
skipping the item while inserting them fails the constraint and rolls back every unrelated item in
the same file. Found by a test, not by the plan.

**Files:**
- Modify: `src/store/tombstones.ts`, `src/store/portability.ts`
- Test: `tests/store/tombstone-monotonicity.test.ts`

**Context the implementer needs:** two separate defects, both verified, both live in v1.

Import plans an insert without consulting local tombstones (`portability.ts:130-131`), so a stale
export resurrects an item deleted after that export was taken. And the tombstone upsert overwrites
`deleted_at` unconditionally in **both** `portability.ts:202-206` and `recordTombstone`
(`tombstones.ts:19-22`), so an older tombstone rewinds a newer one. Fix both sites; fixing only the
import path leaves the same bug reachable through ordinary GC.

The fix is a guarded upsert in both places:

```sql
ON CONFLICT(id) DO UPDATE SET
  deleted_at = excluded.deleted_at, reason = excluded.reason
WHERE excluded.deleted_at > knowledge_tombstones.deleted_at
```

**Test obligations:** a stale export cannot resurrect a newer delete; an old tombstone does not
rewind a newer one through `recordTombstone`; the same through import; `pruneTombstones` is
unaffected; a tombstone with an equal timestamp is a no-op rather than an error.

- [ ] **Steps 1–6.**

---

### Task 6: The migration journal

**Files:** Create `src/workspace/journal.ts`; Test `tests/workspace/journal.test.ts`

**Interfaces:**
- `type RepoState = 'pending' | 'fenced' | 'exported' | 'imported' | 'done'`
- `type Journal = { version: 1; workspace: string; startedAt: string; repos: Record<string, RepoState> }`
- `readJournal(dir)`, `writeJournal(dir, journal)`, `advance(dir, repo, state)`, `clearJournal(dir)`

**Context the implementer needs:** `<workspace-dir>/migration.json` is the source of truth for what
has happened, **not the filesystem**. A crash resumes at the recorded state rather than restarting,
and a repo already marked `done` is never re-migrated. A corrupt journal fails loudly: silently
restarting a partially-applied migration is how you get a half-copied workspace nobody can reason
about.

State transitions are forward-only. `advance` rejects a backward move rather than accepting it,
because the only thing that produces one is a bug or a stale process.

**Test obligations:** a killed process resumes at the recorded state; a `done` repo is skipped; a
corrupt journal throws rather than starting over; `clearJournal` only succeeds when every repo is
`done`; a backward `advance` throws.

- [ ] **Steps 1–6.**

---

### Task 7: Fence, snapshot, copy

**Files:** Create `src/workspace/fence.ts`, `src/workspace/migrate.ts`; Test `tests/workspace/migrate.test.ts`

**Context the implementer needs:** per repo — set a `migrating` marker in `knowl_meta` making every
knowledge write fail with a clear message; export at the fence; import into the workspace database
setting `origin_repo` and routing `visibility` by category; re-embed anything not matching the
pinned identity; mark local knowledge retired and bump its `user_version`; lift the fence.

**The fence is not optional, and it must not lift before activation.** An earlier revision said the
fence was "per repo and short-lived, so the other repos stay usable throughout" — lifted as soon as
that repo's copy finished. That is a write-loss window, not a convenience: Task 8 flips the
manifest only after *every* repo reports `done`, so a write made to an already-copied repo in the
interval goes into a database that stops being read at activation, was never re-exported, and is
reported by nothing. With N repos the window is as long as the slowest remaining migration.

The fence therefore **holds from the moment a repo is fenced until activation completes**, and is
lifted for all repos together afterwards. Migration is a maintenance operation with a stated
outage, not a live one. Claiming otherwise is what produced the bug.

**Lifting the fence is not enough on its own: live processes keep their handle.** Each host session
runs its own `serve` process (`src/mcp/server.ts`), and `initDb` resolves storage once. A process
that started before activation holds a handle to the repo-local database and will keep writing to
it after the manifest flips, with no error anywhere. So the protocol needs a third element beyond
fence and flip: **handle invalidation**. Either the fence marker is re-checked on every knowledge
write — cheap, one `knowl_meta` read, and it makes a stale process fail loudly instead of writing
into an abandoned file — or every `serve` process is stopped for the cutover. The first is
preferable because the second cannot be enforced from inside Knowl.

This makes the fence a *database-enforced* invariant rather than a phase of a script, which is the
only form that survives a process the migration does not know about.

**Copy, never move.** The canonical path is never renamed. An old client opening
`<repo>/.knowl/knowl.db` and finding nothing would create a *fresh* database and never meet the
version guard — which is the whole reason 2.4.0 shipped `assertSchemaSupported` first.

**Merging does not collapse duplicates.** Import matches on **id** (`portability.ts:116-118`), and
ids are random per repo, so two repos that independently recorded the same fact produce two
surviving rows. That is correct — each repo did record it, and each copy keeps its own owner and
history — but the dry run must report the count so the number is not a surprise. Task 10's
cross-owner near-duplicate report is what surfaces them afterwards.

**Embedding re-indexing is not optional either.** `workspace add`/`join` pin one embedding identity
(`assertSafeToLink`, `src/workspace/membership.ts`), so in the normal case nothing needs re-embedding.
But a repo linked before that gate existed, or one whose config drifted, can hold vectors from
another model. Migration is the only moment where every item is in hand, so re-embed anything whose
stored identity does not match the manifest's, and report the count in the dry run.

**Test obligations:** a write during the fence fails with the migration message; **a write to an
already-copied repo, while a later repo is still migrating, fails rather than being accepted and
lost**; **a process that opened its handle before activation fails its next knowledge write rather
than writing into the abandoned file**; killing the process after export leaves mode unflipped and
the repo usable; migrate is idempotent; the local file still exists at its canonical path with a
bumped `user_version`; the dry run reports duplicate and re-embed counts; a repo whose embedding
identity differs is re-embedded rather than silently carried across.

- [ ] **Steps 1–6.**

---

### Task 8: Atomic activation

**Files:** Modify `src/workspace/migrate.ts`; Test `tests/workspace/activation.test.ts`

Flip `mode` in `workspace.json` once, after every repo reports `done`. One file write, so no
mixed-mode state can exist.

Write it through the same temp-file-and-rename discipline `writeManifest` uses
(`src/workspace/manifest.ts:66-69` currently writes directly — **harden it in this task**, because
a torn manifest write is the one failure this design has no recovery for).

**Test obligations:** mode does not flip while any repo is not `done`; after activation every repo
resolves `knowledge` to the workspace database; before activation every repo still resolves to its
own; a crash between the last `done` and the flip leaves a resumable state; a torn write leaves the
previous manifest readable.

- [ ] **Steps 1–6.**

---

### Task 9: Write routing below every surface

**Files:** Modify `src/store/knowledge-writer.ts`, `src/mcp/tools.ts`; Test `tests/store/write-routing.test.ts`

**Interfaces:** `routeWrite(atom, context): { visibility: 'repo' | 'workspace'; originRepo: string | null }`

**Context the implementer needs: `routeWrite` belongs in `repository.createKnowledgeItem`, not in
`knowledge-writer`.** An earlier revision put it in `knowledge-writer` on the grounds that
synthesis, candidate promotion and the extraction pipeline bypass the MCP tools. They do — but they
bypass `knowledge-writer` too, calling the repository directly:

| Caller | Line |
| --- | --- |
| `src/store/synthesis.ts` | `:51` — `createKnowledgeItem(projectId, input)` |
| `src/pipeline/merge.ts` | `:59` — `repo.createKnowledgeItem(...)` inside the merge transaction |
| `src/store/knowledge-actions.ts` | `:56` — `repo.createKnowledgeItem(...)` for `knowl_decide` |

Routing in `knowledge-writer` would therefore miss `knowl_decide`, every synthesized item and every
item the extraction pipeline merges — three of the paths the placement was supposed to protect.

`2aa7f92` put ownership stamping in `createKnowledgeItem` (`repository.ts:134`) precisely because
that is the single funnel. Visibility routing has the same requirement and must sit beside it. The
rule for this task: **anything that must be true of every knowledge row goes at the repository
mutation boundary; nothing above it is a boundary at all.**

Default is category-driven: `decision`, `constraint`, `architecture`, `goal` → `workspace`;
`fact`, `state`, `skill` → repo. **`skill` never crosses**: a skill atom points at files under the
writing repo's `.knowl/skills/`, and `recordSkillRun` matches on exact `source` equality, so a
shared skill atom would list a skill whose `SKILL.md` does not exist locally.

Batch writes partition by destination, each partition in its own transaction, with a per-atom
destination reported. A failing partition does not roll back the others — that is the
partial-failure semantic, stated rather than avoided. Rejecting mixed batches was the alternative
and is worse: it pushes agents into per-atom calls, which is what `knowl_ingest_atoms` exists to
prevent. Flagged in "What v1 answered" as reasoned rather than measured.

**Test obligations:** items created through `synthesizeKnowledge`, `knowl_decide` and the
extraction pipeline's merge are each routed rather than defaulted, **asserted separately** — one
test per bypass path, because a single test through `knowledge-writer` is what hid the problem; an
explicit `namespace` overrides the category default in both directions; `skill` never routes to
workspace even when explicitly asked; a mixed batch reports per-atom destinations; one failing
partition leaves the others committed; in `linked` mode routing is inert and visibility stays
`'repo'`.

- [ ] **Steps 1–6.**

---

### Task 10: Ownership enforcement in one database

**Files:** Modify `src/store/knowledge-writer.ts`, `src/store/gc.ts`, `src/store/drift.ts`, `src/store/recent-context.ts`, `src/store/context-composer.ts`; Test `tests/store/shared-ownership.test.ts`

**Context the implementer needs:** in a shared database every repo's items sit in one table, so the
ownership rules that were structural in v1 become explicit checks. This is where v1's two deferred
tasks land.

`storeKnowledgeItemDeduped` finds a likely duplicate across the whole database
(`knowledge-writer.ts:203`) and, on a `supersede` resolution, retires it (`:233-236`). `46596c7`
widened detection from an exact title match to `sameSubjectTitle` — a title-token subset whose own
documented example is "Database is SQLite" against "Project database uses SQLite". Across two repos
of one product that is ordinary, not an edge case.

**There are two supersede sites, not one.** `storeKnowledgeAtomsDeduped` repeats the same logic at
`knowledge-writer.ts:301-303` for the batch path that `knowl_ingest_atoms` uses. Clamping only the
single-atom path leaves the batch path able to retire another repo's items, and the batch path is
the one agents reach for when they have several findings at once. Extract the clamp into one
helper both call, rather than patching each.

Detection may span owners: learning that another repo holds an overlapping item is exactly the
signal a workspace exists to provide. **Resolution is clamped to `coexist`** when the detected
duplicate has a different `origin_repo`, including when an explicit `supersedes` names a foreign
item. The `nearDuplicate` report (`knowledge-writer.ts:246`) names the owning repo and says the
retirement must happen there.

**`assertOwnedItem` checks the wrong number of ids.** `knowl_update` validates `id` but not
`supersedeId` (`src/mcp/tools.ts:970-972`), so an agent can retire a foreign item by naming it as
the supersede target of an item it does own. That is a v1 hole today, narrow because each repo has
its own database; in a shared one it is the whole ownership rule bypassed by a second parameter.
Every id an operation mutates must be checked, not the first one.

Implicit reads also need the scoping v1 got for free. Decision `dc955d9f869b4d2b` records why:
peers are deliberately absent from `configuredNamespaces`, so `getRecentContext`, `composeContext`'s
pinned-constraint read, `startWorkLoop`'s bootstrap and `synthesizeKnowledge` are scoped by the
database boundary itself. One shared database removes that boundary, and each needs an explicit
repo scope resolving to `origin_repo = <current>` only — **not** `visibility = 'workspace'`.
Workspace knowledge arrives through an explicit query where the agent asked for it.

**Those four are not the full list.** The same reasoning applies to every read that assumes the
database holds only this repo's items: `knowl_state` (`src/mcp/tools.ts:636`), the MCP resource
handlers including the per-category resources (`src/mcp/resources.ts:54`), and the commit-log reads
behind change notification. Enumerating them by inspection is how the first four were found and how
the rest were missed.

**Scope must be a required parameter, not a filter callers remember to apply.** Make the repo scope
a mandatory argument on the shared query entry points so a new call site fails to compile rather
than reading every repo's knowledge. A list of call sites in a plan is not enforcement.

**Test obligations:** a write in repo A does not supersede an item owned by B, **asserted through
both `storeKnowledgeItemDeduped` and `storeKnowledgeAtomsDeduped`**; the `nearDuplicate` report
names B; an explicit `supersedes` targeting a foreign item is refused with a message naming the
owner; same-owner supersession is unchanged; GC only collects items the running repo originated;
drift in A cannot stale B's items; each of the four implicit reads returns only current-repo items,
asserted separately rather than as a group.

- [ ] **Steps 1–6.**

---

### Task 11: Block what cannot be made safe

**Files:** Modify `src/store/gc.ts`, `src/store/snapshots.ts`, `src/store/portability.ts`, `src/store/change-watermark.ts`; Test `tests/store/workspace-blocked-operations.test.ts`

| Operation | Change |
| --- | --- |
| GC purge | **Disabled in a workspace.** The commit records only the base item (`gc.ts:219-226`) while cascades take assertions, evidence links, telemetry, skill steps and embeddings — `gc undo` cannot exist. Archive and compress remain and are reversible from the commit log |
| `restoreSnapshot` | **Refused in `shared` mode.** `DELETE FROM knowledge_items` then `INSERT ... SELECT *` (`snapshots.ts:74-89`) would roll back every repo and pass the integrity audit while doing it. `INSERT ... SELECT *` is also column-order dependent, so a snapshot taken before the ownership columns existed fails on arity |
| `createSnapshot` | Refused unless `--all-repos`: it copies the whole active database, so it would write every repo's knowledge into one repo's `.knowl/snapshots/` |
| `exportKnowledge` | Defaults to `origin_repo = <current>`; `--all-repos` is explicit |
| Change notification | Only changes whose `origin_repo` is the current repo. Hardcoded, not configurable. **This is a regression guard, not a feature:** 2.6.0 already delivers cross-repo notification through per-peer watermarks, and in one shared database the local commit log would otherwise announce every repo's writes as if they were yours |

**Why purge is disabled rather than scoped.** An earlier revision promised `knowl gc undo`. It
cannot exist: restoring the row restores none of its dependents, and the tombstone written
alongside would need a cancellation record with no representation in the format. Purge exists to
reclaim space from dead knowledge in a single-owner database; in a workspace the blast radius
crosses an ownership boundary and the recovery story is fiction. A workspace that genuinely needs
purging can unlink a repo and purge it locally, where the consequences are visible to whoever owns
them.

**The watermark's cross-database reference.** After Task 1, `host_session_bindings.seen_commit_rowid`
(`host-session-bindings.ts:119-151`) lives in the *local* database while `knowledge_commits` lives
in the *knowledge* database. It is a bare integer with no foreign key, which happens to be what
makes this work — but it means a shared database's commit rowids are recorded in each repo's local
file, and a repo that leaves and rejoins must reset the watermark rather than trust a rowid from a
different log. Assert this explicitly; it is the kind of thing that works until someone runs
`unlink`.

- [ ] **Steps 1–6.**

---

### Task 12: FTS rebuild with ownership columns

**Files:** Modify `src/store/bootstrap.ts`, `src/store/search.ts`, `src/store/vector.ts`; Test `tests/store/fts-ownership-migration.test.ts`

**Context the implementer needs:** `knowledge_items_fts` and its three triggers are
`CREATE ... IF NOT EXISTS`, so adding `origin_repo` and `visibility` as `UNINDEXED` columns to the
declaration is a **silent no-op on every existing database**. It requires a versioned drop,
recreate and backfill from `knowledge_items`, gated on `user_version` so it runs exactly once, with
all three triggers recreated to populate the new columns.

**Filter before capping, and the schema change alone does not achieve that.** An earlier revision
listed only `bootstrap.ts`, which adds the columns but changes no query. `searchKnowledge` applies
`LIMIT` inside the FTS SQL and filters by status afterwards in JavaScript
(`src/store/search.ts:63-72`), so an owner filter added the same way would be applied *after* the
cap: a chatty repo fills the candidate window and the querying repo gets zero of its own results.
The owner predicate has to move into the SQL, above the `LIMIT`, in **both** the FTS path and the
vector path — vector search does its own filtering on provider and model and has the same shape.

**Test obligations:** an existing database gains the columns after upgrade; the triggers populate
them on insert and update; a second bootstrap does not rebuild again; filtering by repo happens
inside the search rather than after; a repo filter with a small limit still returns local results;
the rebuild preserves row count.

- [ ] **Steps 1–6.**

---

### Task 13: Concurrency

**Files:** Modify `src/store/portability.ts`, `src/store/snapshots.ts`, `src/store/host-session-bindings.ts`, `src/store/repository.ts`, `src/workspace/paths.ts`; Test `tests/store/shared-concurrency.test.ts`

**Context the implementer needs:** each host session spawns its own `serve` process and every hook
invocation is a separate short-lived process, so a shared database is N processes on one file. WAL
prevents corruption; it does **not** prevent lost updates, and the code does read-modify-write
without version checks — `readHostSeenCommit` → compute → `setHostSeenCommit`
(`host-session-bindings.ts:138-151`), and `importKnowledge` classifies at `portability.ts:116`
*before* its deferred `BEGIN;` at `:163`.

Required:
- `BEGIN IMMEDIATE` for every read-modify-write.
- Optimistic concurrency on `knowledge_items` (`UPDATE ... WHERE version = ?`, retry on zero rows
  affected).
- Bounded retry with jittered backoff and a hard deadline rather than a tuned `busy_timeout` — the
  failure case is a slow volume, where no static value is right. Note `busy_timeout` does not retry
  `SQLITE_BUSY_SNAPSHOT` at all, so raising it accomplishes nothing for the deferred-transaction
  case.

**Acceptance is a number:** 8 concurrent writers, zero escaped `SQLITE_BUSY`, zero lost updates,
p95 write under 50 ms on local disk. **The test must detect lost updates by content** — a test
asserting only "no corruption, no unhandled error" passes on today's code while losing writes.

Network and synced folders are **refused, not warned about**, by a runtime probe of the volume's
locking behaviour. Not a list of folder-name patterns: that misses mapped drives, junctions and
self-hosted servers, and a shared workspace on a synced folder is the obvious thing a user reaching
for this feature will try. WAL needs working advisory locks and `-shm` coordination; Dropbox,
OneDrive and iCloud sync `.db`, `-wal` and `-shm` independently and produce a mutually inconsistent
triple.

**This task gates release.** If its numeric bar is not met, `shared` mode does not ship, however
complete the rest is.

- [ ] **Steps 1–6.**

---

### Task 14: `unlink`, federation dormancy, and the no-workspace guarantee

**Files:** Modify `src/workspace/migrate.ts`, `src/workspace/resolve.ts`, `src/workspace/federated-query.ts`; Test `tests/workspace/unlink.test.ts`, `tests/workspace/shared-mode-federation.test.ts`, `tests/workspace/v2-no-workspace-regression.test.ts`

**`unlink`** un-retires the local knowledge tables and flips mode back, journalled like migrate.
Copy-back is **not a bespoke flag**: it is `knowl export --repo <name>` from the workspace followed
by `knowl import` into the local database — shipped machinery with a divergence policy. An earlier
`--copy-back` had undefined behaviour for an item claimed by two repos; `origin_repo` removes the
ambiguity, because exactly one repo owns each item.

**Three things that machinery does not yet have, and no earlier task adds them:**

1. **`knowl export --repo <name>` does not exist.** `knowl export` takes a path and nothing else
   (`src/index.ts:635`). Neither does `knowl workspace migrate` or `knowl workspace unlink` — Tasks
   7, 8 and this one describe library functions with no command wired to them. This task owns all
   three CLI surfaces, or the migration is unreachable from outside the test suite.
2. **Tombstones have no owner.** `Tombstone` is `{ id, deletedAt, reason }`
   (`src/store/tombstones.ts:4`) and the table has no `origin_repo`. An owner-scoped export
   therefore cannot select this repo's deletions: it either carries every repo's tombstones out of
   the workspace, or none, and the second silently loses deletion history on unlink. Adding an
   owner column to `knowledge_tombstones` is a prerequisite of owner-scoped export, and it is
   additive, so it belongs earlier than this task.
3. **The portability format does not cover every knowledge-role table.** Export carries items,
   assertions, evidence, links, skill packages and tombstones. It does not carry
   `knowledge_commits` or `knowledge_access`. That is acceptable for a portable export — the README
   documents the exclusion — but unlink is not an export, it is a *round trip out of the only copy*,
   and history dropped there is gone. Either unlink copies those tables directly rather than through
   the JSONL format, or the plan states plainly that unlinking discards commit history and access
   telemetry.

**Federation goes dormant in `shared` mode.** `resolveWorkspace` maps peers to per-repo database
paths (`resolve.ts:38-49`), and `queryFederated` scans them. In `shared` mode those files still
exist — migration copies rather than moves — and they hold a *retired* copy of each repo's
knowledge. Scanning them would return stale duplicates of everything already in the shared
database. `queryFederated` must return empty for a `shared` workspace, and `resolveWorkspace` must
mark peers accordingly rather than leaving each caller to remember.

Then the end-to-end regression, unchanged in spirit from v1's Task 14 but re-run against every v2
change: a project with no workspace returns identical results, writes no ownership, and produces
byte-identical CLI output.

**Test obligations:** unlink restores local knowledge and mode; unlink is resumable; a peer scan in
`shared` mode returns nothing rather than stale copies; the retired local databases are not read;
the no-workspace regression passes unchanged.

- [ ] **Steps 1–6.**

---

## Appendix: the advisory applies-to table (cut)

Recorded so a later reader sees it was decided against, not overlooked. Its only purpose was
boosting and filtering retrieval by repo, and there is no evidence agents condition on the repo
label at all. Nothing read it for a lifecycle decision, so cutting it removes no guarantee.

```sql
CREATE TABLE IF NOT EXISTS knowledge_item_repos (
  knowledge_item_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  repo_name         TEXT NOT NULL,
  PRIMARY KEY (knowledge_item_id, repo_name)
);
```

Revisit only with behavioural evidence that agents use the `repo` label.

---

## Self-review

**Spec coverage.** Storage split → 1. Redirection → 2. Lifecycle convergence → 3. Ownership
portability → 4. Tombstone monotonicity → 5. Journal → 6. Fence and copy → 7. Atomic activation →
8. Routing → 9. Ownership enforcement → 10. Blocked operations → 11. FTS → 12. Concurrency → 13.
Unlink, dormancy and regression → 14. The applies-to table is cut.

**What changed from the previous revision.** A new Task 1 splitting the storage context, without
which Task 2 moves the code index into the shared database. Two live v1 bugs promoted to their own
tasks (4 and 5) after being verified in source. The applies-to table cut. `shared` demoted from
migration target to optional second mode. Federation dormancy added to Task 14 — the previous draft
never said what happens to the peer scan after migration, and the answer is not "nothing".

**Three tasks are worth building even if v2 is not.** Tasks 3, 4 and 5 each fix a defect that is
live in v1 today: lifecycle changes do not converge through export/import, ownership is silently
dropped on import, and tombstones can rewind. None of them depends on `shared` mode. They are
sequenced first for that reason.

**What v1 defers into this plan.** Two tasks the v1 plan originally carried moved here, because
neither can fire while each repo has its own database: scoping implicit reads, and clamping
cross-owner duplicate resolution. Both live in Task 10. v1's Task 8 pins the property they protect,
so a regression there fails in v1's suite before v2 work begins.

**Corrected: cross-repo change notification is no longer a v2 feature.** An earlier revision argued
v1 had none, that covering it under federation would mean polling every peer's commit log on each
tool event, and that Task 11's notification row would be the first time it existed. That is false.
2.6.0 shipped it in `linked` mode using per-peer commit watermarks — each repo tracks how far it
has read into each peer's `knowledge_commits`, so a linked repo's promote, update or retire reaches
consuming repos with a `[repo]` tag, without polling and without a shared log. The shared database
does not add the capability; it turns it into a filtering obligation, which is why Task 11's row is
a regression guard.

Two lessons worth keeping. A v2 justification survived three review rounds and a full design spec
while resting on a limit that turned out to be removable within v1 — the claim was never tested
against an attempt to build it in the simpler mode. And it was one of the two headline
capabilities, which is the single largest reason this plan is re-scoped rather than started.

**Deliberately excluded.** Cross-repo code symbol index. `indexCode` deletes every row absent from
the current root, so sharing it means a composite primary key, a matching composite foreign key on
`code_symbols`, a locator format change breaking four consumers plus already-persisted
`evidence.locator` rows, and a full table rebuild that `CREATE TABLE IF NOT EXISTS` cannot express.
That is a feature-sized project for an index of files on one machine. The code index stays in the
`local` role, which Task 1 makes structural rather than incidental.

**Where this plan is thin, stated accurately this time.** Tasks 6–14 carry context, interfaces and
test obligations, but use `Steps 1–6` placeholders — they are design intent, not steps. Tasks 1, 2
and the shipped 3–5 are written out. A previous revision put "complete and buildable" in the status
line while this section admitted the plan thinned out. External review called that contradiction,
and it was right: **the status line was wrong, not this section.**

**What external review found, and what it changed.** Reviewed at `4dbbfdf`. Every finding was
checked against source before being acted on; all nine held.

| Finding | Where it landed |
| --- | --- |
| Goal promises cross-owner editing that Task 10 forbids | New section, "The cross-owner editing contradiction". Blocks execution and removes one of v2's two claimed benefits |
| Fence lifts per repo while activation is global, so writes in the window are lost | Task 7 rewritten: the fence holds through cutover, plus handle invalidation for `serve` processes that predate it |
| Task 2 omitted `database.ts`, so no production write would have moved | Task 2 rewritten, with resolver tests called out explicitly as insufficient evidence |
| The storage split separates a foreign key (`host_session_bindings` → `memory_sessions`) and missed local-table readers | Task 1: FK options enumerated, `evidence-repository` added, a full table-and-caller map made step 1 |
| Routing placed above three real write paths | Task 9 moved to the repository mutation boundary, with the three bypasses named and tested separately |
| `knowl_update` checks `id` but not `supersedeId` | Task 10, as a v1 hole that becomes total in a shared database |
| Implicit-read list incomplete; FTS caps before filtering | Tasks 10 and 12; scope becomes a required parameter rather than a filter callers remember |
| `export --repo`, migrate and unlink have no CLI; tombstones have no owner | Task 14, with the history-loss consequence stated rather than implied |
| Lifecycle convergence had no end-to-end invariant | Fixed in shipped code (`7725d02`): the missing-hash fallback was discarding information the file already carried |
| Task 1 tests vacuous; completeness overclaimed | Tests rewritten to assert non-zero and to exercise the table they name; status line corrected |

**Known open question, not blocking:** what a repo should do when it opens a shared workspace whose
`minKnowlVersion` exceeds its own build. `assertSchemaSupported` covers the database, but the
manifest carries its own version field (`manifest.ts:22,45`) that nothing currently enforces.
Decide in Task 2 or accept that the database guard is the only one.
