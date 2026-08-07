# Local preference in cross-repo ranking — measured and rejected

2026-08-07

A record of an idea that looked well-evidenced, shipped nowhere, and is documented here so the
next person does not spend a day rediscovering it.

## The idea

With every atom in a workspace made visible, the remaining hazard is that a peer's item takes
rank 1 from the querying repo's own answer. The proposal: when the top result is foreign, check
whether it is *the same fact* as a local candidate (title overlap ≥ 0.60 via `tokenOverlapScore`).

- **Same fact** → leave it; the fuller copy is the better answer.
- **Different fact competing on the same topic** → promote the local item to rank 1, since the
  question was asked *here*. The peer stays on the page.

Only rank 1 was affected; with no local candidate the rule did not fire at all.

## Why it looked right

Measured against a real three-repo workspace: all atoms flipped to workspace-visible, 12 queries
re-run. Without the rule, 3 of 12 top results changed and one was clearly wrong (a routing query
in a React repo answered by a vanilla-TS sibling's router pattern). With the rule, **0 of 12
changed** — the hazard appeared to vanish at no cost.

Two weaker alternatives were measured and rejected on the way, and those rejections still stand:

| approach | why rejected |
| --- | --- |
| flat "prefer local" prior | no multiplier separates the cases — the bad one needs < 0.767, the good one breaks at < 0.883 |
| `affectedPaths` as a shareability classifier | 85% of shared items carry no code path, but so do 59% of private ones |
| demote foreign items carrying code paths | demotes the good case too |

## Why it was wrong

The 12 queries, their labels, and the counterexamples were all produced by the same person who
designed the rule. That is not a small sample, it is a **closed loop**: the queries chosen were
ones where the local repo genuinely owned the answer, so the rule was never shown a case it
could lose.

Run against `cross-repo-archetypes.json` — 92 cases over 5 workspace shapes, labelled blind by
authors who were not told local-vs-foreign was the question — it loses everywhere, on both
ranking paths. MRR:

| archetype | positional base → rule | semantic base → rule |
| --- | --- | --- |
| asymmetric-trio | 0.9444 → **0.7130** | 1.0000 → **0.8056** |
| monorepo-split | 0.9167 → **0.7222** | 1.0000 → **0.8056** |
| polyglot-services | 0.9000 → **0.7500** | 1.0000 → **0.8250** |
| fork-siblings | 0.9444 → **0.8611** | 0.9444 → **0.8611** |
| client-projects | 1.0000 → **0.8889** | 0.9722 → **0.9167** |

Five archetypes, two paths, ten cells, ten regressions. `cross-repo-suite.json` agrees
independently: MRR 1.0000 → 0.8333.

Recall@3 barely moved — the right answer stays on the page. What collapses is MRR, which is
exactly the rule's mechanism: it pushes correct answers off rank 1. The blind labels say the peer
is frequently the honest answer, because that is what a workspace is *for*. A small repo asking
the big one, a service asking the shared infra convention, a fork whose sibling holds the note
that explains the drift — the rule penalises every one of them.

## What to take from it

1. **The local repo has no privileged claim on being right.** Any future "prefer local" variant
   is arguing against ten measured cells and needs a stronger case than intuition.
2. **A ranking change validated on self-authored queries is not validated.** Label the cases
   blind, or the measurement only confirms its author.
3. **Score per workspace shape, never pooled.** These deltas range from −0.06 to −0.23; an
   average would have read as a modest cost rather than a uniform loss.
