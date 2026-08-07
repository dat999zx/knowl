# Sharing everything vs curating visibility — measured

2026-08-07

Whether to hand-pick which knowledge items a workspace shares, or share all of them and let
retrieval sort it out. Measured on `cross-repo-archetypes.json`: the same 92 cases, run twice on
the semantic path, once at the visibility the fixture authors chose (~50-60% shared) and once
with every item forced to workspace-visible.

## Result

| archetype | curated MRR | shared MRR | Δ | curated R@3 | shared R@3 |
| --- | --- | --- | --- | --- | --- |
| asymmetric-trio | 1.0000 | 1.0000 | — | 1.0000 | 1.0000 |
| monorepo-split | 1.0000 | 1.0000 | — | 1.0000 | 1.0000 |
| polyglot-services | 1.0000 | 1.0000 | — | 1.0000 | 1.0000 |
| fork-siblings | 0.9444 | 0.9167 | −0.028 | 0.9444 | 0.9444 |
| client-projects | 0.9722 | 0.9167 | −0.056 | 1.0000 | 1.0000 |
| **pooled** | **0.9837** | **0.9674** | **−0.016** | **0.9891** | **0.9891** |

**Recall is identical to four decimal places.** Three of five shapes show no change at all. The
entire cost is a rank-1-to-rank-2 shuffle on a handful of queries in the two shapes with the most
vocabulary collision — unrelated clients using the same generic words, and diverged forks.

Items the suites marked as "should not crowd the page" appear more often (8 → 35), which is the
expected and honest consequence: those items exist and are now visible. They are preferences, not
errors, and they cost no recall.

## Why the real cost of curating is larger than this table shows

This measurement flatters curation, structurally. It scores ranking quality **given the answer is
reachable**. It cannot score the case where the answer is private and therefore invisible — those
cases are simply unwinnable, and three had to be repaired out of the suite for exactly that
reason before a baseline could be recorded at all.

So the curated column is not "curation done well", it is "curation done perfectly, by authors who
knew which items would be asked for". Real curation is a person deciding once per item, ahead of
knowing what anyone will ever ask, with no undo. Measured on one real three-repo workspace, that
process left **95% of knowledge private** and produced an asymmetric surface where seven identical
rules were shared from one repo and private in its sibling.

The comparison is therefore: a measured −0.016 MRR and no recall loss, against an unmeasured but
demonstrably large volume of knowledge that is never retrieved at all.

## It is not capture noise

The obvious suspicion, raised on review: workspaces accumulate auto-captured `fact` and `state`
entries — per-commit resolutions, transient test failures — and that mass is what moves the number
when the default flips. If so, the recommendation would narrow to "flip the default, keep the
noise categories out".

It does not hold. Tested by adding the missing variable rather than removing a category: 120
capture-noise items of exactly that shape (`Resolved failure in src/session/impact.ts: readFile on
a directory -> EISDIR`, half `fact`, half `state`, private), roughly doubling the corpus, then
re-measuring the same delta.

| corpus | curated MRR | shared MRR | Δ | forbidden shown |
| --- | --- | --- | --- | --- |
| clean (121 items) | 0.9837 | 0.9674 | −0.0163 | 8 → 35 |
| +120 noise items | 0.9837 | 0.9674 | −0.0163 | 8 → 35 |

Identical to four decimal places, same forbidden count. **Capture noise never competes**: it does
not rank for a real question, so it never enters the per-repo candidate pool, and
`DEFAULT_PER_REPO_CAP` means the pool is what matters rather than the corpus. Noise is dead weight
in the store, not a rival in the ranking. The −0.016 is substantive items competing.

Excluding `fact` and `state` from the flip *does* recover about a third of it (0.9674 → 0.9728) —
but by sharing fewer substantive items, not by withholding noise, since the noisy and clean runs
of that arm are also identical. "Share less" moving the number toward "share nothing" is
mechanical, and does not support a category rule.

Note this suite cannot answer the question by holding `fact` and `state` private outright: **47 of
its 92 expected answers are in those two categories**, because the fixture authors used them for
substance rather than for capture. That measures fixture composition, not the hypothesis.

## Why the cost is structurally bounded

`DEFAULT_PER_REPO_CAP = 10`. Only ten candidates per repo ever enter scoring, however many are
shared. Sharing more atoms changes *which* ten a peer submits, not how many compete — so the
degradation cannot scale with corpus size the way intuition suggests.

## What this does not license

Sharing everything is safe **because the ranker is left alone**. A "prefer local" rule intended to
recover that last 0.016 was measured on this same suite and lost on all five archetypes and both
ranking paths — see `cross-repo-local-preference.md`. The residual cost is real and small; the
obvious fix for it is worse than the problem.
