# Recorded runs

MemoryAgentBench Conflict Resolution, single-hop 6k (`data/cr-sh-6k.json`, 100 questions).
Reproduce with `npm run bench:cr -- run --instance benchmarks/memoryagentbench/data/cr-sh-6k.json`.

**Compare the `retrieval`, `embedding` and `supersede` fields, not the filenames.** A filename says
what the run was *for*; only those fields say what it actually did. `cr-sh-6k-vector.json` was read
as a current vector-path measurement and its 26 stale leaks as a regression against
`cr-sh-6k-supersede-on.json`'s 3 — but it carries `supersede: undefined`, meaning it predates the
flag, so the two differ by code state and not by retrieval mode. There was no regression.

**`embedding` exists because the same trap recurred on a second axis.** The default preset moved
from minilm-l6-en to granite-small-en-r2 on 2026-08-02, which moved cr-sh-6k top-1 from 96% to 98%
and cr-sh-64k from 91% to 95% — in *opposite directions from each other*. Runs recorded before that
field was added carry no `embedding` at all; those are minilm, and the only other thing that dates
them is `timestamp`. Never subtract across two runs whose `embedding` differs or is absent.

| File | retrieval | embedding | supersede | top-1 | stale leaks | p50 | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `cr-sh-6k-supersede-on.json` | vector+bm25 | granite *(unrecorded)* | on | 98% | 2 | 13ms | **Published ablation, ON arm.** The README and reference.md figures come from here. |
| `cr-sh-6k-supersede-off.json` | vector+bm25 | granite *(unrecorded)* | off | 47% | 62 | 14ms | **Published ablation, OFF arm.** Doubles as the control: if this stops looking bad, the metric has broken rather than the product improved. |
| `cr-sh-6k-vector-granite.json` | vector+bm25 | granite | on | 98% | 2 | 17ms | The 6k row of the scaling table below, and an independent reproduction of the ON arm. |
| `cr-sh-6k-bm25-2.7.0.json` | bm25 | *(none)* | on | 82% | 2 | 15ms | Lower bound. No embedding is involved, so this one is unaffected by the preset change. |
| `cr-sh-6k-vector.json` | vector+bm25 | minilm | *(pre-flag)* | 96% | 26 | 19ms | **Historical.** Predates supersession-at-write. Not comparable to anything above. |
| `cr-sh-6k-vector-2.7.0.json` | vector+bm25 | minilm | on | 96% | 3 | 35ms | **Historical.** 2.7.0 on the old preset. |

## Scaling: where the headroom actually is

Same question type (single-hop), same task, growing corpus, all three on granite-small-en-r2.
Run 2026-08-07.

| instance | facts ingested | active after ingest | top-1 | any-rank | stale leaks | p50 |
| --- | --- | --- | --- | --- | --- | --- |
| `cr-sh-6k` | 455 | 306 | 98% | 100% | 2 | 17ms |
| `cr-sh-32k` | 2310 | 1535 | 95% | 98% | 1 | 41ms |
| `cr-sh-64k` | 4580 | 3016 | 95% | 99% | 3 | 111ms |

**top-1 falls 3 points from 6k to 32k and then stops falling.** 32k and 64k are level at 95% while
the corpus doubles, so the curve flattens rather than degrading with scale. any-rank holds at
98-99% throughout: the correct answer is still retrieved into the top 5 and is being *ranked* below
something else, which is a ranking problem rather than a recall problem.

Latency grows roughly linearly with the corpus (455 → 4580 facts, 17ms → 111ms p50). Worth knowing
before anything is tuned: a ranking change that costs an extra pass over candidates shows up here.

### The previous version of this section was wrong, and worth keeping as a warning

Measured on minilm, the same three instances read 96% / 97% / **91%**, which supported a confident
conclusion: "top-1 falls 6 points by 64k… 64k has 9 points of top-1 to win… **use 64k, not 6k, to
justify retrieval work.**" All of it was an artifact of the embedding model.

Swapping the preset moved 6k **up** two points and 64k **up** four, erasing the cliff that made 64k
look special. Note the directions differ — 32k went *down* while the other two went up — so this
was not a uniform offset that a reader could have mentally corrected for.

The surviving claim is the weaker one: there are ~5 points of top-1 to win, they are a ranking
problem, and they are available at 32k as readily as at 64k. **Prefer 32k for iteration** — same
headroom at roughly a third of the latency.

Active-after-ingest also shifted slightly (1537 → 1535 at 32k, 3019 → 3016 at 64k), so
supersession-at-write is not fully independent of the embedding model. Small, but it means an
ablation must hold the preset fixed too.

`cr-sh-32k-vector-2.8.0.json` and `cr-sh-64k-vector-2.8.0.json` are the superseded minilm runs the
paragraph above is about. They are kept only as the evidence for it — they carry no `embedding`
field and must not be read as current.

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

**On 6k, top-1 and any-rank cannot show an improvement**, only a fall: 98% and 100% are effectively
the ceiling. An early revision of this note generalised from that to "the benchmark has no headroom
anywhere", which was wrong — 6k was simply the only instance small enough to run before the
write-path segfault fix in `c59c570`. The correction that replaced it, that 64k specifically carried
9 points of headroom, was wrong too, for a different reason: it compared runs across two embedding
models. **Two successive conclusions here died of comparing runs that differed in something other
than the thing under test.** That is what the `retrieval` / `embedding` / `supersede` fields are for.

**No metric here separates "the ranker improved" from "the embedding model changed".** Every figure
is end-to-end. Before attributing a movement to a code change, confirm `embedding` matches on both
sides — and if a run predates that field, it is minilm and cannot be compared to anything current.

Row 7 (single-hop 262k) is still unfetched. It is the next step up, though the 32k/64k plateau at
95% suggests corpus size has stopped being the interesting axis.
