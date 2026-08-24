# The reversal detector on real reversals: 4 of 101

Measured 2026-08-24 against this repo's own store (1,165 items, 1,034 active) while reviewing
PR #180. Replayable: `npx tsx scripts/probe-reversal-recall.ts <repo-root>`.

## Why this measurement exists

PR #180 shipped a reversal detector with a precision number and no recall number. The review
measured precision here — 25 fires on active items, **all** narrative mentions, zero live
contradictions — but that is a noise floor, not an evaluation. With no positive to score
against, "does this detector find reversals" was unanswered, and two candidate precision gates
each separated all 25 negatives from the **one synthetic positive** in the test file. Fitting a
constant to a single point is the failure [`preset-floor-sweep.md`](preset-floor-sweep.md) and
[`query-coverage-probe.md`](query-coverage-probe.md) record for the relevance floor, so both
gates were left out pending real positives.

The positives were already in the store. Every `superseded_by_id` link is a reversal that
genuinely happened — someone decided B replaces A. The same population cleared the polarity
guard as 0-of-101 in the PR #133 review.

## Population

| | count |
| --- | ---: |
| real supersessions (self-join on `superseded_by_id`) | 114 |
| …titles already in a subset relation (`sameSubjectTitle` true — the write path catches these) | 13 |
| **…titles unrelated — the detector's actual job** | **101** |

## The result

| | of 101 | |
| --- | ---: | --- |
| superseder's content contains any reversal cue | 30 | 29.7% |
| **detector fires — a cue sentence names the predecessor** | **4** | **4.0%** |
| | | (13.3% of the cue-bearing subset) |

Against 45 false fires among active items at the shipped gate. Precision ≈ 8%.

## No gate setting rescues it

Swept over the 101 real positives and every candidate pair among active items:

| gate | real reversals caught | false fires |
| --- | ---: | ---: |
| **shipped: ≥2 shared AND ≥50% of title** | 4 (4.0%) | 45 |
| ≥2 AND ≥40% | 4 (4.0%) | 78 |
| ≥2 AND ≥33% | 5 (5.0%) | 122 |
| ≥3 shared, no ratio | 6 (5.9%) | 47 |
| ≥4 shared, no ratio | 3 (3.0%) | 23 |
| ≥3 OR ≥50% | 6 (5.9%) | 69 |
| ≥`ceil(sqrt(title))` shared | 5 (5.0%) | 61 |

Nothing exceeds 6% recall. **This settles the two gates the review declined to add**: a
cue-sentence cap of ≤10 tokens keeps 1 of the 4 real reversals, and symmetric coverage ≥0.5
keeps **0 of 4**. Both would have bought their clean precision by deleting the feature.

## Per-cue contribution

| cue | real caught | false fires |
| --- | ---: | ---: |
| `supersedes` | 3 | 8 |
| `no longer` | 1 | 27 |
| `superseded` | 0 | 6 |
| `replaced by` | 0 | 4 |
| `abandoned`, `deprecated`, `reversed`, `obsolete`, `overturned`, `rescinded`, `retracted` | 0 | 0 |

**Seven of eleven cues have never fired at all**, in either direction, on a 1,165-item store.
`no longer` is 27:1 against — it is the register release notes are written in ("X no longer
does Y"), which is a *report* of a change, not an assertion that a stored item is over.
`supersedes` carries essentially all the signal, and carries it because a writer using that word
in prose is usually also passing the `supersedes` field — the case the advisory already excludes.

## Why the misses miss

The gate needs one sentence to name **half** of the predecessor title's distinctive tokens.
Knowl titles are sentences, not labels — the missed pairs carry 8, 11, 14, 18 distinctive
tokens. Half of 11 in one sentence is close to unreachable. One miss lands a single token short:

> `The relevance floor separates queries, not candidates` superseding
> `An absolute relevance floor DOES separate on-topic from off-topic` —
> 8 distinctive tokens, 3 shared, needs 4.

Lowering the ratio to reach it costs 122 false fires for one more catch.

## What this does and does not prove

**Does:** the mechanism is sound on its designed case (the Postgres/SQLite pair is caught) and
the phenomenon it keys on is rare. Only 30% of real reversals mention a cue at all, and most that
do describe the change rather than name the superseded item.

**Does not:** this population is *declared* supersessions. The detector targets **undeclared**
reversals, which by definition leave both items active and so cannot appear in
`superseded_by_id`. This is a proxy, not the target population.

The two measurements agree from opposite directions, which is why the conclusion holds: on the
declared population recall is 4%, and on the active population — where an undeclared reversal
*would* live — all 25 fires are narrative mentions and none is a real contradiction.

## Outcome

The detector stays on the **write path** and was removed from **`knowl conflicts`**.

The same 4%/8% rate reads differently on the two surfaces, and that is the whole of the
decision. At write time it is one note, attached to the writer's own sentence, quoted back, on
2.4% of writes — a reader who did not mean a reversal dismisses it in seconds, and the sentence
is right there to judge. In an inspection command it is a *list*: an agent reads a list as a
work queue, pages it, and acts on it out of context. 45 candidates with no true positive among
them is worse than the empty list it replaces, because the empty list is at least honest about
what the store knows.

So `scanContradictions` returns polarity pairs only — exact by construction, since they are the
pairs the write path's own guard deliberately creates and no other surface could show. That was
always the load-bearing half: `knowl conflicts` read `conflictKey`/`conflictExclusive` and
nothing else, set on 3 of 937 active items.
