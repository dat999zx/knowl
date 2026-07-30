# Recorded runs

MemoryAgentBench Conflict Resolution, single-hop 6k (`data/cr-sh-6k.json`, 100 questions).
Reproduce with `npm run bench:cr -- run --instance benchmarks/memoryagentbench/data/cr-sh-6k.json`.

**Compare the `retrieval` and `supersede` fields, not the filenames.** A filename says what the
run was *for*; only those fields say what it actually did. `cr-sh-6k-vector.json` was read as a
current vector-path measurement and its 26 stale leaks as a regression against
`cr-sh-6k-supersede-on.json`'s 3 — but it carries `supersede: undefined`, meaning it predates the
flag, so the two differ by code state and not by retrieval mode. There was no regression.

| File | retrieval | supersede | top-1 | stale leaks | p50 | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `cr-sh-6k-vector.json` | vector+bm25 | *(pre-flag)* | 96% | 26 | 19ms | **Historical.** Predates supersession-at-write. Not comparable to anything below. |
| `cr-sh-6k-supersede-on.json` | vector+bm25 | on | 96% | 3 | 19ms | The real prior baseline for the shipped default. |
| `cr-sh-6k-supersede-off.json` | vector+bm25 | off | 40% | 62 | 20ms | Ablation. Doubles as the control: if this stops looking bad, the metric has broken rather than the product improved. |
| `cr-sh-6k-vector-2.7.0.json` | vector+bm25 | on | 96% | 3 | 22-24ms | 2.7.0, the shipped default. Unchanged from the prior baseline. |
| `cr-sh-6k-bm25-2.7.0.json` | bm25 | on | 82% | 2 | 15ms | 2.7.0 lower bound. Vector buys 14 points of top-1 for ~8ms. |

## What 2.7.0 measured

Retrieval quality is **unchanged** by the 2.7.0 refactor: 96% top-1 and 3 stale leaks, matching
`supersede-on` exactly. For a change that rewrote candidate selection, split scoring out of
ranking, moved filtering above the result cap and replaced the cross-repo fusion, "no movement" is
the result worth having — the ablation still scores 40%/62, so the benchmark can still tell good
from bad.

Latency sits at p50 22-24ms against a recorded 19ms. Three consecutive runs on identical code
spanned p50 19-35ms on this machine, so that gap is inside the noise; treat it as unmeasured
rather than as a regression.

## What this benchmark cannot tell you

`staleLeaks` is a substring check: a retired fact's text appearing anywhere in a returned item's
content counts, even when the item that carried it is the current one. Top-1 accuracy is saturated
at 96% and any-rank at 100%, so neither can show an improvement — only a fall. A change aimed at
retrieval quality needs a harder instance (rows 0-3 are the multi-hop 32k/64k/262k variants) or a
different dataset; tuning against these numbers would be tuning against a ceiling.
