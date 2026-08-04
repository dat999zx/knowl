# Per-model relevance floor — design

2026-08-04

## The problem

`MIN_VECTOR_RELEVANCE = 0.30` is one absolute cosine, applied to every embedding model. Cosine
scales are model-specific, so one number cannot be right for all of them. Measured on the same
110 on-topic queries and 15 off-topic probes over the same 50 fixtures:

| preset | on-topic best cosine (min) | off-topic best cosine (max) | at the shipped 0.30 |
| --- | --- | --- | --- |
| arctic-embed-m-v2 | 0.1638 | 0.2275 | **24/110 real answers mislabelled**, 15/15 junk caught |
| granite-small-en-r2 | 0.7637 | 0.7644 | 0 mislabelled, **0/15 junk caught** |
| granite-97m-multilingual | 0.7443 | 0.7552 | 0 mislabelled, **0/15 junk caught** |
| bge-small-en | 0.5399 | 0.5754 | 0 mislabelled, **0/15 junk caught** |
| minilm-l6-en | 0.2003 | 0.2392 | 10/110 mislabelled, 15/15 junk caught |

The constant is simultaneously too high for two presets and far too low for three. On
`granite-small-en-r2`, now the default, the floor never fires at all: the `NO CONFIDENT MATCH`
notice is unreachable, so the feature is dead in the shipped configuration.

## What was measured, and what it rules out

The obvious fix is a scale-free rule — judge how far the top result *stands out* from the pack
rather than its absolute value, so no per-model number is needed. Three such statistics were
measured per query over the candidates the ranker already has: `margin` (top minus the mean of
the rest), `ratio` (top over that mean), and `z` (top's standard deviations above it).

**All three separate worse than the absolute cosine, on every model.** On
`granite-small-en-r2`, on-topic and off-topic overlap on `margin` across 0.0305–0.0899, on
`ratio` across 1.0416–1.1427, and on `z` across 0.4143–5.1212, while the absolute cosine
overlaps only across 0.7637–0.7644. Arctic behaves the same way. A query that finds nothing
relevant still produces a peaked distribution — the best of fifty unrelated notes stands out
from the other forty-nine just as clearly as a real answer does.

So the scale-free approach is rejected on evidence, not on taste. The absolute cosine is the
signal; what has to change is that there is one of it.

## Design

**A measured floor per model, and no floor for models nobody has measured.**

1. `MODEL_RELEVANCE_FLOORS` in `src/core/vector-profile.ts` maps model id to its floor, with the
   measurement recorded beside it. `relevanceFloorFor(model)` returns the floor or `null`.

2. `KnowledgeEmbedder` carries `relevanceFloor: number | null`. The thing that produces the
   vectors owns the scale of its own scores, so no call site has to know which model is loaded —
   it passes `embedder.relevanceFloor` through with the embedding it already passes.

3. `scoreCandidates` takes `minRelevance?: number | null`. Abstention runs only when it is a
   finite number. `MIN_VECTOR_RELEVANCE` is deleted rather than kept as a fallback: a default
   here is exactly the bug, because it would silently apply arctic's number to an unmeasured
   model.

4. An unmeasured or custom model gets `null` and therefore **no abstention**. Knowl declines to
   claim a store cannot answer when it has no calibration to say so with. This is the one
   deliberate gap, and it is a claim withheld rather than a wrong claim made.

### The floors, and why these values

Each floor is the observed on-topic minimum rounded down to two decimals — the highest cut that
mislabels nothing on the 110-query on-topic set.

| preset | model | floor | mislabelled | junk caught |
| --- | --- | --- | --- | --- |
| arctic-embed-m-v2 | `Snowflake/snowflake-arctic-embed-m-v2.0` | 0.16 | 0/110 | 12/15 |
| granite-small-en-r2 | `onnx-community/granite-embedding-small-english-r2-ONNX` | 0.76 | 0/110 | 14/15 |
| granite-97m-multilingual | `onnx-community/granite-embedding-97m-multilingual-r2-ONNX` | 0.74 | 0/110 | 12/15 |
| bge-small-en | `Xenova/bge-small-en-v1.5` | 0.53 | 0/110 | 11/15 |
| minilm-l6-en | `Xenova/all-MiniLM-L6-v2` | 0.20 | 0/110 | 12/15 |

The alternative was the Youden-optimal cut, which reaches 15/15 on every preset at the cost of
1–5 mislabelled real answers per 110. It is rejected for two reasons. The stated priority in
`agent-query.ts` is that silencing a real answer is worse than admitting a weak one, and real
agent traffic is overwhelmingly on-topic, so a 4.5% error on the common case buys a better rate
on the rare one. More importantly the Youden cut is **fit to the 15-probe junk set**, while the
conservative cut is fit to the 110-query on-topic set; with these sample sizes the conservative
estimate is the more robust one, and it lands on a readable two-decimal number rather than a
four-decimal artefact of one probe.

### Deliberately not built

**Self-calibration** — embedding fixed nonsense probes at reindex time to learn the junk band
for this model *and* this corpus. It is the more principled shape and it handles custom models,
but it assumes the built-in probes are off-topic for the repository, which is false for any
repo whose subject they happen to touch. That is an unverified assumption of exactly the kind
this floor already got wrong once. Recorded as the follow-up if corpus drift shows up.

### Known limits, stated rather than hidden

- The floors are measured on one 50-fixture corpus. Corpus affects the numbers — the earlier
  real-store measurement put arctic's junk ceiling at 0.2678 against 0.2275 here — so these are
  good defaults, not universal constants. `minRelevance` stays a parameter so a re-sweep is a
  measurement rather than a patch.
- Measured at each preset's own `dtype` (`q8` for all five). Overriding `dtype` moves the
  cosines somewhat; the floor is keyed on model id and stays approximately right.
- 15 off-topic probes is a small junk sample. It bounds how precisely the catch rates above
  should be read, and it is why the cut is not fit to them.

## Testing

- A test per preset pinning its floor against that model's measured band: at or below the
  on-topic minimum, so nothing measured is mislabelled, and below the off-topic maximum, so it
  is a floor rather than a formality. Not "between the two" — the two overlap on every preset,
  which is the reason no clean cut exists and the reason the conservative end is chosen. A
  floor edited without a re-measurement fails this.
- An unmeasured model returns `null` and produces no `abstained` flag on any result.
- A measured model still abstains: a candidate set below the floor is labelled, one above is not.
- The existing non-destructive guarantee is unchanged — ranking and recall must stay identical
  whatever the floor is, since the floor still only labels.
- `tests/store/relevance-floor.test.ts` currently pins the deleted constant to arctic's band and
  is rewritten against the table.
