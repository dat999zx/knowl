# Fusion alpha sweep — 2026-08-04

The retrieval-scoring redesign (audit findings K-28/29/30/35/70) replaced reciprocal-rank
fusion plus additive boosts with a convex combination plus bounded multiplicative priors:

```
relevance = alpha * cosine + (1 - alpha) * lexical      both in [0,1]
score     = relevance * prior                           prior in [~0.80, 1]
```

The research pass proposed `alpha ≈ 0.7` and flagged, correctly, that the number had **no
source** and had to be measured. This is that measurement.

## Method

- Both shipped suites, scored end to end: `docs/evals/retrieval-suite.json` (168 fixtures,
  500 cases) and `docs/evals/retrieval-suite-v2.json` (434 fixtures, 1,649 cases).
- Embedder: `Snowflake/snowflake-arctic-embed-m-v2.0`, dtype `q8`, CLS pooling — the shipped
  preset, not the smaller default.
- Each query is embedded once and `selectCandidates` runs once; **alpha is the only variable**,
  applied by re-running `scoreCandidates` over the identical candidate set. Differences between
  rows are therefore attributable to alpha and nothing else.
- Scratch store under the worktree, `KNOWL_HOME` redirected by `vitest.config.ts`. No live
  database was read or written.

## Results

`lexical only` is `usingVector: false` — the path taken when no embedder is available. Alpha
does not apply to it; it is the regression baseline.

### 1,649-case suite

| alpha | Recall@3 | Recall@10 | MRR | forbidden | empty |
| --- | --- | --- | --- | --- | --- |
| lexical only | 0.9697 | 0.9885 | 0.95257 | 120 | 0 |
| 0.5 | 0.9891 | 0.9921 | 0.97177 | 146 | 12 |
| 0.6 | 0.9891 | 0.9921 | 0.97391 | 146 | 12 |
| 0.7 | 0.9891 | 0.9921 | **0.97533** | 147 | 12 |
| 0.8 | **0.9897** | 0.9921 | 0.97489 | 147 | 12 |
| 0.85 | **0.9897** | 0.9921 | 0.97374 | 147 | 12 |
| 0.9 | 0.9891 | 0.9921 | 0.97022 | 147 | 12 |
| 0.95 | 0.9873 | 0.9921 | 0.96398 | 146 | 12 |
| 1.0 | 0.9788 | 0.9903 | 0.95039 | 146 | 12 |

### 500-case suite

| alpha | Recall@3 | Recall@10 | MRR | forbidden | empty |
| --- | --- | --- | --- | --- | --- |
| lexical only | 0.9400 | 0.9800 | 0.91508 | 3 | 0 |
| 0.0 | 0.9580 | 0.9880 | 0.92072 | 5 | 4 |
| 0.3 | 0.9760 | 0.9920 | 0.94030 | 7 | 4 |
| 0.5 | 0.9800 | 0.9920 | 0.95337 | 8 | 4 |
| 0.6 | 0.9840 | 0.9920 | 0.95823 | 7 | 4 |
| 0.7 | 0.9840 | 0.9920 | 0.96257 | 6 | 4 |
| 0.8 | 0.9860 | 0.9920 | 0.96383 | 7 | 4 |
| 0.9 | **0.9900** | 0.9920 | **0.96650** | 7 | 4 |
| 1.0 | 0.9860 | 0.9920 | 0.96330 | 6 | 4 |

### Off-topic abstention

Six queries with no answer in the store (`how do I bake sourdough bread`, `what is the capital
of Peru`, …), 1,649-case fixture:

| alpha | answered (want 0) |
| --- | --- |
| 0.0 | 0/6 |
| 0.7 | 0/6 |
| 1.0 | 0/6 |

Unchanged across the whole range, which is the point: the relevance floor now judges the **raw
cosine before fusion**, so alpha cannot move the bar for answering at all. Under the previous
design the fusion weight and the floor traded against each other — the old comment in
`agent-query.ts` recorded a lexical weight of 8.0 breaking the floor on 1 of 6 — and that
coupling is gone.

## What the sweep settles

1. **The lexical half earns its weight.** alpha 1.0 (semantic only) is worse than every mixed
   value on the larger suite: MRR 0.95039 against 0.97533 at 0.7, and Recall@3 0.9788 against
   0.9891. This is a fusion, not a semantic ranker with a decoration.
2. **The optimum is interior and flat.** 0.7 takes MRR on the larger suite by 0.0004 over 0.8 —
   well under a single case in 1,649. 0.8 takes Recall@3 on both suites. 0.9 wins the smaller
   suite outright and falls off on the larger. Nothing in 0.6–0.9 is distinguishable from noise.
3. **0.8 is the most robust of them.** It is best or second on every metric of both suites,
   where 0.7 is fourth on the smaller and 0.9 is sixth on the larger.

Being inside a flat region, the tie is broken by an invariant the suites cannot express and
`tests/store/rank-knowledge.test.ts` does: *lexical agreement is a tie-breaker, not a veto* — an
item at the noise floor (cosine 0.30) must not beat a decisively better one (cosine 0.60) purely
by being the only lexical hit. That holds from 0.8 upward and fails at 0.7.

**Chosen: `FUSION_ALPHA = 0.8`.**

## Caveats

- Both suites are saturated on Recall@10 (0.992 from alpha 0.3 up), so that column carries no
  information about alpha. MRR and Recall@3 are the only columns doing work.
- `forbidden` counts rejected/stale fixtures appearing anywhere in the top 10. It rises when
  vectors are enabled at all (120 → 146 on the larger suite) and is then essentially flat across
  alpha, so it is a property of semantic recall rather than of the fusion weight. It is not what
  chose this number.
- `empty` counts queries the relevance floor abstained on. Constant across alpha, as designed.
- The sweep harness was temporary and is not in the repo; it seeded a scratch store from the
  suite JSON, embedded once, and re-scored. Re-deriving it is ~40 lines against
  `selectCandidates` and `scoreCandidates`, which take `alpha` as an explicit option.
