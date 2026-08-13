# Drift signal precision, and what to do with the result

Status: accepted, 2026-08-13.

## The problem, measured

`runAutoDriftCheck` records a drift observation on `knowledge_items.last_drift_at`. Measured on
this repository's own store:

| | knowl | knowl-cloud |
| --- | --- | --- |
| active items | 867 | 297 |
| carrying an unread drift observation | **339 (39%)** | **78 (26%)** |
| of those, a cited path is **gone** | **42** | **2** |
| of those, every cited path still exists | 226 | 72 |
| `needs_review` actually set | 24 | 0 |

Roughly 88% of what the detector says is not actionable. That is the band static-analysis
research identifies as the point where developers stop reading a tool at all — false positives run
18–86% of warnings across tools, non-actionable findings 35–91%, and the consequence is
documented as alert fatigue and abandonment.

**Nothing acts on this signal, and that was correct.** Flipping `freshness` was previously measured
as corpus-wide ranking damage. The reason is breadth rather than depth: the priors are already
gentle (`needs_review` 0.94, `stale` 0.88, both soft multipliers), but applying one to 39% of a
corpus is what did the damage.

## Root cause

`knowledgeMentionsChangedPath` (`src/store/freshness.ts`) answers **"did a file this atom mentions
change?"**. The question worth answering is **"is this atom still true?"**. Three specific defects
follow:

1. **Any edit counts as drift.** The most-cited paths among flagged items are simply the repo's
   highest-churn files — `src/mcp/tools.ts` (34), `package.json` (28), `README.md` (23),
   `src/cli/program.ts` (21). Reformatting `program.ts` does not invalidate a fact about ranking.
2. **`source` is matched by raw substring.** `source.includes(changedPath)` against free text.
   The intent is sound — `source` usually *is* a path list, e.g.
   `"src/store/database.ts; src/store/bootstrap.ts; package.json"`, and 58 of the 71 items with no
   `affectedPaths` are flagged legitimately through it. The mechanism is not: it matches prose too.
3. **`tags` are matched as paths.** A tag is a topic label. It can only fire when the tag is
   literally a top-level directory (`tests`, `docs`, `src`), which is 8 items — small in volume,
   indefensible in principle.

## Non-goals

- **No new GC actions.** GC recommends nothing on either store today (Archive 0, Compress 0,
  Purge 0) and there is nothing old enough to decay: 2 items cold past 30 days, **0 past 60**.
  Age-based decay would act on nothing. Revisit when the corpus is older.
- **No LLM dependency.** Knowl's AI configuration is optional, and staleness detection must not
  require it. Classification here is deterministic.
- **No automatic deletion anywhere**, and nothing server-side that removes a team's knowledge.

## Phase 1 — make the signal mean something

Deterministic, no model, no schema change beyond one column.

1. **Drop tag-as-path matching.** Remove the `tags` branch from `knowledgeMentionsChangedPath`.
2. **Parse `source` into path tokens** rather than substring-matching it. Split on `;`, trim, keep
   tokens that look like paths, and match them with `pathMatches` like any other path. This
   preserves the 58 legitimate matches and drops the prose ones.
3. **Separate *gone* from *changed*.** These are different events sharing one column today. A
   cited path that no longer exists is strong evidence; a cited path that was edited is weak.
4. **Exclude high-churn paths** from counting as drift on their own: lockfiles, `CHANGELOG.md`,
   `.github/**`, `dist/**`, `README.md`, and generated output. An atom that cites *only* churn
   paths produces no drift candidate.

## Phase 2 — classify, and drop the benign class

Modelled on DocPrism's LCEF result, which cut a documentation-consistency flag rate from 98% to
14% while raising accuracy from 14% to 94%. The mechanism that mattered was not a better model: it
was categorising each finding and **discarding one whole category** — "under-promise", the natural
gap between what code does and what docs claim, which was most of the volume.

Knowl's equivalent of under-promise is *"a cited file changed but the assertion still holds"* —
226 of 339 observations. Same shape, same remedy. Three classes:

| class | meaning | actionable |
| --- | --- | --- |
| `removed` | a cited path no longer exists **and was not renamed** | **yes** |
| `symbol-removed` | cited evidence names a symbol no longer in the file | **yes** |
| `untracked-moved` | a cited untracked directory moved after the atom was written | **yes** |
| `moved` | git renamed the cited path; the atom is still true, its path is stale | **no — dropped** |
| `changed` | the file exists and was merely edited | **no — dropped** |

**`moved` exists because the first cut of this design shipped without it and was wrong.** Auditing
its 44 survivors found only 14 real: **30 were renames**, nearly all from one refactor moving
`src/store/host-lifecycle.ts` and its neighbours into `src/session/`. A rename leaves the old path
absent from the tree, so existence alone cannot tell it from a deletion — precision was 32%, not
the ~100% the rule implied.

Renames come from `git diff --name-status -M` over the same range that produced the changed files,
so the cost is one extra git call per check and no history scan. Note that
`git log --find-renames -- <path>` does **not** work: the pathspec limits the diff and hides the
destination, reporting every rename as a plain delete. That is what made the first audit report
zero renames.

Deterministic throughout: `removed` is a filesystem check, `symbol-removed` reuses the evidence
already stored in `knowledge_evidence`.

`untracked-moved` is exempt from the removal rule rather than subject to it, because it already
carries its own precision: it compares a directory's mtime against the atom's `updated_at`, so it
is time-scoped in a way the git path is not, and it only runs when a caller passes
`includeUntracked` — which only `knowl pr check` does. Applying the removal filter on top would
discard a signal that had already earned its place.

**Measured against both real stores** by replaying the currently-flagged items through the shipped
matcher and classifier (`scripts/measure-drift-precision.ts`):

| | before | after | noise removed |
| --- | --- | --- | --- |
| knowl | 339 | **14** | **95.9%** |
| knowl-cloud | 78 | **1** | **98.7%** |

A recall spot-check read 8 of the 290 items dropped as "the cited file still exists": *"CLI
entrypoint is `src/index.ts`"*, *"MCP server is thin tool wiring"*, *"Knowledge search uses SQLite
FTS5 and BM25"*, *"Knowl build and verification commands"*. All still true, and all would have sat
permanently flagged under the old rule. Indicative rather than conclusive — recall cannot be
measured without ground truth.

## Phase 3 — route the surviving signal into the prior that already exists

No new ranking mechanism is needed. Both repos already demote softly and independently:

- CLI: `FRESHNESS_PRIOR = { fresh: 1, needs_review: 0.94 }`, `FRESHNESS_PRIOR_STALE = 0.88`
  (`src/store/agent-query.ts`)
- Server: `if (candidate.freshness !== 'fresh') prior *= 0.88` (`src/knowledge/search/fuse.ts`)

Surviving candidates set `needs_review` (0.94). `stale` stays reserved for explicit human
judgement. Because Phase 2 removes the benign class, this applies to a small fraction of the
corpus rather than 39% of it — which is precisely what made the earlier attempt harmful.

## Phase 4a — report upward, but only what survived

`reportDrift` and `reportReviewed` are complete, gated and tested, and have no production caller.
They gain one, invoked only for candidates that survive Phase 2, and still behind
`checkUpstreamGate` — a drift report retires knowledge for the whole team, so it keeps requiring an
up-to-date default branch. The server side needs no change: `markNeedsReview`,
`review_reported_at` and the four `review_*` provenance columns already exist.

## Phase 4b — team-scale visibility, in knowl-cloud

`src/knowledge/hygiene.ts` already reports what the team's memory looks like as a body of
knowledge, and its own documentation names the next step: unread items are "candidates for review,
and later for team-scale GC". It gains a staleness section — how many atoms carry an open review
report, how long they have been open, and which are unread as well as flagged.

**Reporting only.** No server-side deletion, and no retention sweep. `policy.retentionDays` already
exists as a knob and is deliberately left alone here.

**One property must be preserved.** Every figure in `hygiene.ts` is derived from
`knowledge_access` and none of it reaches ranking, deliberately: a read-count prior is a feedback
loop, where an atom that ranks high is read more and therefore ranks higher, with nothing in the
loop asking whether it is true. The new section inherits that rule — it reports, it never ranks.

## Testing

Each phase is pinned by tests written before the change:

- **Phase 1** — a tag equal to a directory no longer drifts; a `source` path list still does while
  prose in `source` does not; a deleted path and an edited path produce different events; an atom
  citing only `package.json` produces no candidate.
- **Phase 2** — a `changed` candidate is dropped; `removed` and `symbol-removed` survive.
- **Phase 3** — a surviving candidate lands on `needs_review`; a dropped one leaves freshness alone.
- **Phase 4a** — nothing is sent from a feature branch or a behind checkout; only survivors are sent.
- **Phase 4b** — the hygiene report counts open review reports and stays out of ranking.

## Rejected alternatives

- **Extend GC's age-based archive to more categories.** Measured: it would act on zero items.
- **An LLM classifier for Phase 2.** Would make staleness detection depend on optional AI config.
  The deterministic split captures the category that carries the volume; a model can be added later
  behind the same interface if `changed` ever needs subdividing.
- **Flipping `freshness` on every observation.** Already tried, already measured as harmful. Phase 2
  exists so that this becomes safe by shrinking what qualifies.
- **Server-side drift detection.** Structurally impossible: the server is deliberately git-blind and
  has no working tree to compare against.
