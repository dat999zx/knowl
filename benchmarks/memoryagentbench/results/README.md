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

## Scaling: where the headroom actually is

Same question type (single-hop), same task, growing corpus. Run 2026-07-30 on 2.8.0, after the
write-path segfault fix in `c59c570` made instances above ~1200 facts runnable at all — the 32k
instance previously died during ingest and 64k was never attempted.

| instance | facts ingested | active after ingest | top-1 | any-rank | stale leaks | p50 |
| --- | --- | --- | --- | --- | --- | --- |
| `cr-sh-6k` | 455 | 306 | 96% | 100% | 3 | 22ms |
| `cr-sh-32k` | 2310 | 1537 | 97% | 98% | 1 | 50ms |
| `cr-sh-64k` | 4580 | 3019 | **91%** | 98% | 3 | 80ms |

**top-1 falls 6 points by 64k while any-rank holds at 98%.** The correct answer is still retrieved
into the top 5 — it is being *ranked* below something else. That is a ranking problem, not a recall
problem, and it is the first measurable retrieval headroom this project has had: 6k is saturated at
96/100 and cannot demonstrate an improvement, while 64k has 9 points of top-1 to win and a named set
of failing cases to inspect.

Latency grows roughly linearly with the corpus (455 → 4580 facts, 22ms → 80ms p50). Worth knowing
before anything is tuned: a ranking change that costs an extra pass over candidates shows up here.

**Use 64k, not 6k, to justify retrieval work.** Anything measured on 6k is measured against a
ceiling.

## Multi-hop instances measure something else

Rows 0-3 are the multi-hop variants. `cr-mh-6k` scores **1% top-1, 23% any-rank**, which looks like
catastrophic retrieval failure and is not. Its context is byte-identical to `cr-sh-6k`; only the
questions differ. Single-hop asks "Which sport is goaltender associated with?", answerable from one
fact. Multi-hop asks "What is the country of citizenship of the spouse of the author of Our Mutual
Friend?", which chains three facts — and the fact carrying the final answer shares no terms with the
query.

A top-k retriever cannot answer that in one item, by construction. These instances measure
compositional reasoning over retrieved facts: a reader's job, not a ranker's. Their scores are not a
retrieval signal and must not be tuned against.

## What this benchmark cannot tell you

`staleLeaks` is a substring check: a retired fact's text appearing anywhere in a returned item's
content counts, even when the item that carried it is the current one. Treat it as directional, not
exact — 1 versus 3 leaks is noise, 3 versus 62 is a signal.

**On 6k, top-1 and any-rank cannot show an improvement**, only a fall: 96% and 100% are effectively
the ceiling. An earlier revision of this note concluded from that alone that the benchmark had no
headroom left anywhere and that retrieval work could not be justified by measurement. That was wrong
— it generalised from the one instance small enough to run at the time. The 32k and 64k instances
were unrunnable because of the write-path segfault, not because they were absent, and 64k turns out
to have 9 points of top-1 headroom. Scale was the missing axis, not difficulty of question.

Row 7 (single-hop 262k) is still unfetched and is the next step up if 64k saturates.
