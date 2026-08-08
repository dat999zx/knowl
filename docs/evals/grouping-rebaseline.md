# Grouping re-baseline — cross-repo suites

Measured 2026-08-08 on `feat/workspace-query-scoping`, granite-small-en-r2, against
`docs/evals/cross-repo-archetypes.json` (92 cases, 5 archetypes) and
`docs/evals/cross-repo-suite.json`.

Federated results now arrive partitioned by owning repo instead of as one interleaved list. The
suites score a ranking, so they take `flattenGroups`: groups in order, rows in the ranker's order
within each.

**Page membership did not change.** `scoreCandidates` is untouched and is not called differently —
same single-union pass, same global alpha, same page-wide semantic rescale, same per-corpus
lexical normalization, same `limit`. Every delta below is layout.

## Result

| | positional MRR | R@3 | semantic MRR | R@3 |
| --- | --- | --- | --- | --- |
| asymmetric-trio | 0.9444 = | 1.0000 = | 1.0000 = | 1.0000 = |
| client-projects | 1.0000 = | 1.0000 = | 0.9722 = | 1.0000 = |
| fork-siblings | 0.9444 = | 0.9444 = | 0.9444 = | 0.9444 = |
| monorepo-split | 0.9167 = | 0.9444 = | 1.0000 = | **1.0000 → 0.9722** |
| polyglot-services | **0.9000 → 0.8917** | 0.9500 = | 0.9750 = | 1.0000 = |

**18 of 20 cells byte-identical.** Two moved, by roughly one case each. `soft-forbidden` holds at
its ceiling on both paths (7 positional, 8 semantic). `cross-repo-suite` is unchanged at MRR 1.0 /
R@3 1.0 / 0 forbidden on the semantic path.

## Why those two moved

Grouping cannot interleave. With `limit: 5` and a relevance order of
`[local, gold, local, local, local]`, bunching each repo's rows together yields `[local ×4, gold]` —
an answer that sat at rank 2 sits at rank 5. Still on the page, outside the top 3.

That is the entire mechanism, and it is bounded by group sizes: the more rows one repo contributes
ahead of another's answer, the further that answer moves. It cannot remove a row from the page,
which is why R@3 moved in one cell and R@10-style coverage in none.

## The variant that was rejected

An earlier implementation gave the local repo every slot before any peer's, so a peer answer could
never be mistaken for this repo's own. Measured first, and it fails — this is the reason the
shipped design puts attribution in the response shape rather than in slot allocation.

| archetype | R@3 baseline | ownership priority | grouping only |
| --- | --- | --- | --- |
| asymmetric-trio | 1.000 | **0.361** | 1.000 |
| client-projects | 1.000 | **0.694** | 1.000 |
| fork-siblings | 0.944 | **0.639** | 0.944 |
| monorepo-split | 1.000 | **0.528** | 0.972 |
| polyglot-services | 1.000 | **0.600** | 1.000 |

`perRepoCap` admits ten candidates per repo whatever their quality, so a local repo nearly always
holds `limit` weak FTS matches and peers won no slot at all. That is the gold answer leaving the
page, not ranking lower — and recall is the one thing a memory store cannot trade, because a fact
that is not on the page cannot be judged, corrected, or overruled by the reader.

The reasoning error is worth recording: the abstention measurements
(`docs/evals/per-model-floor.md`) say no **absolute threshold** can separate "weak local answer"
from "no local answer". They say nothing against ranking a local row against a peer row inside one
scored union — the comparison `corpusBest` and `lexicalCoverage` exist to make valid. A limit on
what a threshold can decide is not a limit on what a ranking can decide.

## Reading this later

A drop in any cell of the shipped table is a regression, not noise — the same rule
`cross-repo-archetype-baseline.json` already states. The two moved cells are recorded there under
`groupingCost` so they are not re-litigated as a retrieval fault.
