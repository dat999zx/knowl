# Retrieval improvement pass — 2026-08-04

Not a defect hunt. The question was **what technique beyond the shipped hybrid would measurably
improve answer quality**, routed as an L3 two-angle pass: an ADVICE fan over papers and vendor
engineering, a TAPE sweep of 26 shipping systems read at source, and a community leg for failure
modes. TAPE wins conflicts.

Two claim classes are kept apart throughout. **[M]** is measured by running this system —
reproducible, and a test fails when it is reverted. **[W]** is a claim about the outside world,
only as good as its enumeration, and carries its source.

**Result: the shipped vector-path ranking survived every challenger. The change that won was in
the half nobody had measured** — MMR on the lexical-only fallback, which was costing up to 11.8
points of Recall@10 and is replaced by a near-duplicate demotion.

---

## 1. The instrument, and its resolution

Every number below comes from one harness: `selectCandidates` runs **once per case**, and each
variant re-scores the identical candidate set. Fixtures are seeded exactly as `knowl eval
retrieval` seeds them, embedder `Snowflake/snowflake-arctic-embed-m-v2.0` q8 CLS — the shipped
preset — one forward pass per item. Scratch stores under the worktree with `KNOWL_HOME`
redirected; the real store was never opened.

### Control [M] — the shipped configuration, vector path

| suite | fixtures | cases | Recall@3 | Recall@10 | MRR | nDCG |
| --- | --- | --- | --- | --- | --- | --- |
| `semantic-suite.json` | 50 | 110 | 0.93636 | 0.97273 | 0.86540 | 0.89219 |
| `retrieval-suite.json` | 168 | 500 | 0.99400 | 1.00000 | 0.97300 | 0.97931 |
| `retrieval-suite-v2.json` | 434 | 1,649 | 0.99205 | 0.99727 | 0.98321 | 0.98679 |

**Only one of these suites can measure anything.** [M] The two lexical suites sit at MRR 0.973
and 0.983 with Recall@10 at 1.000 and 0.997 — 1.7 and 2.7 points of headroom, most of a point of
which is a single case. `semantic-suite.json` has 13.5 points, and per tier it is narrower still:

| tier | n | MRR | headroom |
| --- | --- | --- | --- |
| basic | 72 | **1.0000** | none |
| moderate | 27 | 0.6790 | 0.25 (Recall@10 0.9259) |
| extreme | 11 | 0.4419 | 0.47 (Recall@10 0.9091) |

So the entire measurable question lives in **38 cases**, and any candidate technique has to move
those. A margin under ~0.009 MRR on the 110-case suite is one case and is below the instrument's
resolution; on the 1,649-case suite the same unit is 0.0006.

Latency baseline [M]: `embedQuery` p50 17.1–37.8 ms depending on suite; the whole scoring stage
p50 0.08–0.30 ms. **Scoring is 0.5% of a query.** Anything added is added on top of the 21 ms
embed, not amortised into it.

---

## 2. Angles

**ADVICE fan** — 8 sub-angles: cross-encoder gain vs first-stage strength; CPU-runnable reranker
enumeration (HF API, both sort orders, `siblings` file lists checked for `onnx/`); fusion
normalisation theory; LLM-free query expansion; late interaction storage; learned sparse; MMR at
small k; and "what is the biggest lever not on the list".

**TAPE sweep** — 26 specimens read in source, not marketing: agent-memory stores (openclaw
memory, basic-memory, mem0, graphiti/Zep, Letta, cognee, mcp-memory-service, the Anthropic
memory tool), local-note search (khoj, obsidian-smart-connections, Reor), code indexes
(Continue, Cline, Cody, Zed, aider), and engines (Weaviate, txtai, LlamaIndex, LangChain,
Haystack, LanceDB, Qdrant, Typesense, Vespa, sqlite-vec, vectra).

**Community leg** — GitHub issues and code search, HN, arXiv negative results. This is the only
leg that produced failure modes, and it produced the one that would have cost a day (§4.1).

### The cross-cut

The systems closest to our shape — a few hundred short, self-authored items, queried by an agent
— share four things the majority does not [W]:

1. **They fuse normalized scores, never ranks.** openclaw `0.7·vector + 0.3·text`; basic-memory
   `max(v,f) + 0.3·min(v,f)`; mem0 `(semantic + bm25 + boost)/max_possible`. Not one uses RRF.
   The RRF camp is entirely the *engine* tier — LanceDB (k=60), Qdrant, Haystack (k=61),
   Typesense, the sqlite-vec recipe — which cannot assume its two score distributions are
   comparable across somebody else's corpus. txtai encodes the rule explicitly: convex
   combination when BM25 scores are normalized, **RRF only as the un-normalizable fallback**
   ([hybrid.py](https://github.com/neuml/txtai/blob/master/src/python/txtai/embeddings/search/hybrid.py)).
2. **They over-fetch by a small integer and gate on raw similarity.** openclaw
   `candidateMultiplier: 4` + `minScore 0.35`; mem0 `max(limit*4, 60)` + threshold;
   basic-memory fanout 4 + `semantic_min_similarity 0.55`; graphiti `DEFAULT_MIN_SCORE 0.6`.
3. **They ship no reranker on.** The single exception, graphiti, defaults to
   `OpenAIRerankerClient` — a network call.
4. **No LLM in the query path.**

knowl already matches all four: convex combination at alpha 0.8, `max(3·limit, 10)` per lane, a
raw-cosine floor at 0.30, no reranker, no generation. **The one place it is the outlier is
diversity** — and that is where the win turned out to be.

Two removals are worth more than any endorsement [W]:

- **basic-memory deleted RRF**, five months ago, at our shape.
  [#577](https://github.com/basicmachines-co/basic-memory/issues/577): *"The RRF formula averages
  strong vector scores with weak FTS scores, resulting in useless combined relevance"* — a query
  scoring 65.4% vector-only collapsed to 3% after fusion. Replaced with `max(v,f) + 0.3·min(v,f)`
  in v0.19.0.
- **Weaviate moved its default off RRF** in 1.24 (`rankedFusion` → `relativeScoreFusion`, ~6%
  recall) because *"relativeScoreFusion retains more information from the original searches"*.
  Its server default alpha is **0.75**; openclaw's is **0.70**. Our 0.8 sits inside the band the
  field converged on independently.

---

## 3. What was killed, and on which precondition

Every candidate was put through the same check: name the **mechanism**, name the **precondition**
that mechanism needs, confirm the precondition exists in a ~500-atom hand-written store queried
by an agent with 2–6 keywords at k=3. Most of these techniques come from web-scale document RAG.

| technique | mechanism | precondition | verdict |
| --- | --- | --- | --- |
| Cross-encoder rerank | full query–document attention fixes ordering a bi-encoder got wrong | a first stage with high recall and **bad top-of-list precision**, in a domain the reranker was trained on | **KILLED by measurement**, §4 |
| Deeper candidate pool | fusion cannot rank what was never retrieved | relevant atoms falling **outside** `max(3·limit, 10)` | **KILLED by measurement**, §5 |
| Alternative fusion forms | a better-shaped combination of the two lanes | the current form losing information the alternative keeps | **KILLED by measurement**, §6 |
| HyDE | a generated pseudo-document closes the query/document asymmetry | **an LLM at query time** | KILLED. `hasAiConfigured()` is false by default and the product is deterministic-first; the query path has no generator and adding one would make retrieval non-reproducible |
| RM3 / Rocchio lexical PRF | feedback terms bridge vocabulary mismatch | **long queries**, a large corpus, and a high-purity top-k | KILLED. Queries are 2–6 keywords — the regime where PRF is *documented to collapse*: [arXiv 2108.11044](https://arxiv.org/pdf/2108.11044) reports RM3 hurting 47 queries to help 139 at R@1000, and on tip-of-the-tongue queries all three PRF variants underperformed BM25 [W]. At k=3 from 500 atoms one bad atom poisons the expansion |
| doc2query / docTTTTTquery | index-time expansion writes the *questions a document answers* into it | vocabulary mismatch **plus a generator**, at write time | KILLED for this pass, not on principle: it needs the same generator HyDE does. It is the only expansion technique whose cost lands at `knowl_store` rather than at query time, and Doc2Query-- reports ~⅓ of naive expansions are net harmful [W] ([arXiv 2301.03266](https://arxiv.org/pdf/2301.03266)) — so it would need its own pass |
| ColBERT / late interaction | per-token MaxSim recovers term signal a single vector averages away | **long documents** one vector cannot summarise, and a runtime that can do MaxSim | KILLED — but **not on storage**, which was the stated worry. 500 atoms × ~300 tokens binarised at 12 bytes/token is **1.8 MB** [W]; the cost is irrelevant at our scale. It dies on the runtime: `lightonai/answerai-colbert-small-v1` has **no ONNX build on the hub** (verified against the repo file list) and MaxSim over 150k vectors would be hand-written JS. Short dense atoms are also the case single-vector handles best |
| SPLADE / learned sparse | learned term weights and expansion in an inverted index | vocabulary mismatch at scale, plus tolerance for query-side inference | KILLED. `naver/splade-v3` has **no ONNX build**; query-side inference would double the 21 ms budget. The doc-only variant is mechanically the best fit — OpenSearch reports +12.7% NDCG@10 over BM25 with **queries merely tokenised** [W] — and **neither of its encoders has an ONNX build either** |
| BM42 | attention weights as term importance | — | KILLED by the vendor. Qdrant's own errata: *"BM42 does not outperform BM25 implementation of other vendors… consider BM42 as an experimental approach"* [W] ([qdrant.tech/articles/bm42](https://qdrant.tech/articles/bm42/)) |
| MMR diversification | stops near-duplicates crowding out a second distinct fact | **multi-document answers and/or genuine near-duplicates**, and a human scanning a list | **REPLACED**, §7. The precondition is half-present: duplicates are real, the human is not |

---

## 4. Cross-encoder reranking — killed by measurement, on our own corpus

### 4.1 It runs, but only one way [M]

The obvious API does not work, and the community leg found out why before we wrote it [W]:
`pipeline('text-classification', <reranker>)` takes **no `text_pair`** (GitHub code search across
transformers.js finds `text_pair` in `tokenization_utils.js`, `question-answering.js`,
`zero-shot-classification.js` and tests — *not* in `text-classification.js*`), so query and
document are never jointly encoded; and it applies `softmax` unless `problem_type` is
`multi_label_classification`, which for a one-logit reranker head is **identically 1.0 for every
document**. No error is thrown. Four reranker `config.json` files were checked and all four have
`id2label: {"0": "LABEL_0"}` and no `problem_type`.

The supported path is `AutoTokenizer` + `AutoModelForSequenceClassification` with
`{ text_pair: documents, padding: true, truncation: true }`, which is what this pass used.

### 4.2 What CPU rerankers cost here [M]

`@huggingface/transformers` 4.2.0, `onnxruntime-node`, Windows, this machine. 30 pairs of short
text, warm, best of three:

| model | params | dtype | pipeline build | 30 pairs | 1 pair | RSS |
| --- | --- | --- | --- | --- | --- | --- |
| `Xenova/ms-marco-MiniLM-L-6-v2` | 22.7M | q8 | 3,113 ms | 157–236 ms | 2.9–7.4 ms | 210 MB |
| `jinaai/jina-reranker-v1-tiny-en` | 33.0M | q8 | 2,373 ms | 237–317 ms | 2.7–2.9 ms | 330 MB |
| `jinaai/jina-reranker-v1-turbo-en` | 37.8M | q8 | 4,930 ms | 286–343 ms | 4.6–7.5 ms | 363 MB |
| `mixedbread-ai/mxbai-rerank-xsmall-v1` | 70.8M | q8 | 10,159 ms | 833–1,340 ms | 18.5–73.2 ms | 578 MB |

On **real atoms** at the real pool depth (p50 10 pairs, atoms are longer than the toy text so the
padded sequence is longer), per-query rerank cost p50: **82.9 ms** (MiniLM q8), 160.1 ms (MiniLM
fp32), 97.3 ms (jina-tiny), 119.4 ms (jina-turbo), **594 ms** (`Xenova/bge-reranker-base`, 278M).

Against a 21 ms query embed and a 0.3 ms scoring stage, the cheapest usable reranker is **a 4×
query-latency increase**, and a second resident ONNX session costs 210–578 MB of RSS in a process
that already holds a 768-dim embedder.

### 4.3 And it makes the answers worse [M]

Five model/dtype configurations × six fusion forms × two suites. The cross-encoder was run once
per (model, case) and cached; every fusion form re-orders the same logits.

`semantic-suite.json` — control **MRR 0.86540**, Recall@3 **0.93636**:

| model | ce-pure | minmax β0.3 | minmax β0.5 | minmax β0.7 | sigmoid β0.5 | RRF |
| --- | --- | --- | --- | --- | --- | --- |
| ms-marco-MiniLM-L-6-v2 q8 | 0.81653 | 0.83694 | 0.82390 | 0.82178 | 0.86540 | 0.84636 |
| ms-marco-MiniLM-L-6-v2 fp32 | 0.81291 | 0.83603 | 0.81935 | 0.81732 | 0.86540 | 0.84335 |
| jina-reranker-v1-tiny-en q8 | 0.81131 | 0.83064 | 0.81813 | 0.81259 | 0.86130 | 0.84190 |
| jina-reranker-v1-turbo-en q8 | 0.81579 | 0.83701 | 0.82667 | 0.82004 | 0.86040 | 0.84857 |
| bge-reranker-base q8 | 0.83479 | 0.84958 | 0.83787 | 0.83636 | 0.86465 | 0.85533 |

**Thirty variants. Not one above control.** The best, 0.86540, is the two `sigmoid β0.5` rows
that are *numerically identical to control* — the MS MARCO logits saturate the sigmoid so hard
that the blend never reorders anything. The best row that actually reranks is 0.85533, a full
point below. Recall@3 falls from 0.93636 to as low as 0.81818.

`retrieval-suite.json` — control **MRR 0.97300** — repeats it: best 0.97173 (again the inert
sigmoid blend), best genuinely-reranked 0.96990, worst 0.94038.

The damage is concentrated exactly where the headroom was [M]: on `semantic-suite`, ce-pure takes
the **moderate** tier from 0.6790 to 0.5062 and **extreme** from 0.4419 to 0.3773.

**Why, mechanically.** [M] The cross-encoder is not blind — it separates the classes cleanly in
aggregate (MiniLM logits: gold p50 **+5.85**, non-gold p50 **−11.37**). It is simply a *worse
ranker than the control on this corpus*, and its errors are catastrophic rather than marginal:
gold logits reach **−11.45**, i.e. a true answer scored as maximally irrelevant, on the same
absolute scale where a decoy reaches +3.24. Every published precondition for reranking is
inverted here [W]: short documents, keyword queries out-of-distribution for MS MARCO's
natural-language web training ([arXiv 2504.08231](https://arxiv.org/abs/2504.08231) reports
Recall@5 down 40.41% for less-formal queries), a pool of 10 where the payoff is documented at
50–100, and a first stage already at MRR 0.87–0.98. Elastic's own depth study finds **7.1% of
dataset/model pairs where reranking consistently hurts and 20.2% where it decays past a peak**
[W]. And the one published benchmark on our exact shape — vstash, a local-first SQLite hybrid
retriever for agents on a **786-chunk** corpus — reports off-the-shelf cross-encoders *"degraded
NDCG by −0.3% to −3.1% while adding 560–2100 ms latency"* [W]
([arXiv:2604.15484](https://arxiv.org/abs/2604.15484)).

Our measurement is the same sign and larger.

---

## 5. Candidate-pool depth — killed by measurement

The one lever both research legs pointed at: *no fusion function can rank what the candidate
stage never emitted*, and at the product's default `limit: 3` each lane is asked for only 10 rows
out of ~500. No suite exercises that path — every suite case declares `limit: 10`.

Swept independently of the answer size [M]. `goldInPool` is the fraction of cases whose gold
answer is anywhere in the candidate set, and it is the ceiling on everything downstream:

| suite | rows asked per lane | pool p50 | goldInPool | Recall@3 (k=3) | select p50 |
| --- | --- | --- | --- | --- | --- |
| retrieval-suite | **10 (shipped)** | 18 | 1.0000 | 0.99400 | 6.29 ms |
| retrieval-suite | 100 | 102 | 1.0000 | 0.99400 | 19.14 ms |
| retrieval-suite-v2 | **10 (shipped)** | 18 | 0.9994 | 0.99106 | 11.74 ms |
| retrieval-suite-v2 | 30 | 42 | 1.0000 | 0.99205 | 48.67 ms |
| retrieval-suite-v2 | 1000 | 405 | 1.0000 | 0.99205 | 61.38 ms |

**The precondition does not exist.** At the shipped depth the gold answer is already in the pool
for 99.94% of 1,649 cases. Retrieving the *entire corpus* buys 1.6 cases in 1,649 (+0.001
Recall@3) and costs 5.2× the candidate-read latency — 11.74 ms → 61.38 ms, which on its own
exceeds the query embed. On `semantic-suite` deepening the pool was **negative** at k=3 (MRR
0.85909 at the shipped depth against 0.85758 at every depth above it).

This is the finding the guidance inverts on: *"if a document is not in the top-100 candidates, no
reranker can recover it"* is sound advice for a corpus of millions [W]. In a 500-atom store,
`max(3·limit, 10)` already reaches almost everything worth reaching.

---

## 6. Fusion — the shipped form confirmed, on the suite the sweep had skipped

`docs/evals/alpha-sweep.md` swept alpha over `retrieval-suite` and `retrieval-suite-v2` — the two
suites that are saturated — and **never over `semantic-suite`**, the one with headroom. That gap
is closed here. The harness was proved first: convex combination at `FUSION_ALPHA` through the
variant machinery reproduces the shipped ranker on **0 of 110 and 0 of 500 cases differing** [M].

`semantic-suite.json` [M]:

| variant | Recall@3 | Recall@10 | MRR | basic | moderate | extreme |
| --- | --- | --- | --- | --- | --- | --- |
| convex α=0.0 | 0.87273 | 0.96364 | 0.82776 | 0.9931 | 0.6053 | 0.2919 |
| convex α=0.7 | 0.92727 | 0.97273 | 0.86040 | 1.0000 | 0.6698 | 0.4146 |
| **convex α=0.8 (shipped)** | 0.93636 | 0.97273 | 0.86540 | 1.0000 | 0.6790 | 0.4419 |
| convex α=0.9 | 0.94545 | 0.98182 | 0.87616 | 1.0000 | 0.7130 | 0.4662 |
| convex α=1.0 | 0.94545 | 0.98182 | **0.88586** | 1.0000 | 0.7253 | 0.5328 |
| `max(s,l) + 0.3·min(s,l)` (basic-memory) | 0.91818 | 0.97273 | 0.85110 | 1.0000 | 0.6565 | 0.3540 |
| `max(s,l) + 0.5·min(s,l)` | 0.90000 | 0.97273 | 0.84466 | 1.0000 | 0.6349 | 0.3427 |
| per-query adaptive α (lane discrimination) | 0.90909 | 0.97273 | 0.85193 | 1.0000 | 0.6411 | 0.4003 |

Three things settle here.

**The specimen form loses.** basic-memory's `max + 0.3·min` — adopted at our shape after they
deleted RRF — scores 0.85110 against our 0.86540. TAPE wins conflicts about *what people ship*;
it does not win a measurement on our own corpus, and this is the case where the two part company.

**Adaptive alpha loses.** The vstash result that motivated it (+21.4% NDCG on ArguAna from
per-query weighting [W]) did not reproduce: bounded to [0.6, 0.95] on within-set lane
discrimination it lands at 0.85193, below the fixed 0.8. Bruch et al.'s finding that **a fixed
α = 0.8 is near-oracle in-domain** [W] ([arXiv:2210.11934](https://arxiv.org/abs/2210.11934))
matches our corpus better than the adaptive claim does.

**α = 1.0 wins this suite and must not be adopted.** It is +0.020 MRR here and **−0.024 on
retrieval-suite-v2** (0.95039 against 0.97489, `alpha-sweep.md`). The two suites disagree because
`semantic-suite`'s extreme tier is *constructed* to be anti-lexical — zero content-word overlap
with the target plus a lexical decoy — so it rewards ignoring the lexical lane by design. Tuning
alpha on it would be fitting the instrument. **α = 0.8 stays**, now confirmed on three suites
instead of two.

Bruch's Lemma 4.2 also kills the whole normalisation question up front [W]: min-max and z-score
convex combinations are **rank-equivalent under a re-tuned α**, so swapping normalisers is
provably a no-op unless α is frozen. The only non-equivalent variant, TM2C2 (theoretical rather
than running bounds), needs a theoretical maximum — which cosine has and BM25 does not.

---

## 7. The change: near-duplicate demotion replaces MMR

### The path nobody had measured

MMR runs **only when there is no query vector** (`scoreCandidates`, `usingVector: false`). That
is not a museum path. `src/cli/query-command.ts`, `src/mcp/tools.ts` and
`src/store/context-composer.ts` all catch an unavailable embedder and *degrade to lexical
ranking rather than failing the query* — and the composer goes further, declining to load a model
that is not already on disk (`if (!present) return undefined`). **Every context-composer call in
a repo whose weights have not been fetched yet takes this path**, which is the session-bootstrap
surface. No entry in `docs/evals/` had ever scored it.

### What MMR was doing [M]

| suite | metric | MMR λ=0.5 (shipped) | no penalty |
| --- | --- | --- | --- |
| semantic-suite | Recall@3 | 0.80909 | **0.87273** |
| semantic-suite | Recall@10 | 0.84545 | **0.96364** |
| semantic-suite | MRR | 0.79276 | **0.82776** |
| retrieval-suite | Recall@3 | 0.93867 | **0.96267** |
| retrieval-suite | Recall@10 | 0.97933 | **0.99400** |
| retrieval-suite | MRR | 0.91495 | **0.92497** |
| retrieval-suite-v2 | Recall@3 | 0.96227 | **0.97316** |
| retrieval-suite-v2 | Recall@10 | 0.98483 | **0.99575** |
| retrieval-suite-v2 | MRR | 0.95297 | **0.95675** |

Every metric of every suite. Recall@10 on the paraphrase suite by **11.8 points**.

**The mechanism, and why the previous fix could not have found it.** λ was raised 0.2 → 0.5
because at 0.2 "a legitimate second answer was reproducibly dropped" — the right diagnosis of the
wrong object. The formula is `λ·score − (1−λ)·overlap`, and the two terms are not commensurate
merely by both living in [0,1]: past rank one a lexical score is a *small fraction of the corpus
best*, while token-Jaccard overlap between two notes on one subject is routinely 0.3–0.5. So half
of 0.08 loses to half of 0.4, and the second slot goes to whatever has least in common with the
answer. Raising λ to 0.5 shrank the effect; it did not remove it, because **the sign is wrong**.
On a topical query the second-best answer *necessarily* shares vocabulary with the best one, and
that overlap is evidence of relevance rather than a cost. Carbonell and Goldstein's trade is for
a human scanning a list of web documents; our consumer is an agent that reads all k snippets, and
k is 3 — at λ=0.5 the diversity term is deciding two of the three slots.

This is corroborated where you would expect [W]. LangChain
[#39052](https://github.com/langchain-ai/langchain/issues/39052) traces MMR at low λ answering
*"What is LangChain?"* with the Eiffel Tower and the stock market. The Dartboard paper
([arXiv:2407.12101](https://arxiv.org/abs/2407.12101)) measures diversity's payoff at **0.000
NDCG on simple queries** and +0.095 only on multi-hop ones. And TAPE found the one same-shape
system that ships MMR at all keeps it **off by default at λ=0.7**, added for a problem we do not
have — one 854 KB transcript's 125 chunks taking 41% of top-3 slots. One atom is one unit here.

### What MMR was actually buying, kept

One invariant: two byte-identical atoms must not both occupy a two-result page
(`tests/store/store.test.ts`). That is a **duplicate rule**, and it is now one — a demotion at
token overlap ≥ 0.9, on both paths.

**0.9 is a duplicate detector, not a diversity dial.** Two atoms sharing 90% of their combined
vocabulary are one note written twice, which is why the constant does not have to be right the
way λ did. Swept [M]:

| threshold | retrieval-suite lexical R@3 | v2 lexical R@10 | v2 **vector** R@10 |
| --- | --- | --- | --- |
| 0.5 | 0.96067 | 0.98361 | 0.98626 |
| 0.6 | 0.96667 | 0.98881 | 0.98979 |
| 0.7 | 0.96467 | 0.99161 | 0.99257 |
| 0.8 | 0.96267 | 0.99333 | 0.99454 |
| **0.9** | 0.96267 | **0.99575** | **0.99697** |
| none | 0.96267 | 0.99606 | 0.99727 |

0.6 looks marginally best on one suite's lexical path (+2 cases in 500) and is the **worst**
choice on the vector path, costing v2 Recall@10 0.99727 → 0.98979 by demoting the *legitimately*
similar — v2 is 434 generated service atoms, the adversarial case for a duplicate guard, and
exactly the risk the old comment warned about. At 0.9 the guard is indistinguishable from no
guard on every metric of every suite (worst delta 0.0003) while still catching byte-identical
copies. It buys the invariant at measured-zero cost.

**It demotes; it never deletes.** A dropped duplicate would shorten the page, and a short page
cannot be told apart from a store that knows nothing more — the same error the relevance floor
stopped making. A duplicate still fills the last slot when nothing else can.

**It runs on both paths.** MMR ran only on the lexical one, which meant the duplicate invariant
held *only for a store with no embedder*; every store with a working model took the vector path,
where nothing de-duplicated at all. That asymmetry is a defect, not a design. Measured cost of
closing it [M]: `retrieval-suite-v2` Recall@3 0.99205 → 0.99174 and Recall@10 0.99727 → 0.99697
(half a case in 1,649), MRR unchanged; `semantic-suite` and `retrieval-suite` unchanged to five
decimals. Scoring stays at p50 0.08–0.30 ms — token sets are built lazily and the scan stops as
soon as `limit` non-duplicates are held, so the ordinary limit-3 query tokenises three items.

### After [M]

| suite | path | Recall@3 | Recall@10 | MRR |
| --- | --- | --- | --- | --- |
| semantic-suite | lexical | 0.80909 → **0.87273** | 0.84545 → **0.96364** | 0.79276 → **0.82776** |
| semantic-suite | vector | 0.93636 (unchanged) | 0.97273 (unchanged) | 0.86540 (unchanged) |
| retrieval-suite | lexical | 0.93867 → **0.96267** | 0.97933 → **0.99400** | 0.91495 → **0.92497** |
| retrieval-suite | vector | 0.99400 (unchanged) | 1.00000 (unchanged) | 0.97300 (unchanged) |
| retrieval-suite-v2 | lexical | 0.96227 → **0.97316** | 0.98483 → **0.99575** | 0.95297 → **0.95675** |
| retrieval-suite-v2 | vector | 0.99205 → 0.99174 | 0.99727 → 0.99697 | 0.98321 (unchanged) |

### Confirmed on two benchmarks that share no data with the suites [M]

**`npm run benchmark:accuracy`** — `coding-memory-v1`, 200 questions × 3 runs, 100 multi-session
histories, five fictional projects. Its knowl adapter runs `vectors=disabled`, so it scores
**exactly the path this change touches**, on a dataset built by a different generator for a
different purpose:

| metric | before | after |
| --- | --- | --- |
| strict accuracy | 0.730 | **0.746** |
| Recall@5 | 0.710 | **0.748** |
| MRR | 0.705 | **0.715** |
| nDCG@5 | 0.622 | **0.654** |
| applicable coverage | 0.925 | 0.925 |
| temporal accuracy | 0.850 | 0.850 |
| stale-result rate | 0.002 | 0.002 |
| abstention accuracy | 0.360 | 0.360 |

+3.8 points of Recall@5 and +3.2 of nDCG@5, with governance metrics untouched — an independent
instrument agreeing with §7 in both sign and rough size. (Both runs are `-dirty` and therefore
non-publishable by the benchmark's own rules; they are a controlled before/after on one machine,
which is what they are used for here.)

**`npm run bench:cr`** — MemoryAgentBench Conflict Resolution, `factconsolidation_sh_6k`, the
vector path: **top-1 accuracy 96.0%**, matching the recorded 2.8.0 result exactly, with stale
leaks 3 → 2 and 0 empty results (p50 28 ms / p95 43 ms on a loaded machine against the recorded
19/21 ms). The change does not touch what that benchmark measures, and it did not.

Running it at all required a one-line repair, reported here as a found defect:
`benchmarks/memoryagentbench/runner.ts` built its `vector` option with `provider` and `model` —
fields the ranker never reads — and **without `profileFingerprint`**, which `RankOptions` has
required since the embedding-profile guard landed. Every invocation died on `undefined cannot be
passed as argument to the database`. Verified against `HEAD` with the pass stashed: it fails
there identically, so it predates this work, and it is why the newest recorded result in that
directory is 2.8.0.

### The cost, in full

The two v2 vector cells are the whole measured cost of running the guard on the path that ships:
half a case each, on the suite built out of 434 deliberately-similar generated service atoms.
Forbidden hits on that suite fell 147 → 145 in the same run, and the lexical path's rose 119 →
142 — the latter being the price of no longer suppressing near-neighbours, paid back many times
over by the 1.1-point Recall@10 recovery.

---

## 8. Adversarial review

**"The win is on a path nobody takes."** The strongest objection, and the reason §7 opens by
tracing the callers rather than asserting. Three production entry points degrade to it
deliberately, and the context composer *refuses* to fetch a model, so a fresh repo composes every
session-bootstrap pack on this path. It is the first-run path, not the never path.

**"Thirty rerank variants is still one corpus."** Two corpora and five model/dtype configurations,
in the same direction, with the tier breakdown showing the loss where the headroom is — plus a
published negative on the nearest-shaped corpus in the literature [W]. The residual risk is a
much larger reranker, and `bge-reranker-base` at 594 ms per query already answers that: the
models that might win are the ones that cannot fit the latency budget.

**"0.9 is another magic constant."** It is, but of a different kind. λ had to be *correct* — being
wrong reordered real answers, monotonically, on every query. 0.9 is measurably inert on all three
suites; being wrong costs a demotion that only bites when the page is already full of better
candidates, and never a deletion.

**"You extended the guard to the vector path where it measured slightly worse."** True and
recorded: half a case in 1,649 on the suite most hostile to it, in exchange for the duplicate
invariant holding on the path that actually ships. Recorded as a deliberate trade rather than a
free win.

**"α=1.0 beat the shipped alpha on the suite with the headroom and you did not take it."** Also
true. It loses 0.024 MRR on the 1,649-case suite, and the suite it wins is built to reward
ignoring the lexical lane. Adopting it would be tuning on the instrument.

---

## 9. What could not be measured

- **Duplicate frequency in real stores.** The guard's benefit is not in any suite, because none
  of the three contains a byte-identical pair — the whole reason `store.test.ts` had to construct
  one. The cost is measured; the benefit is argued from the invariant.
- **Cold-start under the agent's real duty cycle.** Rerank latency was measured warm. Queries
  arrive sparsely, and one report of a comparable runtime recompiling its graph after 3 s idle
  (37 ms warm → 2,677 ms) [W] suggests warm numbers flatter a reranker here. It would have made
  the kill more emphatic, not less, so it was not chased.
- **`cross-repo-suite.json`** is three cases — below the resolution of every comparison in this
  document — and was not used for any verdict.
- **doc2query at write time** is the one killed candidate whose precondition might exist once a
  generator is in the write path. It belongs to its own pass, with Doc2Query--'s filter.
- **`bench:cr` embeds its questions with `embedder.embed([question])`, not `embedQuery`**, so it
  skips the `query: ` prefix arctic is trained for. Left alone deliberately: changing it would
  have made the 96.0% incomparable to the recorded baseline this pass needed it to be compared
  against. It is a real observation about that harness and worth its own fix.
- **The Reddit seam** (r/LocalLLaMA, r/Rag) returned nothing from this host; the community leg is
  GitHub, HN and arXiv only. Treat the absence of Reddit citations as a coverage gap rather than
  as evidence.
