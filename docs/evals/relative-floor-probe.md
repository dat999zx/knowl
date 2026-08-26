# Relative signals for the relevance floor — probe, 2026-08-26

[#169](https://github.com/dat999zx/knowl/issues/169) had one direction left with evidence behind
it after [`preset-floor-sweep.md`](preset-floor-sweep.md) closed direction 2 and
[`query-coverage-probe.md`](query-coverage-probe.md) eliminated `queryCoverage`:

> a **relative** signal rather than an absolute one — the margin between the best and second-best
> result, or the store's own self-similarity distribution measured at index time. Both are
> unmeasured, and neither has the resolution problem.

This is that measurement. **Direction 1 is closed. No relative signal beats absolute cosine, and
the two families fail for different reasons — one empirical, one arithmetic.**

Reproduce with `npx tsx scripts/probe-relative-floor.ts --json out.json`. Raw output:
[`relative-floor-probe-2026-08-26.json`](relative-floor-probe-2026-08-26.json).

## Method

Follows `sweep-preset-floor.ts` so the two are comparable: fresh scratch store per preset, the same
50 semantic-suite fixtures, the same 135 on-topic cases, `relevanceFloor: null` so nothing abstains
before it is measured, quantity read from `explanation.contributions.semantic` — the clamped raw
cosine before `rescaleSemantic`.

Two changes, both asked for by that document's closing caution:

- **The technical junk class is 50 probes, not 15.** Each names a domain absent from the fixture
  list — mobile, gamedev, graphics, ML training, embedded, compilers, audio, typesetting, plotting,
  robotics, bioinformatics, GIS, HDL, kernel, codecs, CAD. Anything adjacent to a fixture (Kafka,
  SQL windows, CDN headers) is still excluded, because a high cosine there is arguably correct.
- **The whole top-10 cosine vector is recorded per query**, not only its maximum, so every candidate
  signal is a pure function of one stored run. A new candidate costs an arithmetic expression
  rather than another hour of embedding.

Self-similarity is exhaustive over all C(50,2) = 1,225 fixture pairs, embedded with `embed` rather
than `embedQuery` — the latter prepends a per-model query prefix, which would measure the prefix
as much as the corpus.

`auc` is reported beside the gap because **the gap sign alone hides how badly a signal fails**: two
signals can both have a negative gap while one is nearly separating and the other is noise.

## 1. AUC — does the signal separate at all

`P(random on-topic scores above random technical junk)`. 1.0 is perfect, 0.5 is a coin flip.

| preset | absolute | margin | ratio | marginMean | z | selfExcess | selfNorm | selfRatio |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| arctic-embed-m-v2 | 0.964 | 0.953 | 0.928 | 0.975 | 0.888 | 0.964 | 0.964 | 0.964 |
| granite-small-en-r2 *(default)* | **0.971** | 0.853 | 0.845 | 0.908 | 0.779 | 0.971 | 0.971 | 0.971 |
| granite-97m-multilingual | 0.949 | 0.840 | 0.829 | 0.905 | 0.770 | 0.949 | 0.949 | 0.949 |
| bge-small-en | 0.923 | 0.836 | 0.829 | 0.892 | 0.800 | 0.923 | 0.923 | 0.923 |
| minilm-l6-en | 0.974 | 0.880 | 0.789 | 0.959 | 0.785 | 0.974 | 0.974 | 0.974 |

**Page-relative signals are strictly worse.** `margin`, `ratio`, `marginMean` and `z` lose to plain
absolute cosine on four of five presets, and `z` — the most "principled" of them — is the worst
signal in the table everywhere. This reproduces `per-model-floor.md`'s finding against the junk
class that actually matters, and the reason it gave still holds: a query that finds nothing still
produces a peaked page, because the best of fifty unrelated notes stands out from the other
forty-nine much as a real answer does.

## 2. The self-similarity family cannot help, and the reason is arithmetic

**`selfExcess`, `selfNorm` and `selfRatio` have AUC identical to `absolute`, to three decimals, on
every preset.** That is not a coincidence to be tuned away — it is forced.

Within one corpus under one model, `p50self` and `p95self` are **constants**. So:

```
selfExcess = c0 - k₁        selfNorm = (c0 - k₁) / k₂        selfRatio = c0 / k₁
```

All three are monotonic transforms of `c0`. A monotonic transform cannot reorder anything, so it
cannot change separation — only where a threshold sits on the same ordering. Corpus self-similarity
is a **rescaling, not a signal.**

Its remaining hope was cross-corpus transfer: if the junk-free bar landed at the same `selfNorm`
value on every preset, the hand-maintained `MODEL_RELEVANCE_FLOORS` table could be derived at index
time instead. It does not:

| preset | junk-free bar in `selfNorm` units | self p50 → p95 |
| --- | --- | --- |
| arctic-embed-m-v2 | 0.574 | 0.210 → 0.382 |
| granite-small-en-r2 | 0.812 | 0.755 → 0.815 |
| granite-97m-multilingual | 1.425 | 0.704 → 0.782 |
| bge-small-en | 1.484 | 0.537 → 0.640 |
| minilm-l6-en | 1.196 | 0.107 → 0.320 |

A 2.6× spread. Both of self-similarity's possible payoffs fail: it cannot improve separation, and
it cannot replace the per-model constants.

## 3. The overlap, restated

Gap = `min(on-topic) - max(technical junk)`. Negative everywhere, for every signal — so no threshold
divides them, which is what #169 already knew for `absolute` and now holds for all eight.

How many of 135 real queries score at or below the single worst piece of junk:

| preset | absolute | margin | marginMean | z |
| --- | --- | --- | --- | --- |
| arctic-embed-m-v2 | 25 | 33 | 20 | 116 |
| granite-small-en-r2 | **23** | 57 | 62 | 83 |
| granite-97m-multilingual | 47 | 53 | 40 | 83 |
| bge-small-en | 47 | 48 | 44 | 97 |
| minilm-l6-en | 27 | 58 | 41 | 122 |

## 4. What the numbers actually say

AUC 0.971 on the default preset is **good separation, not noise.** The signal is fine. What is
impossible is the *requirement*: with 17% of real queries sitting in the junk's range, no single
threshold can both never-silence-a-real-answer and always-catch-junk.

That is only a contradiction if one threshold has to serve both readers. It does not.

**The pull path** (`knowl_query`) is recall-first: a false abstention is indistinguishable from an
empty store, so the caller re-derives what memory already held. `agent-query.ts` says this in its
own comment — *silencing a real answer is worse than admitting a weak one* — and 0.76 is correctly
tuned for it. **Leave it alone.**

**A push path** — anything that injects unasked, on a hook, with no agent having requested it — is
precision-first, and inverts every term. A wrong hit is not a wasted lookup, it is context poisoning
on every turn; and silence costs nothing, because the agent simply carries on as it does today.

At the bar where **zero** technical junk survives:

| preset | shipped floor | junk-free bar | on-topic surviving |
| --- | --- | --- | --- |
| arctic-embed-m-v2 | 0.16 | 0.3089 | 110/135 — 81.5% |
| granite-small-en-r2 *(default)* | 0.76 | **0.8037** | **112/135 — 83.0%** |
| granite-97m-multilingual | 0.74 | 0.8149 | 88/135 — 65.2% |
| bge-small-en | 0.53 | 0.6901 | 88/135 — 65.2% |
| minilm-l6-en | 0.20 | 0.3620 | 108/135 — 80.0% |

On the default preset that is **+0.044 over the shipped floor for 100% junk rejection at 83%
coverage.** A second constant beside `MODEL_RELEVANCE_FLOORS`, not a new mechanism.

## Limits

**`max(junk)` is the most overfit statistic available**, and the junk-free bar is fitted directly to
it. A 51st probe could land above it. The bar is the *shape* of the answer and roughly its size; it
is not a shippable constant. Anything shipped should sit above `p99(junk)` with deliberate margin
and be re-measured against a real store.

One corpus — the 50-fixture synthetic semantic suite, generic backend-SaaS. Not run against a real
Knowl store, deliberately: this repo's store now contains atoms that quote these probe strings
verbatim, so it is contaminated for exactly this measurement. `query-coverage-probe.md` warns about
this and it bit twice there; a real-store confirmation needs fresh probes that appear in no atom.

The contamination check in section 4 of the script output is clean — every worst-junk probe matched
an unrelated backend fixture (`freertos task priority inversion mutex` → *Blue-green deploys with
instant switchover*), which is the correct behaviour for junk, since there is nothing right for it
to match.

## What is left for #169

Directions 1 and 2 are now both closed, and `queryCoverage` with them. What remains is direction 3
— **accept it per-model** — with one amendment this probe supplies: accept it *per reader*. The pull
floor stays where it is and stays honest about what it cannot do; a precision-first constant serves
any future push path, where abstention is cheap and being wrong is not.
