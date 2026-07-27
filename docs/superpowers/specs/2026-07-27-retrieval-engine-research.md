# Retrieval engine: measured defects and improvement research

**Date:** 2026-07-27
**Status:** research. Nothing implemented.
**Question:** should we improve the search/query/store system, and if so, what specifically?

**Answer: yes — but the highest-value work is not "better ranking algorithms."** Three of the
top four findings are implementation defects that cost accuracy or performance for reasons
unrelated to ranking quality. Fix those before tuning anything.

---

## 1. What is actually wrong today

Every item below was read out of the current code or measured on this machine, not inferred
from general RAG advice.

### 1.1 Vector search is a full scan with an N+1 query per candidate

[`src/store/vector.ts:98-113`](../../../src/store/vector.ts#L98-L113) selects **every** row in
`knowledge_embeddings`, computes cosine in JavaScript, and then — inside the loop — calls
`getKnowledgeItem(row.knowledgeItemId)` **once per candidate**:

```ts
const rows = conditions.length > 0 ? await baseQuery.where(and(...conditions)) : await baseQuery;
for (const row of rows) {
  const vector = row.vector as number[];
  const score = cosineSimilarity(options.vector, vector);
  if (score <= 0) continue;
  const item = await getKnowledgeItem(row.knowledgeItemId);   // <-- N+1
```

Since cosine is positive for almost any pair of text embeddings, the `continue` rarely fires,
so this is close to **one database round-trip per stored atom, per query**. Status, category and
tag filters are applied *after* the fetch, so filtering cannot reduce the work either.

Cost is linear in store size. Measured p50 was 57 ms over 168 atoms and 76 ms over ~48 atoms; a
10,000-atom project scales that to seconds.

### 1.2 Vectors are stored as JSON text

[`src/store/schema.ts:133`](../../../src/store/schema.ts#L133) — `vector: text('vector', { mode: 'json' })`.
Every query JSON-parses N arrays of 384 floats and materialises them as boxed JS numbers. A
`Float32Array` BLOB is ~4 bytes/dim with no parse step, against roughly 8 bytes plus parser
overhead plus GC pressure today.

### 1.3 Cosine is computed the expensive way on already-normalised vectors

The embedder calls the pipeline with `normalize: true`
([`src/ai/embeddings.ts:88-89`](../../../src/ai/embeddings.ts#L88-L89)), so every stored vector
already has unit length. But [`cosineSimilarity`](../../../src/store/vector.ts#L27) recomputes
**both** magnitudes and a square root on every comparison, including recomputing the query
vector's magnitude once per row.

For unit vectors, cosine *is* the dot product. This is roughly a 3× reduction in float
operations for a one-line change, and it is exact — not an approximation.

### 1.4 The embedding model truncates at ~1,681 characters

Measured directly by embedding growing prefixes of a long document and comparing each vector
against the full document's:

| Prefix | Cosine vs full |
| --- | --- |
| 821 chars | 0.873242 |
| 1,681 chars | **1.000000** |
| 28,889 chars | 1.000000 |

Cosine of exactly 1.000000 for every longer prefix means text beyond ~1,681 characters (~256
tokens) is **invisible** to vector search, not merely down-weighted. Any atom longer than that
is indexed on its opening paragraph only. Long architecture notes and decision records with
reasoning are precisely the atoms this hits.

### 1.5 The "fusion" path does not fuse

[`src/store/agent-query.ts:134-192`](../../../src/store/agent-query.ts#L134-L192) computes a
proper RRF score for BM25 and vector hits — and then, when vector search is on, **throws it
away**:

```ts
const fallback = result.vectorScore === undefined && result.bm25Rank
  ? BM25_FALLBACK_WEIGHT / (RRF_K + result.bm25Rank) : 0;
rank = (result.vectorScore ?? 0) * VECTOR_PRIMARY_WEIGHT + fallback;
```

`fallback` is gated on `vectorScore === undefined`. So for any atom the vector search returned
at all, its BM25 rank contributes **nothing**. An atom ranked #1 by BM25 and #40 by vector is
scored purely on its weak cosine. Lexical evidence only survives for atoms vector missed
entirely.

That is a deliberate, documented choice — the README records that equal-weight fusion was
"diluting" vector's ranking and that going vector-first lifted suite MRR from 78.4% to 96.1%.
The finding here is narrower: the fix applied was to *discard* one signal rather than to
reweight it, and RRF specifically exists to combine rankings whose score scales are not
comparable. Worth re-testing as true RRF, or as a weighted blend of the two *ranks*.

### 1.6 The candidate pool is too small for a reranking stage

`candidateLimit = Math.max(limit * 3, 10)`. The MCP default limit is **3**
([`agent-query.ts:6`](../../../src/store/agent-query.ts#L6)), so a default agent query considers
**10 candidates** from each retriever. Reranking needs a wide pool to work with — typically
50–200 — and the pool width should be decoupled from the number of results returned.

### 1.7 There is no reranking stage at all

Retrieval goes straight from fused candidates to a hand-weighted linear score
(`rank + text + category + recency + confidence + freshness + exactIdentifier`). No
cross-encoder, no learned reranker.

### 1.8 The shipped embedding model is dated

`Xenova/all-MiniLM-L6-v2`: 23M parameters, 384 dimensions, ~256-token window, released 2022.
Current guidance describes it as "state of the art in 2022; in 2026 it is for prototyping a
pipeline or edge devices, **not production retrieval**".

### 1.9 The internal benchmark is saturated, so it cannot measure improvement

`knowl eval retrieval --vector` on the 500-case suite: **Recall@10 99.4%, Recall@3 98.9%,
MRR 96.1%**, 8 failures. Runs in 35 s.

This is a good regression guard and a bad improvement signal — there is 0.6% of Recall@10 left
to win. Any change that improves real-world retrieval will look like noise here. This matters
more than it sounds: **without a harder internal set, we cannot tell whether the work below
helped.**

---

## 2. What to do, in priority order

Ordered by (measured impact × confidence) ÷ effort.

### P0 — Performance, no accuracy risk

These are strictly-better changes with no ranking behaviour change, so they need only the
existing suite as a regression guard.

| Change | Why | Effort |
| --- | --- | --- |
| Batch the item fetch — one `WHERE id IN (...)` instead of N+1 | Removes ~N DB round-trips per query (§1.1) | S |
| Apply status/category/tag filters in SQL before scoring | Filters currently run after fetching everything (§1.1) | S |
| Store vectors as `Float32Array` BLOB | Removes N JSON parses per query (§1.2) | M — needs a migration + reindex |
| Dot product instead of full cosine | Vectors are already unit length (§1.3) | S |

Expect the bulk of the current query latency to disappear on any store above a few hundred
atoms. This is the cheapest, safest work available.

### P1 — Accuracy, high confidence

| Change | Why | Effort |
| --- | --- | --- |
| **Chunk long atoms into multiple vectors**, score atom = max over chunks | Directly fixes §1.4. Today a 10k-character decision is indexed on its first 1,681 characters | M |
| **Decouple candidate pool from result limit** (e.g. always 50–100 candidates) | Precondition for reranking; §1.6 | S |
| **Add a cross-encoder reranker** over the top ~50, e.g. `ms-marco-MiniLM-L-6-v2` or `bge-reranker-v2-m3` (both have ONNX builds usable from `@huggingface/transformers`, already a dependency) | The standard highest-leverage accuracy lever in retrieval, and it targets precision at rank 1 — Knowl's weakest measured metric | M–L |

The reranking case is about *where* the errors sit. Retrieval that reliably puts the right atom
somewhere in the top ten but not reliably at rank one is a precision problem, not a recall
problem, and a cross-encoder is the standard fix for exactly that shape. Cost is latency: a
cross-encoder scores every query–document pair, so 50 candidates means 50 forward passes. It has
to be optional, and measured on a set with enough headroom to show the difference — see §2 P3.

### P2 — Accuracy, needs measurement before committing

| Change | Why | Risk |
| --- | --- | --- |
| Upgrade to `bge-small-en-v1.5` (33M params, 512-token window, ONNX for transformers.js) | Better retrieval quality *and* doubles the input window, halving the §1.4 truncation problem | Changes embedding identity → full reindex. The schema already filters on `provider`/`model`, so coexistence during migration is feasible |
| Use real RRF (or rank-weighted blend) in the vector path | §1.5 — BM25's ranking is currently discarded | The current design was chosen *because* naive equal-weight fusion measurably hurt. Must be measured, not assumed |
| `sqlite-vec` for the scan | C implementation, avoids JS scan and JSON entirely | Still brute force — no ANN yet. `vectorlite` has ANN (3–100× faster, lower recall) if scale ever demands it |

### P3 — Prerequisite for all of the above

**Build a harder internal evaluation set.** Without it, §2's P1 and P2 are unfalsifiable. The
current suite cannot move. Options: mine the 8 existing failures and 15 stale hits into a
focused hard set; generate adversarial near-duplicate atoms; or hold out a labelled slice of
real project memory.

This is listed last by dependency, not by importance — it should probably be done **first**.

---

## 3. What I would not do

- **Rewrite the ranking formula.** The linear score with hand-tuned boosts is unglamorous but
  it is not the measured bottleneck, and it encodes governance behaviour (freshness, status,
  rejected filtering) that is Knowl's actual differentiator.
- **Add an ANN index yet.** ANN trades recall for speed at scale. Knowl's stores are per-repo
  and the scan is slow for fixable reasons (§1.1–1.3), not because brute force is inherently
  too slow at this size. Fix the constant factors first; revisit if stores reach ~100k atoms.
- **Query expansion / HyDE in the core.** It needs an LLM, and deterministic-with-no-API-keys is
  a deliberate product property. If wanted, it belongs on the client side, where Knowl already
  delegates extraction.

---

## 4. Honest caveats

- §1.5 (fusion) and §2's model upgrade are **hypotheses backed by literature, not measurements
  on this codebase.** The existing vector-first design beat naive fusion once already.
- Latency figures come from small stores (48 and 168 atoms). The linear-scaling argument follows
  from reading the code, but the large-store numbers are projected, not measured.
- CLI-perceived speed is dominated by ~1.1 s of Node process startup, so P0 will be most visible
  over MCP (long-lived process) and on large stores, not on one-off CLI calls.

## Sources

- [sqlite-vec is brute-force only; ANN tracked but unreleased](https://github.com/asg017/sqlite-vec/issues/25) · [vectorlite ANN comparison](https://1yefuwang1.github.io/vectorlite/markdown/news.html)
- [Open-source embedding model guide 2026](https://www.bentoml.com/blog/a-guide-to-open-source-embedding-models) · [bge-small-en with ONNX/Transformers.js](https://huggingface.co/Supabase/bge-small-en)
- [cross-encoder/ms-marco-MiniLM-L6-v2](https://huggingface.co/cross-encoder/ms-marco-MiniLM-L6-v2) · [bge-reranker-v2-m3 ONNX](https://huggingface.co/mogolloni/bge-reranker-v2-m3-onnx) · [reranking guide 2026](https://localaimaster.com/blog/reranking-cross-encoders-guide)

Retrieved 2026-07-27.
