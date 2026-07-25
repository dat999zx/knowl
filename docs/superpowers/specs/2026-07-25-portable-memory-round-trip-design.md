# Portable Memory Round-Trip Design

**Date:** 2026-07-25

**Status:** Verified against real data 2026-07-25. Default `--on-divergence` set to `newer`
(see [Open decision](#open-decision)); reversible, it is a flag default.

## Problem

`knowl export` / `knowl import` is presented as memory portability, but it only works once,
into an empty database. Two machines that have both done work can never reconcile, and a
delete on one machine can never reach the other at all.

This blocks the ordinary case the free tier is meant to serve: one developer, a laptop and
a desktop, no server.

## Findings

Verified against the current code before designing.

### Import is insert-only and aborts wholesale

`importKnowledge` (`src/store/portability.ts`) classifies each incoming item by looking up
`content_hash` for its id. An existing id with a matching hash counts as `skipped`; an
existing id with a different hash counts as `conflicts`. Then:

```
if (conflicts > 0 || options.dryRun) return { inserted: 0, skipped, conflicts, applied: false };
```

A single divergent item therefore discards the entire import, including every item that
would have applied cleanly. There is no update path — the apply loop is `INSERT`-only and
explicitly `continue`s past any id that already exists.

### Deletes cannot travel

`deleteKnowledgeItem` (`src/store/repository.ts`) issues a hard `DELETE` and leaves no
trace. It has exactly one caller, the purge path in `src/store/gc.ts`, which keeps the
surface small. Because the row simply vanishes, an export taken afterwards is
indistinguishable from one where the item never existed, so the peer keeps its copy
forever.

Everything else in GC uses `status = 'archived'` and is already portable.

### The round trip is broken in practice, not just in theory

Run 2026-07-25 against a real 372-item DuckPrep export. Imported into scratch project A
(372 inserted, applied) and project B; added one new decision on B; edited one item on A to
simulate local work; imported B's export into A:

```
inserted: 1   skipped: 371   conflicts: 1   applied: false
B's new decision present on A: NO
```

One locally-edited item blocked B's unrelated new decision from landing. Since divergence
is the *normal* state of two machines that have both done work, export/import works exactly
once into an empty database and never again.

The same output shows a second, smaller defect: `inserted: 1` is reported alongside
`applied: false`. The count describes what *would* have been inserted, so the reply reads
as partial success when nothing was written.

### Import writes raw SQL and never indexes embeddings

`portability.ts` contains no reference to `indexKnowledgeItemsBestEffort`, which every
other write path calls (`knowledge-writer.ts`, `knowledge-actions.ts`). Verified: importing
372 items produced **372 FTS rows and 0 embeddings**.

FTS survives because `bootstrap.ts` defines `knowledge_items_fts_ai` / `_au` / `_ad`
triggers, so raw `INSERT` and `UPDATE` keep it correct for free. Vector search has no such
trigger — it needs a model — so all imported knowledge is invisible to the primary
retrieval path until `knowl reindex --vectors` is run by hand. Retrieval degrades to the
BM25 fallback rather than failing outright, which is why this was never noticed.

### Timestamps are sufficient; causality tracking is not needed

`knowledge_items` carries `updated_at` (refreshed on every update) and `version` (an
integer incremented only when `title` or `content` changes — `repository.ts`).

This matters for scope. Earlier framing of this work assumed a monotonic per-item clock or
vector clock would be required. That is only true for offline multi-replica convergence
with no arbiter. For last-writer-wins between two clones of one person's project,
`updated_at` is enough, with `version` as a secondary tiebreaker. **The causality work is
dropped from this design**, which makes it materially smaller than originally scoped.

## Design

### 1. Per-record classification, never wholesale abort

Import classifies each item as `new`, `identical`, or `divergent`, then applies a policy to
the divergent set. `identical` and `new` always apply. The import no longer aborts because
divergence exists.

Policies, selected by `--on-divergence`:

| Policy | Behaviour |
| --- | --- |
| `newer` | Apply the incoming item when its `updated_at` is later; keep local otherwise. Ties broken by `version`, then by keeping local. |
| `skip` | Keep local, report the divergence. |
| `theirs` | Apply the incoming item unconditionally. |
| `fail` | Abort the whole import, current behaviour, kept for CI. |

Divergent items that lose are reported by id and title, never silently dropped — the same
principle applied to `knowl_store` in `78e8f4d`.

**A divergent winner is written verbatim, not through `updateKnowledgeItem`.** An earlier
draft of this spec said the opposite; verification showed that would never converge.
`updateKnowledgeItem` (`src/store/repository.ts`) sets `updatedAt = now` and computes
`nextVersion` by incrementing whenever `content` or `title` changes. So if A adopts B's
item through it, A's copy immediately differs from B's and is *newer*. On the next round B
adopts A's, bumps again, and the two machines ping-pong forever, each import manufacturing
a fresh winner. Sync must copy the peer's row exactly — `content`, `content_hash`,
`version`, `updated_at` — so that both sides hold byte-identical rows and the following
round classifies the item as `identical`.

This is why the acceptance test below asserts agreement on `content_hash`: it is the only
thing that proves convergence rather than oscillation.

### 2. Tombstones so deletes travel

New table, written in the same transaction as the delete:

```sql
CREATE TABLE IF NOT EXISTS knowledge_tombstones (
  id TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL,
  reason TEXT
);
```

`deleteKnowledgeItem` writes the tombstone. Export emits `{ type: 'tombstone', ... }`
records. On import, a tombstone deletes the local item only when the local item's
`updated_at` is earlier than `deleted_at` — a local edit made after the remote delete wins,
and the tombstone is reported as skipped.

Tombstones are pruned by age (default 90 days, configurable). A tombstone older than any
plausible export round is dead weight, and unbounded growth would be its own defect.

### 3. Imported knowledge is indexed for vector search

Import calls `indexKnowledgeItemsBestEffort` for every item it writes or updates, matching
every other write path. Best-effort means a project with vectors disabled or a model
unavailable still imports successfully — it just stays on the BM25 path, which is the
current behaviour for everyone.

Without this the feature is hollow: memory that arrives but cannot be found by the primary
retrieval path has not really travelled.

### 4. Reported counts describe what happened

`ImportResult` reports per-class counts that match the writes actually performed, so
`applied: false` can never sit beside a non-zero `inserted`. Dry runs report what *would*
happen under a clearly separate shape.

### 5. Round-trip test as the acceptance criterion

The feature is defined by a test that today is impossible: export from A, import into B,
diverge both, export from B, import into A, and assert both databases agree on every item's
`content_hash`, with deletes reflected on both sides. Anything that passes this and the
existing suite is correct; anything that does not, is not.

## Non-goals

Explicitly out of scope, and not partially implemented:

- Convergent merge, CRDTs, replica identity, vector clocks. Single-writer-per-round with
  last-writer-wins is the whole model.
- Real-time or automatic sync. This is a manual `export` / `import` round trip.
- Any server, transport, or hosted tier. The file is the transport.
- Field-level merge. The unit is the item; a divergent item is taken whole.
- Reconciling `session`, `knowledge_access`, or embedding data. Only durable knowledge,
  assertions, evidence, skill packages, and tombstones travel.

## Open decision

**What should `--on-divergence` default to?**

Recommendation: **`newer`**. The dominant case is one person's two machines, where trust is
total and divergence means "I edited this in both places." Silently keeping the older copy
is the surprising outcome, and every loser is reported either way.

The argument for defaulting to `skip` is that no import should ever overwrite local work
without being asked. That is the safer default for a team, but a team is served by the
server tier rather than by file round-trips, so optimizing this default for teams costs the
actual user for a hypothetical one.

`fail` should not be the default — it is the current behaviour, and it is the reason the
feature does not work.
