# Per-model relevance floor — measurement, 2026-08-04

`MIN_VECTOR_RELEVANCE = 0.30` was one absolute cosine applied to five embedding models. This is
the measurement that replaced it with one number per model, and the measurement that rules out
the scale-free alternative.

## Method

- **On-topic**: all 110 cases of `docs/evals/semantic-suite.json`, 50 fixtures.
- **Off-topic**: 15 probes with no answer in the store (`how do I bake sourdough bread`,
  `what is the capital of Peru`, `best hiking trails in patagonia`, …), run against **the same
  50 fixtures**, so corpus size is not a confound between the two sets.
- The quantity is `bestCosine` — the highest **raw** cosine among judged candidates, which is
  exactly what `scoreCandidates` tests. Not the gold item's cosine, which is a different number
  and is what `floor-sweep.md` reported.
- A fresh repo per preset, so vectors are rebuilt under that model. Each preset at its own
  dtype (`q8` for all five).

## 1. The scale is the model's, not the corpus's

| preset | on-topic min | on-topic p50 | off-topic p50 | off-topic max |
| --- | --- | --- | --- | --- |
| arctic-embed-m-v2 | 0.1638 | 0.4926 | 0.1327 | 0.2275 |
| granite-small-en-r2 | 0.7637 | 0.8600 | 0.7098 | 0.7644 |
| granite-97m-multilingual | 0.7443 | 0.8346 | 0.7168 | 0.7552 |
| bge-small-en | 0.5399 | 0.7391 | 0.5079 | 0.5754 |
| minilm-l6-en | 0.2003 | 0.4982 | 0.1010 | 0.2392 |

Granite's whole distribution sits roughly 0.5 above arctic's on identical inputs. No single
number can be a threshold for both, and 0.30 is not a threshold for either:

| preset | at 0.30: real answers mislabelled | at 0.30: junk caught |
| --- | --- | --- |
| arctic-embed-m-v2 | **24/110** | 15/15 |
| granite-small-en-r2 | 0/110 | **0/15** |
| granite-97m-multilingual | 0/110 | **0/15** |
| bge-small-en | 0/110 | **0/15** |
| minilm-l6-en | 10/110 | 15/15 |

On three of the five presets — including `granite-small-en-r2`, the default — the floor never
fired at all, so the `NO CONFIDENT MATCH` notice was unreachable and the feature was dead.

## 2. The scale-free alternative does not work

If separation could be judged relatively — how far the top result stands out from the rest —
no per-model number would be needed. Three such statistics were computed per query over the
candidates the ranker already has: `margin` (top minus the mean of the rest), `ratio` (top over
that mean), `z` (standard deviations above it). Overlap between on-topic and off-topic, lower
is better:

| preset | absolute cosine | margin | ratio | z |
| --- | --- | --- | --- | --- |
| granite-small-en-r2 | **0.0007** | 0.0594 | 0.1011 | 4.71 |
| arctic-embed-m-v2 | **0.0637** | 0.0686 | 2.37 | 2.25 |

The absolute cosine separates best on both, and the relative statistics are not close on
granite. The reason is straightforward in hindsight: a query that finds nothing relevant still
produces a peaked distribution, because the best of fifty unrelated notes stands out from the
other forty-nine much as a real answer does. Rejected on evidence.

## 3. The chosen floors

Each is the observed on-topic minimum rounded down to two decimals — the highest cut that
mislabels nothing on the on-topic set.

| preset | floor | mislabelled | junk caught |
| --- | --- | --- | --- |
| arctic-embed-m-v2 | 0.16 | 0/110 | 12/15 |
| granite-small-en-r2 | 0.76 | 0/110 | 14/15 |
| granite-97m-multilingual | 0.74 | 0/110 | 12/15 |
| bge-small-en | 0.53 | 0/110 | 11/15 |
| minilm-l6-en | 0.20 | 0/110 | 12/15 |

### Why not the Youden-optimal cut

It reaches 15/15 on every preset, at 1–5 mislabelled real answers per 110 (arctic 0.2340 → 5;
granite 0.7646 → 1; granite-97m 0.7671 → 5; bge 0.5814 → 2; minilm 0.2485 → 4).

Rejected for two reasons. `agent-query.ts` already holds that silencing a real answer is worse
than admitting a weak one, and agent traffic is overwhelmingly on-topic — a 4.5% error rate on
the common case is a bad trade for a better rate on the rare one. More decisively, **the Youden
cut is fit to the 15-probe junk set** while the conservative cut is fit to the 110-query
on-topic set. At these sample sizes the conservative estimate is the more robust one, not
merely the safer one.

## 4. Limits

- One 50-fixture corpus. Corpus affects the numbers: `floor-sweep.md` measured arctic's junk
  ceiling at 0.2678 on a real 483-item store against 0.2275 here. These are good defaults, not
  universal constants, and `minRelevance` stays a parameter so a re-sweep is a measurement.
- 15 off-topic probes is a small junk sample. It bounds how precisely the catch rates should be
  read, and it is the reason the cut is not fit to them.
- An unmeasured model gets `null` and does not abstain at all. That is a withheld claim rather
  than a borrowed constant — see `relevanceFloorFor`.
