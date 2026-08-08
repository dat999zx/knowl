# Workspace query scoping — design

2026-08-08

Counterpart to [demand-paged knowledge scoping](2026-08-07-demand-paged-scoping-design.md), which
asks how to make *more* cross-repo knowledge reachable. This one asks what a reachable peer answer
should look like when it arrives. Both are needed; neither substitutes for the other.

## The problem

A query from a repo that has never touched a subject returns another repo's answer, and nothing in
the response says so loudly enough to stop the agent using it as this repo's own.

Three mechanisms combine to produce it.

**One ranking, no home-field advantage.** `queryFederated` puts local and peer candidates into a
single `scoreCandidates` call (`src/workspace/federated-query.ts:141`). Each repo contributes up to
`perRepoCap` (10); the top `limit` (default 3) wins outright. When the local repo holds nothing on
the subject, all three slots go to peers. "Local had zero hits" and "local had weaker hits" produce
responses that look identical.

**The one signal that would say so is off by default.** `WORKSPACE REACH: searched knowl: 0,
knowl-cloud: 3` (`src/mcp/tools.ts:850`) is gated on `explain`, which callers rarely pass.

**The relevance floor cannot catch it.** `minRelevance` (`src/workspace/federated-query.ts:152`)
judges the union. A peer item that genuinely matches the query words scores high, the floor is
satisfied, and `NO CONFIDENT MATCH` never fires — although for *this repo* the store really is
empty. The floor answers "does the workspace hold this?" when the question was "does this repo
hold this?"

The `repo` field is on every row, and `KNOWL.md` says a foreign fact describes that repo. That is a
quiet field in a JSON array, set against a standing instruction to use a relevant hit immediately
without reading files. The field loses.

### Why the floor cannot be given this job

The obvious design gates the local/peer branch on whether local cleared the relevance floor. Three
measurements say it would not work, and one of them is why the floor exists at all.

1. **Scale-free rules were measured and rejected** (knowl atom `d61980c3302c43d1`,
   [per-model relevance floor](2026-08-04-per-model-relevance-floor-design.md)). Margin over the
   rest, ratio, and z-score all separate *worse* than an absolute cosine: on granite the
   on-topic/off-topic overlap is 0.0305–0.0899 by margin against 0.7637–0.7644 by absolute cosine.
   "A query that finds nothing still produces a peaked distribution — the best of fifty unrelated
   notes stands out from the other forty-nine much as a real answer does." Flagged
   do-not-re-propose. This rules out "local's best versus the peer's best" and every relative
   variant of it.
2. **The floor fires far less often than assumed** ([demand-paged scoping](2026-08-07-demand-paged-scoping-design.md),
   Finding 1). On the real 483-item store, off-topic queries top out around 0.29 against a 0.16
   floor. It is corpus-dependent, which is why that design reports it rather than enforcing it.
   A branch gated on it would take the local path almost always.
3. **Near-miss queries are undetectable by any threshold.** Plausible, in-domain, unanswerable
   queries score *above* genuinely answerable ones — highest near-miss 0.8731 against lowest
   on-topic 0.8393, negative separation at every corpus size. Recorded as an information limit,
   not a tuning one.

Point 3 is the decisive one, and it is exactly this problem: "something this repo has not done
yet" *is* a near-miss query — asked in this repo's vocabulary, plausibly about it, unanswered by
it. A floor-gated branch would be blind in precisely the case it was built for.

> **Provenance caveat.** Point 3 is knowl-cloud's finding (`0f3dc22f61a043dd`), measured on
> Postgres/pgvector with the same embedding model, and has not been reproduced against this repo's
> SQLite/FTS5 store. It is cited as a reason to *stop depending* on the floor, not as a load-bearing
> assumption: the design below works whether or not it holds here. Points 1 and 2 are this repo's
> own measurements and are directly applicable.

## Design

**Slot priority by ownership, not by score.** Local candidates fill result slots first, in their own
order. Peers fill only what is left, grouped by repo. Output is flat if and only if every returned
row is local.

No threshold, no per-model constant, no verdict. The rule reads a count, and counts are reliable
where scores measurably are not. It behaves identically with vectors on or off, so the
lexical-only path stops being a degraded special case.

### Behaviour

| Local produced | Response shape |
| --- | --- |
| `limit` rows (fills it) | flat array, unchanged, plus a pointer block naming peers with matches |
| 1..`limit-1` rows | grouped; local key first, peers filling the remainder |
| 0 rows | grouped; local key present and empty |

Flat, as today, with no `repo` field on rows:

```json
[ { "id": "…", "title": "…" } ]
```

Grouped, when any returned row is foreign:

```json
{ "knowl": [], "knowl-cloud": [ { "id": "…", "title": "…" } ] }
```

The shape is the signal. A notice can be skimmed past; a response whose structure is wrong for
"this repo's answer" cannot be read as one.

Two details the shape rule leaves open, settled here:

- **Peer group order** is by each group's best-scoring row, descending. Local is always first
  regardless, including when empty — its position is what says "this is your repo, and this is
  what it had."
- **The pointer block also appears in a grouped response** when a peer had matches that won no
  slot. Its wording is the same; only its trigger is "peer matched but is not shown," which can
  hold in either shape.

### Scope selection

`scope` joins `repos` in `knowl_query`'s input schema (`src/mcp/tool-definitions.ts:359`).

| Call | Searches | Returns |
| --- | --- | --- |
| `scope: "local"` | this repo only; peer databases never opened | flat |
| `repos: ["a","b"]` | named repos only (already implemented) | grouped |
| `scope: "workspace"` | every sharing repo | grouped |
| neither | local-first, per the table above | flat or grouped |

`repos: ["<self>"]` already yields local-only today (`src/workspace/federated-query.ts:103`).
`scope` exists because an agent does not reliably know its own repo's name, and `repos` requires
it. When both are passed, `repos` wins as the more specific of the two.

**An explicit scope fixes the shape; only the default path derives it.** `scope: "local"` is
always flat, `scope: "workspace"` and `repos` are always grouped — including when peers happen to
return nothing, which renders as `{ "knowl": [ … ] }` rather than a bare array. A caller naming
repos asked for a repo-partitioned view and gets one whether or not the partition turned out
interesting; a shape that changed under them based on what was found would be worse than a
one-key object. The "flat iff every row is local" rule governs the default path alone.

### Selection cost is unchanged

Every repo is still read on the default path, exactly as today. Only the *presentation* branches.
This matters for two reasons: the pointer block costs no extra query, and the demand ledger keeps
seeing the same events it sees now. Only `scope: "local"` changes what is read.

### Per-repo scoring becomes correct

The current code fuses everything into one ranking deliberately: `normalizedRecencyScore`
normalizes each item's date against the candidate set it arrives with, so ranking per repo and
fusing would give every repo's newest item the same recency score
(`src/workspace/federated-query.ts:52-58`). Grouped output never compares two repos' scores, so
that constraint expires. Recency normalizing within a repo is correct for a per-repo list.

## What the relevance floor keeps doing

Nothing is replaced. The floor's current job — a verdict rendered as the `NO CONFIDENT MATCH`
block (`src/mcp/tools.ts:890`) — is untouched. It does not drop rows and does not reorder; slot
priority decides ordering and shape and produces no verdict. The two do not overlap.

One knock-on: under grouping, `abstained` becomes **per group** rather than one verdict over the
fused set. Each group is scored within itself, so the block can name which repos came up empty
instead of delivering a single flat verdict. Strictly more informative, no new machinery.

## Decisions

| # | Decision | Why |
| --- | --- | --- |
| 1 | Slot priority is count-based, never score-based | The three measurements above; no threshold can gate this |
| 2 | Flat output iff every row is local | The shape is the signal; a notice alongside foreign rows is skippable |
| 3 | Peers are still read on the default path | Keeps the pointer free and the demand ledger whole |
| 4 | Pointer block carries repo names and counts, never content | Preserves discoverability without reintroducing silent substitution |
| 5 | `scope` is added rather than reusing `repos` alone | An agent does not reliably know its own repo's name |
| 6 | `repos` wins when both are passed | More specific of the two; no error path for a benign combination |
| 7 | The relevance floor is left exactly as it is | It was never wrong at its own job; it is wrong at this one |

## Accepted costs

**A weak local row can displace a strong peer row.** With local filling slots first, a
low-relevance local hit takes a slot a genuinely useful shared fact would have had. The pointer
block is what recovers it — the peer is named and counted, and one re-query with `repos` reads it.

**Local's weak row can sit above better peer rows.** Local returns one weak row against `limit` 3,
so the grouped response leads with that row and follows with two solid peer rows. This is
deliberate: reading peer rows as this repo's answer is the failure being eliminated; reading a weak
local row as weak is not a failure.

**Slight tension with demand-paged scoping.** That design wants more cross-repo knowledge reaching
readers; this one makes peer answers less prominent. They reconcile through Decisions 3 and 4 —
peers are still read, still recorded in the ledger, and still named in every response. What changes
is that a peer answer is never mistakable for a local one.

**`scope: "local"` undercounts demand.** Skipping peer selection means no `federated_query` ledger
event of the usual shape. The event must still be recorded, marked as locally scoped, or the ledger
silently under-reports cross-repo demand — the exact measurement
[demand-paged scoping](2026-08-07-demand-paged-scoping-design.md) is waiting on.

## Blast radius

**Core.** `queryFederated` returns `{ groups, skipped }` instead of a fused list; scoring moves
from one union pass to one pass per repo. Roughly the back half of `src/workspace/federated-query.ts`.

**Downstream, four places:**

- `boundQueryPayload` takes `unknown[]` (`src/mcp/tools.ts:251`) and must bound an object of arrays,
  trimming peer groups before the local one.
- The per-row `repo` field is redundant inside groups and is dropped there. Existing foreign-item
  handling — `affectedPaths` and evidence stripped (`src/mcp/tools.ts:804-821`) — is unchanged.
- `src/cli/query-command.ts` shares the engine and needs the same grouped rendering.
- The demand ledger's `servedRepo` and `contributed` still derive from groups. Add whether local
  filled its slots: the first direct measurement of how often this fires.

**Evals.** `docs/evals/cross-repo-archetypes.json` — 92 cases over 5 archetypes — scores MRR, R@3
and forbidden against a single fused ranking. Grouped output has no single ranking, so the suite
needs a defined flattening (local group first, then peers in group order) to keep MRR meaning what
it meant. Numbers will move. That is re-baselining and must be recorded as such, so the shift is
not read later as a retrieval regression.

**Tests.** Local fills all slots → flat plus pointer. Local partial → grouped, local first. Local
zero → grouped with an empty local key. `scope: "local"` → peer databases never opened.
`repos` and `scope` together → `repos` wins. Ledger event recorded under `scope: "local"`.

## What this design does not do

- **No change to promotion.** Promotion still means workspace-*visible*, not workspace-*applicable*.
  Splitting those is a real design — a promoter declaring "this applies anywhere" versus "this is
  mine, FYI" — and it needs a schema change. Revisit if attribution alone proves insufficient.
- **No relevance floor changes.** Left exactly as shipped, including its known corpus dependence.
- **No cross-repo reranking.** Groups are never compared to each other, which is what makes
  per-repo scoring sound.
- **No default change for non-workspace repos.** A repo with no workspace is untouched by all of
  this and returns the same flat array it always has.
