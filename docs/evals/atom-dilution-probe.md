# Atom dilution and candidate depth — probe, 2026-09-10

[#281](https://github.com/dat999zx/knowl/issues/281) measured that one atom gets one embedding
vector, so a verbatim quote from a long atom's tail does not reliably retrieve its own parent.
This is that measurement ported to a standing script, re-run against this repo's real store, plus
the candidate-depth sweep the maintainer asked for in the same ruling.

**Two findings, and they point in opposite directions.** The dilution effect is real and
reproduces almost exactly on an independently sampled set — the windowed control lands at
**+0.0746** against the issue's +0.0749. But the *shipped* path is much healthier than the
vector-only number suggests: fusion recovers tail quotes that vector search alone loses, 21/30
against 8/30 at rank 1. Chunking would be fixing a number no user's query is scored by.

**On candidate depth: the constant should not change.** `limit * 10` moves 3 of 30 tail queries
from unfound to rank 1 and moves *nothing else anywhere* — every metric of the 200-question
accuracy benchmark is byte-identical at 3, 5 and 10. That is a real gain with no measured cost,
and it is still not enough, for the reason given under [Recommendation](#recommendation).

Reproduce with `npx tsx scripts/probe-atom-dilution.ts <root-or-db>`. The probe is read-only over
any store and prints the corpus's size and age before any conclusion, because every claim here is
a claim about **long** atoms and a store without them can only report that it has none.

## Corpus

Everything below is one store, and its shape is the first thing that would falsify any of it.

```
db             D:\coding\knowl\.knowl\knowl.db
model          granite-embedding-small-english-r2 q8/cls  (eeb8ae73e6c641c1)
atoms          1358 total, 1197 active
ranked against 1197 vectors under this profile
age            oldest 2026-07-04, newest 2026-09-09, median atom 34.4 days old
```

The population under test is the 64 active atoms whose embed text reaches 3,500 characters —
**5.3% of the store.** 30 were sampled by even stride over id order (stride 2), spanning 3,587 to
9,479 characters, median 3,958. Two of the 30 are clipped by the token budget.

This is a two-month-old corpus, and that is a caveat rather than a footnote: the long-atom
population is small, it is written in one house style, and 60 of the 64 sit in the narrow 3.5–6k
band. A store with genuinely long documents — imported design docs, pasted transcripts — would
have a different tail and could move every number here.

## Method

Each sampled atom contributes one query: the longest 60–300 character sentence beginning in the
final third of its embed text, quoted verbatim and embedded through `embedQuery` (so it carries
the model's query prefix, as a real query would).

Three details that decide whether the measurement means anything:

- **Quotes are cut from the CLIPPED text**, the same `clipToBudget` the embedder applies on the
  way in. A quote past the token budget was never in the vector at all, so finding it missing
  would measure truncation ([#132](https://github.com/dat999zx/knowl/issues/132)) rather than
  dilution — a different defect with a different fix.
- **A sentence must BEGIN in the final third**, not merely overlap it. One that starts mid-atom
  and runs into the tail is not a tail quote, and counting it would weaken the effect being
  measured.
- **The title control asserts rather than prints.** A title is the first line of the embed text
  and the least diluted query available; if titles cannot find their own parents, the probe is
  measuring itself. It scored **10/10 at rank 1**, so the ranking path is sound and the tail
  numbers below are about the tail.

Two rankings are reported because they answer different questions. Vector-only over all 1,197
stored vectors is the dilution measurement, and nothing in the fusion layer can move it. Fused
through `rankKnowledge` is the path a real query actually takes.

## Tail-quote retrieval

| metric | vector-only (1,197 vectors) | fused (`rankKnowledge`, limit 10) |
| --- | --- | --- |
| queries | 30 | 30 |
| parent at rank 1 | **8/30** | **21/30** |
| parent in top 3 | 12/30 | 21/30 |
| parent in top 10 | 14/30 | 21/30 |
| median rank | 13 | 1 |
| worst rank | 533 / 1197 | not returned |
| MRR@10 | **0.3298** | **0.7000** |

The vector-only column reproduces #281 (which recorded 6/30 at rank 1, median 4, MRR@10 0.3567)
on an independently drawn sample: the same shape, the same order of magnitude, a worse median.
**Half the long atoms in this store cannot be found by quoting their own tails, semantically.**

The fused column is the finding the issue did not have. BM25 does not pool — a verbatim quote is
a near-perfect lexical match against the atom containing it — so the lexical half of the fusion
recovers most of what pooling loses. The tail defect is real in the vector index and largely
absorbed before it reaches a user.

That is also the strongest argument for the deferral the maintainer already ruled: chunking would
carry a composite key, a migration, an `EMBED_RECIPE_VERSION` bump and a publish/pull contract
change, in order to improve a number (0.3298) that no shipped query path reports, on 5.3% of one
store's atoms, where the number that *is* shipped reads 0.7000.

## Windowed control

The same 30 queries scored against a 500-character window cut around the quoted sentence,
embedded as a document by the same embedder, against the whole-atom vector actually stored.

| quantity | mean cosine |
| --- | --- |
| whole-atom vector (the one stored) | 0.8332 |
| 500-char window around the sentence | 0.9078 |
| **window advantage** | **+0.0746** |

**The window wins for 30 of 30 atoms** — min +0.0100, median +0.0755, max +0.1679. The issue
recorded +0.0749 on its own sample; this is +0.0746 on a different one.

This is what makes the result a statement about **pooling** rather than about the model or the
text. The same embedder, the same query, the same sentence: the only variable is how much
unrelated text was averaged into the document vector. The text was always retrievable, and
averaging is what lost it.

## Candidate-depth sweep

`src/store/agent-query.ts:409` caps how many rows reach scoring:

```ts
const candidateLimit = Math.max(limit * 3, 10);
```

`docs/evals/mutation-deep.md:141` records why this is not a page size: recency is normalised
against the candidate set and the convex combination is scored over it, so widening it moves
scores for rows already in. It is a fusion change, and it gets the ranking-change treatment. Each
setting was measured by editing the constant, running everything below, and reverting it — the
constant is **not** changed by this PR.

### The probe

| candidateLimit | vec rank 1 | vec top 3 | vec top 10 | vec median | vec MRR@10 | fused rank 1 | fused top 3 | fused top 10 | fused MRR@10 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `limit * 3` (shipped) | 8/30 | 12/30 | 14/30 | 13 | 0.3298 | 21/30 | 21/30 | 21/30 | 0.7000 |
| `limit * 5` | 8/30 | 12/30 | 14/30 | 13 | 0.3298 | 21/30 | 21/30 | 21/30 | 0.7000 |
| `limit * 10` | 8/30 | 12/30 | 14/30 | 13 | 0.3298 | **24/30** | **24/30** | **24/30** | **0.8000** |

Two sanity checks that the sweep was valid rather than merely green. The vector-only column is
**identical across all three settings** for all 30 queries, which is the prediction: the constant
is not on that path, and any movement there would have meant the harness was varying something
else. The windowed control is likewise byte-identical (+0.0746 at every setting).

**`limit * 5` changes nothing at all, and the mechanism says why.** The three queries that improve
at `* 10` have their parent at vector rank 59, 88 and 92. At limit 10 those are outside a
30-candidate pool and outside a 50-candidate pool, and inside a 100-candidate one. Each goes from
*not returned at all* to **rank 1** — they are not marginal re-orderings, they are recoveries. No
query got worse at any setting.

### The existing suites

Cross-repo retrieval, semantic cross-repo, cross-repo archetypes, `rank-knowledge` and the
agent-query vector branch, at each setting:

| candidateLimit | result |
| --- | --- |
| `limit * 3` | 35/35 pass |
| `limit * 5` | 34/35 — one failure |
| `limit * 10` | 34/35 — the same one failure |

The single failure at both widened settings is
`tests/store/agent-query-vector-branch.test.ts > passes the query profile and candidate limit
through to the vector search`, asserting `options.limit === 15` for `limit: 5`. It is a pin on the
constant's arithmetic (5 × 3), not a ranking regression, and it would be updated by whatever
change ships the new value. **No scored retrieval assertion moved at any setting.**

### The accuracy benchmark

`coding-memory-v1`, 200 questions, 3 runs, median of run-level metrics — the full release
protocol, at each setting:

| metric | `limit * 3` | `limit * 5` | `limit * 10` |
| --- | --- | --- | --- |
| strict accuracy@k | 0.7459 | 0.7459 | 0.7459 |
| Recall@1 | 0.3103 | 0.3103 | 0.3103 |
| Recall@3 | 0.6138 | 0.6138 | 0.6138 |
| Recall@5 | 0.7483 | 0.7483 | 0.7483 |
| Recall@10 | 0.7862 | 0.7862 | 0.7862 |
| MRR | 0.7151 | 0.7151 | 0.7151 |
| nDCG@5 | 0.6541 | 0.6541 | 0.6541 |
| stale result rate | 0.0020 | 0.0020 | 0.0020 |
| forbidden result rate | 0.0070 | 0.0070 | 0.0070 |
| abstention accuracy | 0.3600 | 0.3600 | 0.3600 |

**Every metric is identical at every setting.** A table of unchanged numbers is exactly what a
broken measurement looks like, so it was checked rather than believed: the constant was crushed to
`Math.max(limit * 1, 1)` and the same benchmark re-run.

| metric | `limit * 3` (shipped) | `limit * 1` (positive control) | delta |
| --- | --- | --- | --- |
| strict accuracy@k | 0.7459 | 0.7351 | **−0.0108** |
| Recall@10 | 0.7862 | 0.7793 | **−0.0069** |

The benchmark **can** see this constant, and reports no change between 3 and 10 because there is
none to report on that dataset. Its atoms are short — the generator writes one fact per record —
so it has no long-atom tail for a wider pool to reach into. That is the honest reading: this
benchmark is not sensitive to the defect, and its flat row is evidence of *no regression*, not of
no effect.

## Recommendation

**Leave `candidateLimit` at `limit * 3` in this PR.** The probe lands, the constant does not.

The case for `limit * 10` is real: +3/30 tail queries recovered from nothing to rank 1, fused
MRR@10 0.70 → 0.80, and not one measured regression across 35 suite tests and 14 benchmark
metrics. If the number changes, `* 10` is the value — `* 5` is measurably worthless here, because
the ranks that matter sit at 59–92.

What stops it is that the evidence is 3 queries on 30 samples from one 5.3%-of-one-store
population, against a cost that is real and unmeasured. Widening the pool 3.3× is 3.3× the rows
decoded, hydrated and scored on **every** query in the product, to fix a case that arises when
somebody quotes a long atom's tail verbatim. Nothing here measured that latency, and
`docs/evals/mutation-deep.md` is explicit that the rows already in the pool have their scores
moved by the widening — this sweep shows that no *measured* ordering changed, not that none can.

The lazy correct move is to keep the probe as the standing check and let the constant ride on
evidence that actually needs it — the same discipline `FUSION_ALPHA` got.

### What would change this recommendation

- **A latency measurement showing `* 10` is free.** If widening the pool costs nothing on the p99
  query, the argument against it collapses and it should ship.
- **The same +3/30 on a second store**, particularly one with a real long-atom population rather
  than this repo's 64. One store is an anecdote.
- **A user-visible report of the failure.** The fused path already finds 21/30, so the defect
  reaching a person requires quoting the tail of a long atom whose lexical match also fails.

### What would falsify the dilution finding itself

- **The windowed advantage disappearing on another corpus.** +0.0746 across 30/30 atoms on two
  independent samples is the load-bearing number; if a different store shows the whole-atom vector
  matching or beating its own window, pooling is not the mechanism and this document is wrong.
- **The title control failing.** It is an assertion in the probe for that reason: 10/10 at rank 1
  is what licenses reading the tail numbers as a claim about tails.
- **A longer-atom corpus showing the fused path collapsing too.** The recommendation rests on
  fusion absorbing the defect (21/30 against 8/30). If BM25 stops rescuing tail quotes at greater
  atom lengths, the vector-only number becomes the user-visible one and chunking is back on the
  table.
