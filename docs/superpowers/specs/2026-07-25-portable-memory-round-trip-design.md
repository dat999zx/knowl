# Portable Memory Round-Trip Design

**Date:** 2026-07-25

**Status:** Draft — one open decision for the owner (see [Open decision](#open-decision)).

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

Applying a divergent winner is an update, not an insert, so it must go through
`updateKnowledgeItem` to refresh `content_hash` and bump `version` rather than raw SQL.

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

### 3. Round-trip test as the acceptance criterion

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
