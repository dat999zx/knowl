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

> **Superseded once, by measurement.** This section originally specified *slot priority by
> ownership*: local candidates fill every result slot before any peer's. It was implemented and
> measured against `docs/evals/cross-repo-archetypes.json` on 2026-08-08, and it fails —
> Recall@3 collapsed on **all five** archetypes (asymmetric-trio 1.0 → 0.361, monorepo-split
> 1.0 → 0.528, client-projects 1.0 → 0.694, polyglot-services 1.0 → 0.600, fork-siblings
> 0.944 → 0.639). The gold answer was not ranking lower; it was leaving the page.
>
> **Cause.** `perRepoCap` admits ten candidates per repo whatever their quality, so a local repo
> nearly always holds `limit` weak FTS matches and peers won no slot at all.
>
> **The reasoning error.** The abstention measurements say no *absolute threshold* can separate
> "weak local answer" from "no local answer". They say nothing against ranking a local row
> against a peer row inside one scored union — which is precisely the comparison `corpusBest`
> (per-corpus lexical normalization) and `lexicalCoverage` ("corpus-independent by construction,
> which is what makes two repos' lexical evidence comparable at all") exist to make valid. A
> limit on what a threshold can decide was over-read as a limit on what a ranking can decide.
>
> Attribution belongs in the response **shape**, where it costs two eval cells, not in slot
> allocation, where it costs the answer.

**Grouping by owning repo. Relevance still decides the page.**

`scoreCandidates` runs once over the union and its top `limit` rows are the page, exactly as
before. Those rows are then partitioned by owning repo. Output is a bare array when every
returned row is local, and an object keyed by repo when any row is foreign.

Groups are ordered by their best row, so a peer holding the better answer is not buried behind
this repo's weaker one. The single exception is an **empty** local group, which is pinned first:
it ranks nowhere, so the pin costs no position, and it is the entire "your repo has nothing on
this" signal.

### Behaviour

| Local produced | Response shape |
| --- | --- |
| every returned row | flat array, unchanged, plus a pointer block naming peers with matches |
| some rows, peers took others | grouped; groups ordered by best row |
| no rows | grouped; local key present, empty, and first |

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

### Scoring stays a single union pass; grouping is presentation only

An earlier draft of this design said scoring would move to one pass per repo, on the grounds that
grouped output never compares two repos' scores so `normalizedRecencyScore`'s union requirement
expires. **That was wrong.** Recency is one of four coupled reasons the union pass exists, and
reading `src/store/agent-query.ts` shows the other three survive grouping intact:

1. **Alpha renormalizes globally.** `alpha = !usingVector ? 0 : (anyLexical ? FUSION_ALPHA : 1)`
   (`agent-query.ts:583`), with the comment stating it is global "rather than per corpus: two
   repos scored under different alphas would not be comparable, which is the whole reason scoring
   runs over the union." A repo with no lexical hit would score under alpha 1 while its neighbour
   scored under 0.8.
2. **The semantic rescale is page-wide.** `rescaleSemantic` min-maxes against `semanticFloor` and
   `semanticCeiling` computed over all candidates (`agent-query.ts:572-578`). Per repo, every
   repo's best row rescales to ~1.0 — the same defect in a new place.
3. **The abstention verdict is deliberately cross-corpus.** When the floor fires, rows from a
   corpus that judged *nothing* are labelled rather than exempted (`agent-query.ts:691-696`),
   because "an off-topic peer item became the answer to a question the indexed store had just
   said it could not answer" (K-36). Judging each group alone reverses that fix.

The comparability argument also applies to the *reader*, not only the code. `score` is published
on every row, and an agent reading a grouped response sees two groups' numbers side by side and
will compare them whether or not the ranker did.

**Consequence, and it shrinks the change:** `scoreCandidates` is not modified at all, and is not
even called differently. It runs once over the union exactly as today — global alpha, page-wide
rescale, per-corpus lexical normalization via `corpusBest`, the cross-corpus abstention verdict,
union recency, `limit` unchanged. Grouping happens after it returns, in `queryFederated`, over the
page it already chose.

The cross-repo lexical problem this design might otherwise have had to solve is already solved
inside that pass: `corpusBest` normalizes per corpus and `lexicalCoverage` — "corpus-independent
by construction, which is what makes two repos' lexical evidence comparable at all"
(`agent-query.ts:260-267`) — is the signal that spans them.

## What the relevance floor keeps doing

Nothing is replaced. The floor's current job — a verdict rendered as the `NO CONFIDENT MATCH`
block (`src/mcp/tools.ts:890`) — is untouched. It does not drop rows and does not reorder;
grouping decides shape and produces no verdict. The two do not overlap.

One knock-on, revised from an earlier draft: `abstained` does **not** become a per-group verdict.
It is computed over the union with cross-corpus logic that exists to fix a real bug
(`src/store/agent-query.ts:691-696`, K-36) — rows from a corpus that judged nothing are labelled
rather than exempted — and recomputing it per group would undo that. Only the *reporting* changes:
`abstained` is already a per-item set, so the block can name which repos hold abstained rows
without the verdict being recomputed anywhere.

## Decisions

| # | Decision | Why |
| --- | --- | --- |
| 1 | Relevance decides the page; grouping decides the shape | Ownership priority was measured and collapsed Recall@3 on all five archetypes |
| 1b | Groups ordered by best row, empty local group pinned first | An empty group ranks nowhere, so pinning costs no position; a non-empty one must not outrank a better answer |
| 2 | Flat output iff every row is local | The shape is the signal; a notice alongside foreign rows is skippable |
| 3 | Peers are still read on the default path | Keeps the pointer free and the demand ledger whole |
| 4 | Pointer block carries repo names and counts, never content | Preserves discoverability without reintroducing silent substitution |
| 5 | `scope` is added rather than reusing `repos` alone | An agent does not reliably know its own repo's name |
| 6 | `repos` wins when both are passed | More specific of the two; no error path for a benign combination |
| 7 | The relevance floor is left exactly as it is | It was never wrong at its own job; it is wrong at this one |

## Accepted costs

**Grouping cannot interleave, and that costs two eval cells.** Bunching each repo's rows together
is the whole mechanism, and it is incompatible with strict relevance order: with `limit: 5` and a
relevance order of `[local, gold, local, local, local]`, grouping yields `[local ×4, gold]`, so an
answer that sat at rank 2 sits at rank 5 — still on the page, outside the top 3. Measured cost on
`cross-repo-archetypes`: positional polyglot-services MRR 0.9 → 0.8916 and semantic
monorepo-split Recall@3 1.0 → 0.9722, roughly one case each. The other **18 of 20 cells are
byte-identical**, because page membership never changed. Recorded in the baseline's
`groupingCost` note.

**A peer match can be left off the page entirely.** `limit` is `limit`, and a peer row that loses
to local rows on relevance is not shown. The pointer block is what recovers it — the peer is named
and counted, and one re-query with `repos` reads it.

**Local's weak row can sit above better peer rows** *within the flattened view*, whenever local's
best row outscores the peer's best and so takes the first group. This is
deliberate: reading peer rows as this repo's answer is the failure being eliminated; reading a weak
local row as weak is not a failure.

**Slight tension with demand-paged scoping.** That design wants more cross-repo knowledge reaching
readers; this one makes peer answers less prominent. They reconcile through Decisions 3 and 4 —
peers are still read, still recorded in the ledger, and still named in every response. What changes
is that a peer answer is never mistakable for a local one.

**~~`scope: "local"` undercounts demand.~~** *Checked 2026-08-08 and it does not.* The concern was
that skipping peer selection would skip the ledger write. It does not: the write is guarded on
`active && query`, which a locally-scoped query still satisfies, so volume is unaffected. Only the
*interpretation* needed help, and `detail.scope` now marks a narrowed read so it is not counted as
an open one. `detail.localAnswered` was added alongside it — the first direct measurement of how
often this repo is asked something only a neighbour holds, which is the quantity grouping actually
changes and which nothing recorded before.

## Blast radius

**Core.** `queryFederated` returns `{ groups, skipped }` instead of a fused list, and gains slot
allocation over the list `scoreCandidates` already returns. `src/store/agent-query.ts` is not
modified — see "Scoring stays a single union pass" above. Confined to the back half of
`src/workspace/federated-query.ts`.

**Downstream, four places:**

- `boundQueryPayload` takes `unknown[]` (`src/mcp/tools.ts:251`) and must bound an object of arrays,
  trimming peer groups before the local one.
- The per-row `repo` field is redundant inside groups and is dropped there. Existing foreign-item
  handling — `affectedPaths` and evidence stripped (`src/mcp/tools.ts:804-821`) — is unchanged.
- `src/cli/query-command.ts` shares the engine and needs the same grouped rendering.
- The demand ledger's `servedRepo` and `contributed` still derive from groups. Add whether local
  contributed the top row: the first direct measurement of how often this fires.

**Evals.** `docs/evals/cross-repo-archetypes.json` — 92 cases over 5 archetypes — scores MRR, R@3
and forbidden against a single ranking, so the suite takes `flattenGroups`: groups in order, rows
in the ranker's order within each.

Measured 2026-08-08: **18 of 20 cells byte-identical**, two moved by roughly one case each
(positional polyglot-services MRR 0.9 → 0.8916, semantic monorepo-split Recall@3 1.0 → 0.9722).
Page membership never changed, so nothing moved from scoring; the two that moved are grouping's
inability to interleave. Recorded in the baseline's `groupingCost` note so the shift is not read
later as a retrieval fault.

**Tests.** Every row local → flat plus pointer. Mixed → grouped, groups ordered by best row.
Local empty → grouped with an empty local key, pinned first. Rows of one repo never interleaved
with another's. `scope: "local"` → peer databases never opened. `repos` and `scope` together →
`repos` wins. Ledger event recorded under `scope: "local"`.

## What this design does not do

- **No change to promotion.** Promotion still means workspace-*visible*, not workspace-*applicable*.
  Splitting those is a real design — a promoter declaring "this applies anywhere" versus "this is
  mine, FYI" — and it needs a schema change. Revisit if attribution alone proves insufficient.
- **No relevance floor changes.** Left exactly as shipped, including its known corpus dependence.
- **No cross-repo reranking.** Groups are never compared to each other, which is what makes
  per-repo scoring sound.
- **No default change for non-workspace repos.** A repo with no workspace is untouched by all of
  this and returns the same flat array it always has.
