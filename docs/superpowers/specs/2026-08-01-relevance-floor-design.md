# A relevance floor for agent queries

Date: 2026-08-01
Status: approved for planning
Baseline commit: `7a9aee0` (v2.10.0)

## The problem

Knowl never says "I don't know". Asked `training a labrador puppy` against a 424-item store
about a memory system, it returns three confident results — `Learned skills can auto-run local
scripts` among them. Asked `who won the world cup in 1998`, it returns
`Competitor normalized adapter capability matrix`.

There is no threshold anywhere in retrieval. The only bound in `rankKnowledge` is
`scored.slice(0, limit)`; greps for `MINIMUM_RELEVANCE`, `MIN_SCORE`, `scoreThreshold`,
`RELEVANCE_FLOOR` and `SCORE_GAP` find nothing. Whatever is least-bad comes back.

Vector search is why. It is nearest-neighbour with no distance cutoff, so it always
contributes its closest N candidates however far away they actually are.

## The measurement

Twenty queries against the live store at `9e7135c`, split into on-topic, near-miss
(deliberately vague but legitimate — "how does caching work", "what happens on failure") and
off-topic. Top-result score per query:

| Class | Vector **on** | Vector **off** |
| --- | --- | --- |
| On-topic (n=8) | **0.407 – 0.614** | 0.149 – 0.232 |
| Near-miss (n=6) | **0.401 – 0.532** | 0.077 – 0.232 |
| Off-topic (n=6) | **0.170 – 0.223** | 0.052 – 0.231 |

**With vector on the classes separate cleanly.** Nothing falls between 0.223 and 0.401.
Near-miss queries sit with the on-topic group, which is the correct side — a vague but real
question should still answer.

**With vector off they do not separate at all.** Off-topic reaches 0.231 while on-topic starts
at 0.149. No threshold exists on that path.

### Two corrections this measurement went through

Both are recorded because each produced a confident wrong answer first.

1. An initial probe passed `queryEmbedding` as a top-level option, but `RankOptions.vector` is
   `{ enabled, embedding, provider, model }` — so `vector?.enabled && vector.embedding` was
   falsy and **vector search never ran**. The resulting numbers described the lexical path and
   led to the conclusion that no threshold could work. The re-run asserts the subsystem
   actually engaged by checking that some result carries a `vectorRank`, rather than trusting
   that passing something enabled it.
2. On that mistaken data a *gap filter* (drop anything below 70% of the top score) looked like
   the better option and was recommended. On the corrected data it is worse than useless:
   off-topic second-place ratios reach 0.69 while legitimate ones fall to 0.33, so the filter
   would trim good results and keep junk. Scores can also go slightly negative through
   freshness and provenance penalties, which makes a ratio ill-defined. **The design uses an
   absolute floor, not a ratio.**

## Design

### The rule

A module-level constant in `src/store/agent-query.ts`:

```ts
/** Below this a vector-backed result is noise. Measured 2026-08-01: on-topic and near-miss
 *  queries score 0.401-0.614, off-topic 0.170-0.223, and nothing lands in between. */
export const MIN_VECTOR_RELEVANCE = 0.30;
```

Applied in `scoreCandidates` after scoring and **before** the limit is taken, so the floor
removes results rather than merely reordering them. When every candidate is below the floor
the query returns an empty array. That is the feature, not an edge case.

0.30 sits with roughly 0.08 of margin above the worst junk and 0.10 below the weakest
legitimate query.

#### Correction during implementation: the floor judges the query, not each candidate

This section originally read as a per-candidate filter. Implemented that way it cost recall,
and the 500-case suite caught it: Recall@10 fell 0.994 → 0.987 and three cases regressed.

| Case | Query | Correct answer's score | That query's **top** score |
| --- | --- | --- | --- |
| `v-obs-1` | span export backend | 0.269 | 0.389 |
| `cfg-jwt-ttl-c` | jwt ttl configured value | 0.262 | 0.388 |
| `v-test-1` | which test runner | 0.233 | 0.373 |

All three are terse queries whose correct answer sits at rank 3–5. A weak result *underneath a
strong one* is the tail of a real answer, not junk.

No lower constant rescues it: those answers reach down to 0.233 while off-topic queries reach
0.223 — a 0.01 margin is not a threshold. The measurement above only ever supported a
**per-query** claim, because every figure in it is a *top-result* score. Applying it per
candidate asserted something that was never measured.

So the rule is: **if the best candidate vector could judge is below the floor, the query
returns empty; otherwise the ranking is untouched.** Restored to baseline exactly — Recall@10
0.9940, MRR 0.9609, nDCG 0.9689, the same 8 failing cases — while all 6 off-topic live queries
still return zero.

### Only candidates vector could have returned are judged

`vectorScore !== undefined` says vector *did* return an item; it does not say vector *could*
have. Two candidates arrive looking identical, both scoring about 0.034 on the BM25 fallback
with nothing in the fused score to separate them:

- **Embedded, not returned by vector** — ranked outside the top N, so semantically distant.
  Junk. Its BM25 rank carries no absolute relevance; measured off-topic hits like this match on
  stopwords alone ("best hiking trails in patagonia" → "Vector search is local and enabled by
  default").
- **Not embedded** — written since the last index, or while the embedding model was not cached.
  Invisible to vector, not distant. It must not be judged by a verdict reached without it.

`selectCandidates` resolves this with `findEmbeddedItemIds`, scoped to the provider and model
being searched because `searchKnowledgeEmbeddings` filters on both. This also subsumes the
outage guard below: on a store with no embeddings every candidate is unjudgeable and the floor
turns itself off.

### The floor applies only when vector genuinely contributed

This is the load-bearing half. On the lexical path the classes overlap completely, so a floor
there would return nothing for legitimate queries — an outage wearing a safety feature's
clothes.

The condition is **whether any candidate carries a `vectorRank`**, not whether a caller asked
for vector. Those differ whenever vector is requested but unavailable — no embedder, no
embeddings stored, a provider mismatch — and the difference is exactly what the mistaken probe
above got wrong. Deciding on the request would silently empty every result on a store with no
embeddings.

(Implemented as embedding *eligibility* instead — see the section above. Eligibility covers
this case and the semantically-distant one with a single predicate.)

### Blast radius

Five call sites reach `rankKnowledge`, and only those passing an embedding are affected:

| Caller | Passes an embedding | Floor applies |
| --- | --- | --- |
| `knowl_query` MCP tool (`src/mcp/tools.ts`) | yes | yes |
| `knowl query` CLI (`src/cli/query-command.ts`) | yes | yes |
| `knowl eval retrieval` (`src/index.ts`) | yes | yes |
| `knowl doctor` (`src/cli/doctor-report.ts`) | no — no query string at all | no |
| Context packs (`src/store/context-composer.ts`) | no | no |

The doctor check asks "can the store return anything", not a semantic question, so it is
unaffected without special-casing. Context packs are unaffected for the same reason. The two
agent-facing surfaces where junk actually costs something are exactly the two that get the
floor.

### The retrieval eval is the regression guard, run with two exact flags

`knowl eval retrieval` reports Recall@3/@10, MRR and nDCG. It is the only measurement that
would catch a floor silencing correct answers alongside junk, and **two details decide whether
it proves anything**:

```bash
node dist/index.js eval retrieval --dataset docs/evals/retrieval-suite.json --vector
```

- **`--dataset` is a required option with no default**, and two datasets exist:
  `docs/evals/retrieval-baseline.json` is a 10-case, 11-fixture smoke test;
  `docs/evals/retrieval-suite.json` is the real one at **500 cases over 168 fixtures**. Guard
  with the suite. An earlier draft of this spec conflated the two and would have sent an
  implementer to validate a 500-case claim against ten cases.
- **`--vector` is an explicit flag.** Without it the eval ranks on the lexical path, where the
  floor does not apply by design — so a run without it cannot detect this change at all, and
  a green result would be meaningless rather than reassuring.

**Run it before and after; any recall drop blocks the change.** Record both numbers in the
implementation report so the comparison is auditable rather than asserted.

## What could go wrong, stated plainly

- **0.30 comes from 20 hand-picked queries on one store.** It is a measured value, not a
  calibrated one. Near-miss queries scored 0.401 — real margin, but not enormous. An unusually
  phrased legitimate question could dip under and vanish.
- **Returning nothing is a larger behavioural change than returning junk.** It is the right
  change, and it is visible: an agent that previously always got three results will sometimes
  get none.
- **A store with no embeddings is unaffected**, by design. Those users keep today's behaviour,
  junk included, until the candidate-selection work lands.

## Out of scope

- **Why junk reaches the scorer at all.** Vector search admits its nearest N regardless of
  distance, and `src/store/agent-query.ts` has a fusion defect where `fallback` is gated on
  `result.vectorScore === undefined`, so an item BM25 ranked #1 contributes no lexical signal
  whenever vector also returned it. Both are follow-up work with the retrieval eval as the same
  guard.
- **Any threshold on the lexical path.** The measurement shows no separation there; a floor
  would be arbitrary.
- **Making the floor configurable.** One measured constant until there is evidence a second
  value is needed.

## Success criteria

1. `training a labrador puppy` and the other measured off-topic queries return **zero** results
   through the MCP query tool.
2. All eight on-topic and all six near-miss queries still return results.
3. `eval retrieval --dataset docs/evals/retrieval-suite.json --vector` shows no drop against
   the same command run before the change, with both figures recorded.
4. A store with vector disabled, or with no embeddings, returns exactly what it returns today —
   proven by a test that exercises the requested-but-unavailable case, not only the
   not-requested one.
5. `knowl doctor` still reports OK on a store with knowledge in it.
