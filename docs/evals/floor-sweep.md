# Relevance-floor sweep — 2026-08-04

`MIN_VECTOR_RELEVANCE = 0.30` was measured on 2026-08-01, before the scoring redesign, as the
gap between on-topic and off-topic **top scores** on one real store. The redesign then moved the
floor onto the raw cosine and reused the number. It had never been re-validated against the
ranker that now uses it, and `alpha-sweep.md` reported a non-zero `empty` column in every single
row — 12 cases on the 1,649-case suite, 4 on the 500-case one — without varying the thing that
causes it. Alpha had a sweep knob from the day it was measured; the floor did not.

This is that measurement.

## Why it matters more than a mediocre hit

A false abstention is indistinguishable, at the call site, from "the store does not know this".
The agent then goes and re-derives something memory already held. A mediocre hit is visible and
can be judged; an absence cannot be, and it is also indistinguishable from an empty store or a
missing vector index.

## Method

- `selectCandidates` runs **once per case** and `scoreCandidates` is re-run over the identical
  candidate set at each floor, so the floor is the only variable. Same shape as the alpha sweep.
- Embedder `Snowflake/snowflake-arctic-embed-m-v2.0`, dtype `q8`, CLS pooling — the shipped preset.
- Fixtures seeded exactly as `knowl eval retrieval` seeds them (real ids, case labels translated).
- Scratch stores under the worktree. The real store was **copied** and read from the copy.

## 1. The real store the constant was tuned on

483 items, 481 embedded. 10 off-topic queries (sourdough, capital of Peru, bicycle tyres…) and
12 on-topic ones phrased the way someone half-remembers a thing.

| set | min | p50 | max |
| --- | --- | --- | --- |
| off-topic top cosine | 0.0905 | 0.1950 | **0.2678** |
| on-topic top cosine | **0.3137** | 0.5045 | 0.6565 |

The gap is real and 0.30 is inside it — but it is **a third as wide as recorded**. The old note
claims "0.08 above the worst junk and 0.10 below the weakest legitimate query"; on a larger query
set it is 0.032 above and **0.014** below. One more query would likely close it.

## 2. The shipped suites — the distributions overlap

Destructive floor (the behaviour under test), `empty` = cases with a gold answer in the store
that returned **nothing**:

### `semantic-suite.json` — 110 cases, 50 fixtures

| floor | Recall@3 | Recall@10 | MRR | empty | off-topic answered (want 0) |
| --- | --- | --- | --- | --- | --- |
| 0 | 0.9182 | 0.9818 | 0.86409 | 0 | 6/6 |
| 0.20 | 0.9000 | 0.9545 | 0.85045 | 4 | 2/6 |
| 0.25 | 0.8727 | 0.9000 | 0.82136 | 11 | 0/6 |
| **0.30** | 0.7727 | **0.7909** | 0.74106 | **23** | 0/6 |
| 0.35 | 0.6727 | 0.6727 | 0.64697 | 36 | 0/6 |
| 0.40 | 0.6091 | 0.6091 | 0.60303 | 43 | 0/6 |

**21% of answerable queries returned nothing at the shipped value**, and Recall@10 fell from
0.9818 to 0.7909. The blanked cases are almost entirely the `-m1` and `-x1` tiers — the moderate
and extreme paraphrases, which is precisely the query vector search exists to serve.

### `retrieval-suite.json` — 500 cases | `retrieval-suite-v2.json` — 1,649 cases

| floor | 500: empty | 500: off-topic | 1,649: empty | 1,649: off-topic |
| --- | --- | --- | --- | --- |
| 0.20 | 0 | 1/6 | 1 | 2/6 |
| 0.25 | 1 | 1/6 | 5 | 1/6 |
| **0.30** | **6** | 0/6 | **11** | 1/6 |
| 0.35 | 17 | 0/6 | 45 | 0/6 |

At 0.30 the 1,649-case suite still answers one off-topic query while blanking eleven real ones —
there, the floor is paying full price and not even buying the abstention.

## 3. Not the embeddings (K-71 ruled out)

K-71 found batch composition perturbs a stored vector by up to 5.4e-2 cosine, which is a
meaningful fraction of the distance to a 0.30 bar. Tested directly: each blanked gold item
re-embedded **alone** (batch of 1, exact by K-71's own measurement) and re-scored against the
same query embedding.

| | |
| --- | --- |
| cases probed | 13 |
| crossed the floor when embedded alone | **0** |
| largest improvement | +0.034 (`db-postgres-m1`, 0.2588 → 0.2932 — still under) |
| stored-vs-alone self-cosine | 0.962 – 0.985 |

The perturbation is real and is not what causes this. The gold cosines are 0.087–0.277: not
marginally under the bar, genuinely under it.

## 4. What the sweep settles

**A fixed absolute cosine floor does not transfer between corpora.** On the real store, junk
tops out at 0.268 and answers start at 0.314. On `semantic-suite.json`, gold answers score
0.087–0.277 — *inside and below* the real store's junk band. There is no constant that abstains
on all six off-topic queries everywhere and blanks nothing: 0.30 is right for the real store and
wrong by 21% for the semantic suite, and the code cannot know which one a user's store resembles.

This is the same class of error as K-28 and K-70 — a constant asserted on a scale that has no
fixed meaning — one level down, on the cosine instead of the fused score.

**The fix is not a better constant. It is to stop deleting.** `agent-query.ts` already records
the priority: *"silencing one is worse than admitting a weak one."* The destructive floor broke
its own rule. The verdict is now reported as `explanation.abstained`, `knowl_query` states it in
words, `knowl query` prints it, and the ranking stands. Since K-35 every result also carries a
calibrated `score`, so a weak answer arrives visibly weak — silence was never the richer signal.

### After: the floor no longer touches the ranking

| suite | floor | Recall@3 | Recall@10 | MRR | empty | gold mislabelled | off-topic abstained (want 6) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 500-case | 0.25 | 0.9933 | 1.0000 | 0.97000 | 0 | 1 | 6/6 |
| 500-case | **0.30** | 0.9933 | 1.0000 | 0.97000 | **0** | 6 | **6/6** |
| 500-case | 0.35 | 0.9933 | 1.0000 | 0.97000 | 0 | 19 | 6/6 |
| semantic | 0.25 | 0.9273 | 0.9818 | 0.86795 | 0 | 10 | 6/6 |
| semantic | **0.30** | 0.9273 | **0.9818** | 0.86795 | **0** | 21 | **6/6** |
| semantic | 0.35 | 0.9273 | 0.9818 | 0.86795 | 0 | 35 | 6/6 |

Recall and MRR are now **identical at every floor** — the floor cannot move what is returned or
in what order, only what it is labelled. Semantic-suite Recall@10 recovers 0.7909 → 0.9818.

## 5. Why 0.30 stays

0.25 mislabels less than half as often as 0.30 on both suites at the same 6/6 off-topic
abstention, which looks like a free win — until the real store: junk there reaches 0.2678, so
0.25 would let a genuinely off-topic query through **unlabelled**, which is the error that
actually misleads a caller. 0.30 is the best value for the corpus that ships and the worst for
the synthetic suites, and no value is best for both.

Moving it would trade one corpus's labels for another's with no principled winner. The point of
this change is that **the constant no longer has to be right**: being wrong now costs a label a
caller can overrule, not an answer they never see. Left at 0.30, re-swept when the corpus
changes — `scoreCandidates` now takes `minRelevance`, so the sweep is a parameter and not a patch.
