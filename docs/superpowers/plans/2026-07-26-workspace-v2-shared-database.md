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
| Does `linked` mode earn its keep? | If category routing works, `shared` may be the only mode worth maintaining | Task 1 collapses to one mode; the `workspace` connection role disappears |
| Do agents condition on the `repo` label? | Any ranking weight is justified by it | If not, keep v1's ties-to-local and add no weighting at all |
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
- A repo with no workspace behaves exactly as today. Task 13 asserts it.

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

**Files:**
- Modify: `src/store/storage-roles.ts`, `src/store/schema-version.ts`, `src/workspace/manifest.ts`
- Test: `tests/store/shared-mode-storage.test.ts`

**Interfaces:**
- `WorkspaceManifest` gains `mode: 'linked' | 'shared'` (default `'linked'`)
- `resolveStorage(root, config, workspace?)` gains an optional third argument; when the
  workspace's mode is `shared`, `knowledge` resolves to `<workspace-dir>/knowl.db`
- `KNOWL_SCHEMA_VERSION` becomes `2`

**Context the implementer needs:** **mode lives only in the manifest.** Not in any repo's
config. That is what makes activation a single atomic file write in Task 7. The design's earlier
shape flipped mode across the manifest *and* every repo's config, which is a multi-writer
cutover with no atomicity: a crash midway leaves some repos `shared` and others not, with no
recovery procedure and no way to tell which state you are in.

`local` and `session` never move. The code index lives in `local` and `indexCode` deletes every
row absent from the current root — sharing it means one repo's index run wiping every other's.

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
    const storage = resolveStorage(ROOT, DEFAULT_CONFIG, active('shared'));
    expect(storage.knowledge).toBe(path.join(workspaceDir('ws'), 'knowl.db'));
    delete process.env.KNOWL_HOME;
  });

  it('leaves local and session anchored to the repo in both modes', () => {
    process.env.KNOWL_HOME = path.resolve('./.knowl-shared-home');
    for (const mode of ['linked', 'shared'] as const) {
      const storage = resolveStorage(ROOT, DEFAULT_CONFIG, active(mode));
      // The code index lives here, and indexCode deletes every row absent from the current
      // root -- sharing it would let one repo's index run wipe every other repo's.
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

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run tests/store/shared-mode-storage.test.ts`
Expected: FAIL — `resolveStorage` takes two arguments and ignores mode

- [ ] **Step 3: Write minimal implementation**

In `src/workspace/manifest.ts` add `mode: 'linked' | 'shared'` to `WorkspaceManifest`, default
`'linked'` in `createManifest` and when reading a manifest that predates the field.

In `src/store/storage-roles.ts`:

```typescript
export function resolveStorage(
  root: string,
  _config?: ProjectConfig,
  workspace?: { manifest: { name: string; mode?: 'linked' | 'shared' } } | null,
): ResolvedStorage {
  const knowlDir = path.join(root, '.knowl');
  const local = path.join(knowlDir, 'knowl.db');
  // Only `knowledge` can ever be redirected. `local` holds the code index, host bindings and
  // watermarks; `indexCode` deletes every row absent from the current root, so a shared code
  // index would let one repo's index run wipe every other repo's.
  const knowledge = workspace?.manifest.mode === 'shared'
    ? path.join(workspaceDir(workspace.manifest.name), 'knowl.db')
    : local;
  return { local, session: path.join(knowlDir, 'session.db'), knowledge };
}
```

Bump `KNOWL_SCHEMA_VERSION` to `2` in `src/store/schema-version.ts`, with a comment naming this
change as the reason.

- [ ] **Step 4: Run test to verify it passes** — PASS, 5 tests
- [ ] **Step 5: Verify suite and typecheck** — 15 errors
- [ ] **Step 6: Commit**

```bash
git add src/store/storage-roles.ts src/store/schema-version.ts src/workspace/manifest.ts tests/store/shared-mode-storage.test.ts
git commit -m "feat(workspace): shared mode redirects the knowledge role only

Mode lives in the manifest and nowhere else. That is what lets activation be a
single atomic file write: flipping it across the manifest and every repo's
config is a multi-writer cutover with no atomicity, and a crash midway leaves
some repos shared and others not, with no way to tell which state you are in.

local and session never move. The code index lives in local, and indexCode
deletes every row absent from the current root -- a shared code index would let
one repo's index run wipe every other repo's.

Schema version bumps to 2, so a 2.4.x client refuses a shared database rather
than writing rows its rules do not hold for."
```

---

### Task 2: Lifecycle convergence

**Files:**
- Modify: `src/store/freshness.ts`, `src/store/import-policy.ts`, `src/store/portability.ts`, `src/store/schema.ts`, `src/store/bootstrap.ts`
- Test: `tests/store/lifecycle-hash.test.ts`

**Interfaces:**
- `hashKnowledgeLifecycle(input: { status; freshness; supersededById; originRepo; visibility }): string`
- `knowledge_items.lifecycle_hash TEXT` (additive column)
- `classifyIncomingItem` returns `'new' | 'identical' | 'divergent' | 'metadata-divergent'`

**Context the implementer needs:** `content_hash` covers title, content, reasoning, source and
paths (`freshness.ts:20-38`). Equal hashes classify as `identical` (`import-policy.ts:15-21`) and
the plan skips the item outright (`portability.ts:130`). So promoting an item to workspace
visibility, retiring it, superseding it or marking it stale changes nothing an export can carry
— the receiving side keeps its old copy and the two never converge. That breaks `promote`
across machines, `unlink --copy-back`, and any workspace export.

**Do not widen `content_hash`.** It would change every existing item's identity and break the
verbatim adoption that makes re-import idempotent (`portability.ts:174-184`) — the same trap
that killed path qualification. `confidence` is excluded from the lifecycle hash deliberately:
it moves on ordinary use and would make almost every item permanently divergent.

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

  it('changes when status or supersession changes', () => {
    expect(hashKnowledgeLifecycle({ ...base, status: 'superseded' })).not.toBe(hashKnowledgeLifecycle(base));
    expect(hashKnowledgeLifecycle({ ...base, supersededById: 'abc' })).not.toBe(hashKnowledgeLifecycle(base));
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
    // This is the case that silently did not converge: a promoted item exported and
    // imported elsewhere kept its old visibility.
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

In `src/store/import-policy.ts`, add `lifecycleHash?: string | null` to both row types and:

```typescript
export function classifyIncomingItem(
  incoming: ImportCandidate,
  local: LocalItemRow | undefined,
): 'new' | 'identical' | 'divergent' | 'metadata-divergent' {
  if (!local) return 'new';
  if (String(incoming.contentHash ?? '') !== String(local.contentHash ?? '')) return 'divergent';
  // A v1 export carries no lifecycle hash. Treat its absence as agreement rather than as a
  // difference, or every legacy file would import as metadata-divergent.
  if (incoming.lifecycleHash == null) return 'identical';
  return String(incoming.lifecycleHash) === String(local.lifecycleHash ?? '') ? 'identical' : 'metadata-divergent';
}
```

In `src/store/portability.ts`, add a `metadata` plan action resolved by the existing `newer`
policy and applied as a metadata-only update that **writes `content_hash` verbatim**:

```typescript
      } else if (entry.action === 'metadata') {
        // Lifecycle only. content_hash is written unchanged so the next round classifies
        // this as identical and the two sides stop trading updates.
        await client.execute({
          sql: `UPDATE knowledge_items SET status = ?, freshness = ?, superseded_by_id = ?,
                origin_repo = ?, visibility = ?, lifecycle_hash = ?, updated_at = ?, version = ?
                WHERE id = ?`,
          args: [entry.item.status, entry.item.freshness, entry.item.supersededById ?? null,
                 entry.item.originRepo ?? null, entry.item.visibility ?? 'repo',
                 entry.item.lifecycleHash, entry.item.updatedAt, entry.item.version, entry.item.id],
        });
      }
```

Add `lifecycle_hash` as an additive column in `bootstrap.ts` alongside `ensureOwnershipColumns`,
backfilled from the existing rows, and to the Drizzle schema.

- [ ] **Step 4: Run test to verify it passes** — PASS, 9 tests
- [ ] **Step 5: Verify suite and typecheck** — 15 errors
- [ ] **Step 6: Commit**

```bash
git commit -m "feat: converge lifecycle changes through export and import

content_hash covers title, content, reasoning, source and paths. Equal hashes
classify as identical and the import plan skips the item outright, so promoting
an item, retiring it, superseding it or marking it stale changed nothing an
export could carry -- promote across machines, unlink --copy-back and workspace
export all silently failed to converge.

A separate lifecycle_hash and a fourth verdict, metadata-divergent, resolved by
the existing newer policy. content_hash is written verbatim on a metadata
update, so the next round is identical and the two sides stop trading updates.

Widening content_hash was the alternative and would have changed every existing
item's identity -- the same trap that killed path qualification. confidence is
excluded because it moves on ordinary use."
```

---

### Task 3: Deletes only move forward

**Files:**
- Modify: `src/store/tombstones.ts`, `src/store/portability.ts`
- Test: `tests/store/tombstone-monotonicity.test.ts`

**Context the implementer needs:** two separate defects, both verified.

Import plans an insert without consulting local tombstones (`portability.ts:130-131`), so a
stale export resurrects an item that was deleted after that export was taken. And the tombstone
upsert overwrites `deleted_at` unconditionally — in **both** `portability.ts:193-207` and
`recordTombstone` in `tombstones.ts:19-23` — so an older tombstone rewinds a newer one. Fix both
sites; fixing only the import path leaves the same bug reachable through ordinary GC.

The export header bumps to version 2, since `origin_repo`, `visibility` and `lifecycle_hash` are
now portable fields. A version-1 reader must **refuse** a version-2 file rather than silently
dropping ownership.

Tests: a stale export cannot resurrect a newer delete; an old tombstone does not rewind a newer
one, through `recordTombstone` as well as through import; a v1 reader refuses a v2 file; a v2
reader accepts a v1 file with the missing fields defaulted.

- [ ] **Steps 1–6** following the established pattern.

---

### Task 4: The advisory applies-to table

**Build only if v1 says it is worth it.** See "What v1 must answer first". It exists solely to
boost and filter retrieval; nothing reads it for a lifecycle decision, and an empty table breaks
nothing.

**Files:** `src/store/bootstrap.ts`, `src/store/schema.ts`; Test `tests/store/applies-to.test.ts`

```sql
CREATE TABLE IF NOT EXISTS knowledge_item_repos (
  knowledge_item_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  repo_name         TEXT NOT NULL,
  PRIMARY KEY (knowledge_item_id, repo_name)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_item_repos_name ON knowledge_item_repos(repo_name);
```

Tests: membership boosts ranking; it never adds or removes a result under any filter;
`repos: ["x"]` still matches on `origin_repo` alone; an empty table changes nothing.

- [ ] **Steps 1–6.**

---

### Task 5: The migration journal

**Files:** Create `src/workspace/journal.ts`; Test `tests/workspace/journal.test.ts`

**Interfaces:**
- `type RepoState = 'pending' | 'fenced' | 'exported' | 'imported' | 'done'`
- `type Journal = { version: 1; workspace: string; startedAt: string; repos: Record<string, RepoState> }`
- `readJournal(dir)`, `writeJournal(dir, journal)`, `advance(dir, repo, state)`, `clearJournal(dir)`

**Context the implementer needs:** `<workspace-dir>/migration.json` is the source of truth for
what has happened, **not the filesystem**. A crash resumes at the recorded state rather than
restarting, and a repo already marked `done` is never re-migrated. A corrupt journal fails
loudly: silently restarting a partially-applied migration is how you get a half-copied
workspace nobody can reason about.

Tests: a killed process resumes at the recorded state; a `done` repo is skipped; a corrupt
journal throws rather than starting over; `clearJournal` only succeeds when every repo is `done`.

- [ ] **Steps 1–6.**

---

### Task 6: Fence, snapshot, copy

**Files:** Create `src/workspace/fence.ts`, `src/workspace/migrate.ts`; Test `tests/workspace/migrate.test.ts`

**Context the implementer needs:** per repo — set a `migrating` marker in `knowl_meta` making
every knowledge write fail with a clear message; export at the fence; import into the workspace
setting `origin_repo` and routing `visibility` by category; re-embed anything not matching the
pinned identity; mark local knowledge retired and bump its `user_version`; lift the fence.

**The fence is not optional.** Without it, a write landing between export and activation is
simply lost: it goes into a database that stops being read the moment mode flips, and nothing
reports it. The fence is per repo and short-lived, so the other repos stay usable throughout.

**Copy, never move.** The canonical path is never renamed. An old client opening
`<repo>/.knowl/knowl.db` and finding nothing would create a *fresh* database and never meet the
version guard — which is the whole reason 2.4.0 shipped the guard first.

**Merging does not collapse duplicates.** Import matches on **id** (`portability.ts:116-118`),
and ids are random per repo, so two repos that independently recorded the same fact produce two
surviving rows. That is correct — each repo did record it, and each copy keeps its own owner and
history — but the dry-run must report the count so the number is not a surprise.

Tests: a write during the fence fails with the migration message; killing the process after
export leaves mode unflipped and the repo usable; migrate is idempotent; the local file still
exists at its canonical path with a bumped `user_version`; the dry-run reports the duplicate
count.

- [ ] **Steps 1–6.**

---

### Task 7: Atomic activation

**Files:** Modify `src/workspace/migrate.ts`; Test `tests/workspace/activation.test.ts`

Flip `mode` in `workspace.json` once, after every repo reports `done`. One file write, so no
mixed-mode state can exist.

Tests: mode does not flip while any repo is not `done`; after activation every repo resolves
`knowledge` to the workspace database; before activation every repo still resolves to its own;
a crash between the last `done` and the flip leaves a resumable state.

- [ ] **Steps 1–6.**

---

### Task 8: Write routing below every surface

**Files:** Modify `src/store/knowledge-writer.ts`, `src/mcp/tools.ts`; Test `tests/store/write-routing.test.ts`

**Interfaces:** `routeWrite(atom, context): { visibility: 'repo' | 'workspace'; originRepo: string | null }`

**Context the implementer needs:** `routeWrite` lives in `knowledge-writer`, **beneath** the MCP
tools, because synthesis (`synthesis.ts`), candidate promotion (`candidate-promotion.ts`) and
the extraction pipeline (`pipeline/merge.ts`) all create items without passing through a tool
handler. Routing implemented at the MCP layer would be bypassed by every one of them, and their
items would land with a default nobody chose.

Default is category-driven: `decision`, `constraint`, `architecture`, `goal` → `workspace`;
`fact`, `state`, `skill` → repo. `skill` never crosses — a skill atom points at files under the
writing repo's `.knowl/skills/`, and `recordSkillRun` matches on exact `source` equality, so a
shared skill atom would list a skill whose `SKILL.md` does not exist locally.

Batch writes partition by destination, each partition in its own transaction, with a per-atom
destination reported. A failing partition does not roll back the others — that is the
partial-failure semantic, stated rather than avoided. Rejecting mixed batches was the
alternative and is worse: it pushes agents into per-atom calls, which is what
`knowl_ingest_atoms` exists to prevent.

Tests: a synthesis-created item is routed, not defaulted; an explicit `namespace` overrides the
category default in both directions; `skill` never routes to workspace even when explicitly
asked; a mixed batch reports per-atom destinations; one failing partition leaves the others
committed.

- [ ] **Steps 1–6.**

---

### Task 9: Ownership enforcement in one database

**Files:** Modify `src/store/knowledge-writer.ts`, `src/store/gc.ts`, `src/store/drift.ts`; Test `tests/store/shared-ownership.test.ts`

**Context the implementer needs:** in a shared database every repo's items sit in one table, so
the ownership rules that were structural in v1 become explicit checks. This is where v1's two
deferred tasks land.

`storeKnowledgeItemDeduped` finds a likely duplicate across the whole database and, on a
`supersede` resolution, retires it (`knowledge-writer.ts:202-236`). `46596c7` widened that from
an exact title match to `sameSubjectTitle` — a title-token subset whose own documented example
is "Database is SQLite" against "Project database uses SQLite". Across two repos of one product
that is ordinary, not an edge case.

Detection may span owners: learning that another repo holds an overlapping item is exactly the
signal a workspace exists to provide. **Resolution is clamped to `coexist`** when the detected
duplicate has a different `origin_repo`, including when an explicit `supersedes` names a foreign
item. The `nearDuplicate` report names the owning repo and says the retirement must happen
there.

Implicit reads also need the scoping v1 got for free: `getRecentContext`, `composeContext`'s
pinned-constraint read, `startWorkLoop` and `synthesizeKnowledge` all take a required repo scope
and resolve to `origin_repo = <current>` only — *not* `visibility = 'workspace'`. Workspace
knowledge arrives through an explicit query where the agent asked for it.

Tests: a write in repo A does not supersede an item owned by B; the `nearDuplicate` report names
B; an explicit `supersedes` targeting a foreign item is refused; same-owner supersession is
unchanged; GC only collects items the running repo originated; drift in A cannot stale B's
items; each of the four implicit reads returns only current-repo items, asserted separately.

- [ ] **Steps 1–6.**

---

### Task 10: Block what cannot be made safe

**Files:** Modify `src/store/gc.ts`, `src/store/snapshots.ts`, `src/store/portability.ts`, `src/store/change-watermark.ts`; Test `tests/store/workspace-blocked-operations.test.ts`

| Operation | Change |
| --- | --- |
| GC purge | **Disabled in a workspace.** The commit records only the base item (`gc.ts:219`) while cascades take assertions, evidence links, telemetry, skill steps and embeddings (`schema.ts:34,60,70,78,92,125`) — `gc undo` cannot exist. Archive and compress remain and are reversible from the commit log |
| `restoreSnapshot` | Refused in `shared` mode: `DELETE FROM knowledge_items` then reinsert (`snapshots.ts:74-89`) would roll back every repo and pass the integrity audit while doing it |
| `createSnapshot` | Refused unless `--all-repos`: it copies the whole active database, so it would write every repo's knowledge into one repo's `.knowl/snapshots/` |
| `exportKnowledge` | Defaults to `origin_repo = <current>`; `--all-repos` is explicit |
| Change notification | Only changes whose `origin_repo` is the current repo. Hardcoded, not configurable — a knob for a behavior nobody has experienced yet |

**Why purge is disabled rather than scoped.** An earlier revision promised `knowl gc undo`. It
cannot exist: restoring the row restores none of its dependents, and the tombstone written
alongside would need a cancellation record with no representation in the format. Purge exists to
reclaim space from dead knowledge in a single-owner database; in a workspace the blast radius
crosses an ownership boundary and the recovery story is fiction. A workspace that genuinely
needs purging can unlink a repo and purge it locally, where the consequences are visible to
whoever owns them.

- [ ] **Steps 1–6.**

---

### Task 11: FTS rebuild with ownership columns

**Files:** Modify `src/store/bootstrap.ts`; Test `tests/store/fts-ownership-migration.test.ts`

**Context the implementer needs:** `knowledge_items_fts` and its three triggers are
`CREATE ... IF NOT EXISTS` (`bootstrap.ts:33-41`, `165-184`), so adding `origin_repo` and
`visibility` as `UNINDEXED` columns to the declaration is a **silent no-op on every existing
database**. It requires a versioned drop, recreate and backfill from `knowledge_items`, gated on
`user_version` so it runs exactly once, with all three triggers recreated to populate the new
columns.

**Filter before capping.** Cap-then-filter can return zero local results when a chatty repo
fills the candidate window.

Tests: an existing database gains the columns after upgrade; the triggers populate them on
insert and update; a second bootstrap does not rebuild again; filtering by repo happens inside
the search rather than after; a repo filter with a small limit still returns local results.

- [ ] **Steps 1–6.**

---

### Task 12: Concurrency

**Files:** Modify `src/store/portability.ts`, `src/store/snapshots.ts`, `src/store/host-session-bindings.ts`, `src/store/repository.ts`, `src/workspace/paths.ts`; Test `tests/store/shared-concurrency.test.ts`

**Context the implementer needs:** each host session spawns its own `serve` process
(`server.ts:83-89`) and every hook invocation is a separate short-lived process, so a shared
database is N processes on one file. WAL prevents corruption; it does **not** prevent lost
updates, and the code does read-modify-write without version checks —
`readHostSeenCommit` → compute → `setHostSeenCommit` (`host-session-bindings.ts:115-132`), and
`importKnowledge` classifies *before* its deferred `BEGIN` (`portability.ts:116-184`).

Required: `BEGIN IMMEDIATE` for every read-modify-write; optimistic concurrency on
`knowledge_items` (`UPDATE ... WHERE version = ?`, retry on zero rows affected); bounded retry
with jittered backoff and a hard deadline rather than a tuned `busy_timeout` — the failure case
is a slow volume, where no static value is right. Note that `busy_timeout` does not retry
`SQLITE_BUSY_SNAPSHOT` at all, so raising it accomplishes nothing for the deferred-transaction
case.

**Acceptance is a number:** 8 concurrent writers, zero escaped `SQLITE_BUSY`, zero lost updates,
p95 write under 50 ms on local disk. The test must detect lost updates **by content** — a test
asserting only "no corruption, no unhandled error" passes on today's code while losing writes.

Network and synced folders are **refused, not warned about**, by a runtime probe of the volume's
locking behavior. Not a list of folder-name patterns: that misses mapped drives, junctions and
self-hosted servers, and a shared workspace on a synced folder is the obvious thing a user
reaching for this feature will try. WAL needs working advisory locks and `-shm` coordination;
Dropbox, OneDrive and iCloud sync `.db`, `-wal` and `-shm` independently and produce a mutually
inconsistent triple.

- [ ] **Steps 1–6.**

---

### Task 13: `unlink`, and the no-workspace guarantee

**Files:** Modify `src/workspace/migrate.ts`; Test `tests/workspace/unlink.test.ts`, `tests/workspace/v2-no-workspace-regression.test.ts`

`unlink` un-retires the local knowledge tables and flips mode back, journalled like migrate.
Copy-back is **not a bespoke flag**: it is `knowl export --repo <name>` from the workspace
followed by `knowl import` into the local database — shipped machinery with a divergence policy.
An earlier `--copy-back` had undefined behavior for an item claimed by two repos; `origin_repo`
removes the ambiguity, because exactly one repo owns each item.

Then the end-to-end regression, unchanged in spirit from v1's Task 14 but re-run against every
v2 change: a project with no workspace returns identical results, writes no ownership, and
produces byte-identical CLI output.

- [ ] **Steps 1–6.**

---

## Self-review

**Spec coverage.** Storage redirection → 1. Lifecycle convergence → 2. Tombstone monotonicity and
format v2 → 3. Applies-to → 4. Journal → 5. Fence and copy → 6. Atomic activation → 7. Routing →
8. Ownership → 9. Blocked operations → 10. FTS → 11. Concurrency → 12. Unlink and regression → 13.

**What v1 defers into this plan.** Two tasks the v1 plan originally carried moved here, because
neither can fire while each repo has its own database: scoping implicit reads, and clamping
cross-owner duplicate resolution. Both live in Task 9. v1's Task 8 pins the property they
protect, so a regression there fails in v1's suite before v2 work begins.

A third thing lands here by default rather than by choice. **v1 has no cross-repo change
notification at all**: the watermark reads the local `knowledge_commits`
(`change-watermark.ts:12,58`) and federation reaches peers through a read-only path that
records nothing, so an agent is never told when a linked repo promotes knowledge. Covering that
under federation would mean polling every peer's commit log on each tool event; the shared
database makes it one log and removes the problem rather than solving it. Task 10's
notification row is therefore the *first* time cross-repo notification exists, not a
restriction of something v1 shipped.

**Deliberately excluded.** Cross-repo code symbol index. `indexCode` deletes every row absent
from the current root, so sharing it means a composite primary key, a matching composite foreign
key on `code_symbols`, a locator format change breaking four consumers plus already-persisted
`evidence.locator` rows, and a full table rebuild that `CREATE TABLE IF NOT EXISTS` cannot
express. That is a feature-sized project for an index of files on one machine. The code index
stays in the `local` role.

**Detail level.** Tasks 1 and 2 are written out in full because they are load-bearing and
independent of the open questions. Tasks 3–13 carry context, interfaces, the reasoning behind
each decision, and explicit test obligations, but not literal code — deliberately, because five
of this plan's decisions are open pending v1 usage and writing code against a guess would be
throwaway work. Expand each task to full steps when its scope is settled. A plan claiming
completeness it does not have is worse than one that says where it thins out.
