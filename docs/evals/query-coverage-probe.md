# `queryCoverage` as a relevance floor — probe, 2026-08-24

[#169](https://github.com/dat999zx/knowl/issues/169) left three directions after
[`preset-floor-sweep.md`](preset-floor-sweep.md) closed direction 2. Direction 1 was the only one
with evidence behind it: *a relative or corpus-free signal instead of an absolute cosine cut.*

`queryCoverage` (`src/store/search.ts`) looked like that signal already existed. It is the share of
the query's distinct terms an item contains, prefix-matched, computed on every lexical hit, and its
own doc comment claims exactly the missing property:

> unlike BM25 it means the same thing in every repo: it is a property of the item and the query,
> with no corpus statistics in it.

**Verdict: it cannot be a floor, and the reason is arithmetic rather than tuning.** It stays what it
already is — a ranking factor.

Reproduce with `npx tsx scripts/probe-query-coverage.ts`. Raw output:
[`query-coverage-probe-2026-08-24.json`](query-coverage-probe-2026-08-24.json).

## Method

Against this repo's real ~1,200-atom store, not a fixture corpus — coverage is model-independent, so
it needs no preset loop, and the interesting failure only appears against real prose. Three probe
classes, `searchKnowledgeItemsRanked` at limit 10, taking the maximum coverage over hits.

The third class is the whole point. The first two were never in doubt.

1. **off-technical** — jargon from domains this project has never written about.
2. **on-specific** — questions phrased in the corpus's own vocabulary.
3. **on-vague** — questions this store genuinely answers, phrased the way somebody half-remembers
   them. Few terms, no jargon, no overlap engineered in.

## Results

| class | n | min | p50 | max |
| --- | --- | --- | --- | --- |
| off-technical | 6 | 0.200 | 0.200 | 0.500 |
| on-specific | 3 | 1.000 | 1.000 | 1.000 |
| **on-vague** | 8 | **0.500** | 0.800 | 1.000 |

**On-topic min 0.500 against off-technical max 0.500 — a gap of exactly 0.000.** No threshold
divides them.

The per-probe table, with the term count that explains it:

| class | coverage | terms | query |
| --- | --- | --- | --- |
| off | 0.200 | 5 | `trombone slide positions overtone series` |
| off | 0.200 | 5 | `kayak eskimo roll paddle feathering` |
| off | **0.500** | 4 | `sourdough starter discard crumb` |
| on-vague | **0.500** | 2 | `why is startup slow` |
| on-vague | 0.500 | 2 | `how do agents talk to this` |
| on-vague | 0.500 | 4 | `what happens when two facts disagree` |
| on-vague | 0.800 | 5 | `what did we decide about staleness` |
| on-vague | 1.000 | 2 | `where does the data live` |
| on-specific | 1.000 | 7 | `relevance floor per model preset cosine abstain` |

## Why: coverage is quantized at `1 / n`

Coverage is a fraction whose denominator is the number of distinct query terms surviving
stop-word removal. **A short query has few reachable values.** `why is startup slow` is two terms
after stop-words, so it can only ever score 0, 0.5 or 1 — and it scored 0.5 against a store that
answers it in detail, because one of its two terms matched.

Genuinely on-topic questions are often short *precisely because they are vague*, which is the same
population a floor most needs to get right. Partially-matching junk lands on the same coarse grid:
`sourdough starter discard crumb` is 4 terms with 2 matched, also 0.500.

So the two distributions do not merely overlap — they are forced onto the same small set of values
at exactly the query lengths where the question is hard. That is not a threshold that needs moving.
It is a resolution limit.

This is a different failure from the cosine one, and worth keeping distinct. Cosine fails because a
question in the corpus's register is *semantically* close to the corpus whether or not anything
answers it. Coverage fails because it is *too coarse* to express the difference at short query
lengths. Neither is fixed by picking a better number.

## Shipped anyway: `coverage` is now published

Independent of the floor question, coverage was being destroyed at the API boundary, and that part
was a real defect. In `src/store/agent-query.ts`:

```ts
const lexical = raw === undefined ? 0 : (best > 0 ? Math.min(raw / best, 1) * coverage : coverage);
```

`best` is this page's top raw BM25, so `raw / best` is min-max *within the page* and means nothing
across queries — the same non-comparable shape as `score`. Multiplying coverage into it destroys the
one property coverage had, and `contributions` published only the product.

**This is structurally identical to [#146](https://github.com/dat999zx/knowl/issues/146)**: an
absolute number computed internally, folded into a normalized one, and only the normalized one
handed to the caller. That was fixed for the semantic half by publishing `cosine` alongside `score`.
The lexical half still had it. `contributions.coverage` now publishes the factor beside the product.

Additive, no behaviour change, and it is what lets anyone re-run this measurement — or a better one
— without patching `src`.

## Limits

Small: 6 off-technical, 3 on-specific, 8 on-vague probes, one store. Enough to establish the
quantization argument, because that argument is about the arithmetic and the probes only have to
demonstrate it once. **Not** enough to claim the exact 0.000 gap generalizes.

**Contamination warning, and it bit twice while writing this.** This store contains atoms *about*
retrieval evaluation, and those atoms quote probe strings verbatim. `recipe for sourdough bread
starter` scores 1.000 here — correctly, because the terms really are in the corpus. A first run of
this probe used technical strings taken from a stored finding and two of them scored 1.000 for the
same reason. **Never probe a Knowl store with a string its own eval documents discuss**, and always
report which atom a probe matched so the contamination is visible rather than silent.

## What is left for #169

Direction 1 is not closed by this — coverage is one candidate for a corpus-free signal and it
failed. Untried: a *relative* signal rather than an absolute one, which is what the issue actually
proposed first — the margin between the best and second-best result, or the store's own
self-similarity distribution measured at index time. Both are unmeasured, and neither has the
resolution problem, because a margin between two continuous scores is itself continuous.
