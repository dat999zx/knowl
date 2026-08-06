# Embedding model and dtype — 2026-08-04

The shipped profile is `Snowflake/snowflake-arctic-embed-m-v2.0`, dtype `q8`, CLS pooling,
768 dimensions, query prefix `query: `. It arrived in `b3886ca` on a 42-query set, scoring
MRR 0.734 against 0.493 for `granite-small-en-r2`, and has not been re-examined since — and
that comparison contained no dtype arm, no dimensionality arm, and no prefix arm. This pass
asks four things:

1. Is `q8` costing accuracy that `fp32` would recover?
2. Does Matryoshka truncation to 256 or 512 dimensions cost measurable recall?
3. Has anything better shipped since?
4. Is the query prefix actually applied?

**Verdict: keep `arctic-embed-m-v2 / q8 / cls / 768 / "query: "` unchanged.** Nothing in the
registry beats it inside the constraints, `fp32` buys 0.6% MRR for 2–4× the cost, and truncation
buys nothing this store needs. The two things worth changing turned out not to be the model:
the query prefix — worth more than any model or dtype decision here — had **no test at all**,
and the bake-off script had been **leaving the shipped default out of its own comparison**. Both
are fixed here.

The pass also found the reason a model change is more expensive than it looks: it silently
re-points `MIN_VECTOR_RELEVANCE`, and under either challenger the abstention floor stops
abstaining on anything (§8).

Two claim classes are kept apart throughout. **[MEASURED]** means it was run on this machine
against our own assets and the numbers are reproducible from the scripts named. **[EXTERNAL]**
means it is a claim about the outside world, and is only as good as the enumeration behind it.

---

## 1. Enumeration — what exists

[EXTERNAL] "Is there something better now" is a *what exists* question, so it was answered from
the Hugging Face API rather than from search or recall, in both sort orders.

`~/.claude/skills/research-station/scripts/enumerate-hf-models.mjs` was run first and its
recency leg turned out to be inert, in two ways that cancel the whole point of having one:

- `lastModified` is not returned by `/api/models` unless requested via `expand[]`, so every row
  it printed carried `?` for the date and the "sorted by recency" output was sorted by nothing.
- The verification step — the `?blobs=true` call that decides whether a model is a candidate at
  all — ran over `candidates.slice(0, 70)` **after sorting by downloads**. Anything
  recent-but-not-yet-popular was cut before it was ever checked. That is the exact bias the
  recency leg exists to remove.

It was re-run corrected, and the corrected version is committed as
**`scripts/research/enumerate-embedding-models.mjs`** so the next pass starts from a working
instrument: 16 search terms and 8 authors, each in both orders, and the verified slice is the
**union of the top 110 by downloads and the top 110 by last-modified**.

> The upstream copy at `~/.claude/skills/research-station/scripts/enumerate-hf-models.mjs` still
> has both defects. It is outside this repo and was not edited here.

| | count |
| --- | --- |
| ONNX models seen across 48 API queries | **1,545** |
| plausible text-embedding candidates after keep/exclude | **701** |
| verified against the file list (`?blobs=true`) | **220** (110 popular + 110 recent) |
| loadable at q8 by transformers.js | **69** |
| …and q8 weights ≤ 600 MB | **65** |
| …and carrying an `mteb` tag rather than being a re-upload | **28** |

**The two legs were completely disjoint** — zero ids appeared in both top-110 slices. That is
the enumeration argument in one number: a popularity ranking and a recency ranking of the same
registry had nothing in common, so either one alone sees half the picture.

### The gate that actually disqualifies

"Has ONNX weights" is not the constraint. transformers.js resolves `dtype` to a *filename
suffix* under `onnx/`: `q8 → model_quantized.onnx`, `fp32 → model.onnx`, `q4 → model_q4.onnx`.
A repo that ships `model_quint8_avx2.onnx` (granite-311m-multilingual-r2, bekko) or puts the
graph at the repo root (Octen) has ONNX weights and still cannot be loaded by us at q8. That
filter removes 151 of the 220 verified candidates.

### What the recency leg found: nothing, and that is a result

Of the 110 ids that only the recency ordering surfaced, **17** were loadable-and-fitting,
**0** had more than 10,000 downloads, and **2** carried an `mteb` tag — one a Turkish-language
fine-tune (`ytu-ce-cosmos/modernbert-tr-embed`) and one a Red Hat re-export of a Snowflake model
we already know (`RedHatAI/snowflake-arctic-embed-m-long`). The rest were personal fine-tunes and
re-uploads.

The newest *substantive* base models are all visible from the popularity leg:
`jinaai/jina-embeddings-v5-text-nano-retrieval` (2026-04-15),
`nomic-ai/nomic-embed-text-v1.5` (2026-04-07),
`onnx-community/embeddinggemma-300m-ONNX` (2025-09-04),
`Snowflake/snowflake-arctic-embed-l-v2.0` (2025-07-28).

This is the honest opposite of the failure this method exists to prevent, and it is only
knowable *because* the recency leg was run. Reporting "nothing new" without enumerating would
have been the same sentence backed by nothing.

### Disqualified by constraint, before measuring

| candidate | why |
| --- | --- |
| `Qwen3-Embedding-0.6B` (all ONNX re-uploads) | q8 weights 598–1,227 MB, 2–4× the current 311 MB budget |
| `cstr/Octen-Embedding-0.6B-ONNX` | graph at repo root, not `onnx/`; transformers.js cannot resolve it |
| `ibm-granite/granite-embedding-311m-multilingual-r2` | ships `model_quint8_avx2.onnx`, no `model_quantized.onnx`; fp32 is 1,247 MB |
| `hotchpotch/bekko-embedding-v1-*` | non-standard ONNX filenames, no loadable q8 |
| `minishlab/potion-retrieval-32M` | model2vec `StaticModel`, not a transformers.js feature-extraction pipeline |
| `jinaai/jina-embeddings-v5-text-small-retrieval` | fp32-only ONNX (no quantised export) |

---

## 2. Method

[MEASURED] Everything below was produced by **`scripts/research/embed-probe.mjs`** (committed
with this pass), which copies the shipped path exactly: the same text composition as
`buildKnowledgeEmbeddingText`
(`title \n content [\n Reasoning: …] [\n Tags: …]`), the same pooling, `normalize: true`, and
**one text per forward pass** — the `maxBatch: 1` the knowledge path asks for, so batch
composition cannot confound a dtype comparison.

**Scored pure-semantic, deliberately.** `knowl eval retrieval --vector` measures the shipped
ranker, which is `0.8 × cosine + 0.2 × lexical`. `alpha-sweep.md` measured the lexical half
scoring MRR 0.95 *on its own*, so an end-to-end number compresses every model difference into
whatever BM25 could not already find. Removing the lexical half makes the embedder the only
variable. This inflates the apparent stakes of the model choice relative to what a user sees —
which is the conservative direction for a decision to *keep* the incumbent.

**Every pooling and prefix comes from that model's own card or config, fetched this session.**
Using a model wrong manufactures a loss and would have quietly justified the incumbent.
For arctic, `config_sentence_transformers.json` declares `"prompts": {"query": "query: "}` and
`1_Pooling/config.json` declares `pooling_mode_cls_token: true` — which is exactly what
`VECTOR_PRESETS['arctic-embed-m-v2']` and `QUERY_PREFIXES` already say.

**Instrument resolution is quoted with every table**, because most of the gaps here are one or
two cases wide. `semantic-suite.json` has 110 cases, so one case is 0.0091 of any recall figure;
`retrieval-suite.json` has 500, so one case is 0.0020.

Models were run **one process at a time, never concurrently**. Timings from the accuracy runs
are not used — see §6.

No live database or real model cache was touched. The weights were copied to `.tmp/models` and
the store to `.tmp/dbcopy/`.

---

## 3. The model comparison

[MEASURED] `docs/evals/semantic-suite.json` — 110 cases, 50 fixtures, tiered.
**One case = 0.0091.**

| candidate | dims | MRR | R@3 | R@10 | basic | moderate | extreme | weights MB | peak RSS MB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jina-v5-nano-retrieval q8 [last-pool] | 768 | 0.9032 | 0.9364 | 1.0000 | 0.9896 | 0.8185 | 0.5455 | 236 | 421 |
| embeddinggemma-300m q8 | 768 | 0.9032 | 0.9636 | 0.9909 | 0.9861 | 0.7584 | 0.7158 | 295 | 1602 |
| arctic-m-v2 **fp32** | 768 | 0.8995 | 0.9545 | 1.0000 | 1.0000 | 0.7562 | 0.5934 | 1169 | 1610 |
| arctic-m-v2 q4 | 768 | 0.8956 | 0.9545 | 0.9909 | 1.0000 | 0.7526 | 0.5631 | 805 | 1217 |
| **arctic-m-v2 q8 (INCUMBENT)** | 768 | **0.8873** | **0.9455** | **0.9818** | 1.0000 | 0.7310 | 0.5328 | **297** | **776** |
| arctic-l-v2 q8 | 1024 | 0.8845 | 0.9182 | 0.9909 | 1.0000 | 0.7100 | 0.5567 | 543 | 959 |
| modernbert-embed-large q8 | 1024 | 0.8787 | 0.9273 | 1.0000 | 0.9861 | 0.7152 | 0.5768 | 379 | 575 |
| mxbai-embed-large-v1 q8 | 1024 | 0.8751 | 0.9273 | 0.9909 | 0.9826 | 0.7198 | 0.5530 | 321 | 466 |
| gte-modernbert-base q8 | 768 | 0.8671 | 0.9182 | 0.9727 | 0.9861 | 0.6666 | 0.5801 | 143 | 327 |
| nomic modernbert-embed q8 | 768 | 0.8553 | 0.8909 | 0.9909 | 0.9931 | 0.6450 | 0.4702 | 143 | 341 |
| granite-small-en-r2 q8 *(the previous default)* | 384 | 0.8496 | 0.9091 | 0.9727 | 0.9804 | 0.6198 | 0.5567 | 50 | 183 |
| arctic-m-v2 q8 **NO QUERY PREFIX** | 768 | 0.8462 | 0.9000 | 0.9909 | 0.9769 | 0.5992 | 0.5975 | 297 | 778 |

Four candidates sit above the incumbent. Two of them are the same model at a more expensive
dtype. The other two are rejected on cost, not on quality:

- **jina-v5-nano-retrieval** ties for top MRR — at **1,205 ms per query and 1,635 ms per
  document**, 14× and 36× the incumbent. It also needs **last-token pooling**, which the model
  card states plainly and which `VectorPooling` (`'mean' | 'cls'`) cannot express; the numbers
  above were produced by pooling by hand in the probe, and **nothing in the product can make
  these vectors today**. Two independent disqualifications.
- **embeddinggemma-300m** leads MRR by 0.0159 — **1.7 cases in 110**, under two units of the
  instrument — at **591 ms per query** (7×), **869 ms per document** (7×), and **1,602 MB
  resident** (2.1×) against a machine that knowl has already measured as having ~2.8 GB free.
  It also needs a *document* prefix (`title: none | text: `), which the provider has no concept
  of, so its numbers here are not reachable without new code either.

Nothing else in the registry, at any size that fits, reaches the incumbent.

---

## 4. Question 1 — is q8 costing us accuracy?

[MEASURED] Yes, a little, and much less than it costs to recover.

| suite | cases | q8 MRR | fp32 MRR | Δ | in cases |
| --- | --- | --- | --- | --- | --- |
| semantic-suite | 110 | 0.8873 | 0.8995 | +0.0122 | +1.3 |
| retrieval-suite | 500 | 0.9637 | 0.9701 | +0.0064 | +3.2 |

Recall barely moves at all: R@3 0.9920 → 0.9927 and R@10 1.0000 → 1.0000 on the 500-case suite.
The gain is a *reordering* effect inside a result set that already contains the answer.

The cost of collecting it, on the same runs:

| | q8 | fp32 | ratio |
| --- | --- | --- | --- |
| weights on disk | 297 MB | 1,169 MB | 3.9× |
| peak resident | 746 MB | 1,595 MB | 2.1× |
| query p50 (interleaved, §6) | see §6 | see §6 | see §6 |

`fp16` and `q4` were tested too, and neither is an option:

- **fp16 does not load at all.** `onnxruntime-node` throws on the CPU execution provider.
  Reproduced twice. [MEASURED]
- **q4 is bigger and slower than q8 for this model** — 805 MB on disk against 297 MB, because
  the embedding table is not quantised — and scores between them. It is dominated on every axis.

---

## 5. Question 2 — Matryoshka truncation

[EXTERNAL] Arctic's model card is specific: *"like our v1.5 model, the MRL for this model is
**256 dimensions**"*, and it quotes 768→256 costing 1.81% NDCG@10 on BEIR(15). 384 and 512 are
not trained targets; they were measured anyway to see whether arbitrary truncation behaves.

[MEASURED] Truncation costs about one case, in both directions, at every width tested:

| dtype | 768 (native) | 512 | 384 | 256 | 128 |
| --- | --- | --- | --- | --- | --- |
| q8 MRR | 0.8873 | 0.8772 | 0.8731 | **0.8899** | 0.8772 |
| fp32 MRR | 0.8995 | 0.8912 | 0.8902 | 0.8887 | 0.8933 |

On 110 cases the whole column spans 1.6 cases and 256 is *better* than native under q8 — which
is noise, not a finding. The instrument cannot resolve this, and that is the answer: **there is
no recall argument for truncating, in either direction.**

Which leaves only the storage argument, and it does not survive contact with the numbers. A
768-dim float32 vector is 3,072 bytes; the real store measured here holds **514 knowledge
vectors, 1,579,008 bytes total — 1.5 MB.** Truncating to 256 would save 1.0 MB. The same store's
transcript vectors are already int8-quantised at 768 bytes each. There is no scan-cost problem
to solve at this size, and `r/engine` has separately concluded the exact scan is fine to ~25,000
atoms.

**Not adopted.** Truncation trades a measurable-nothing for a 1 MB saving and a permanent
migration.

---

## 6. Latency, measured properly

The accuracy sweep measured `arctic q8` twice under identical settings, ten minutes apart, and
got **84.0 ms and 21.0 ms** per query. Same model, same dtype, same machine. Any table quoting
one figure per candidate from a sequential run is reporting machine load.

[MEASURED] The latency harness therefore runs every candidate **round-robin**, reversing the
order on alternate rounds, one child process per (candidate, round), and reports the median
across rounds with the spread. Like `alpha-sweep.md`'s sweep harness it was temporary and is
not committed; it is ~60 lines driving `embed-probe.mjs`'s pipeline setup over a fixed set of
24 queries and 24 documents.

Median across 3 rounds, 24 real queries and 24 documents per round, warm graph, weights already
on disk. `spread` is the lowest and highest per-round p50 for that candidate — it is the honest
error bar on every millisecond figure on this page.

| candidate | query p50 | spread across rounds | query p95 | doc p50 | pipeline build | resident |
| --- | --- | --- | --- | --- | --- | --- |
| granite-small-en-r2 q8 | 8.4 ms | 8–17 | 54.8 ms | 14.7 ms | 867 ms | 171 MB |
| gte-modernbert-base q8 | 39.2 ms | 39–41 | 73.0 ms | 75.5 ms | 2,491 ms | 312 MB |
| arctic-m-v2 q4 | 106.7 ms | 77–226 | 232.2 ms | 259.7 ms | 11,112 ms | 1,199 MB |
| **arctic-m-v2 q8 (INCUMBENT)** | **108.6 ms** | 82–179 | **183.5 ms** | **191.9 ms** | 7,609 ms | **709 MB** |
| arctic-l-v2 q8 | 120.8 ms | 118–135 | 210.3 ms | 299.5 ms | 7,664 ms | 962 MB |
| arctic-m-v2 fp32 | 236.8 ms | 179–270 | 409.7 ms | 393.1 ms | 12,339 ms | 1,461 MB |
| embeddinggemma-300m q8 | 782.7 ms | 601–1,440 | 1,294.6 ms | 961.3 ms | 5,654 ms | 1,446 MB |

**fp32 costs 2.18× per query and 2.05× per document** against q8, for 2.06× the resident memory
and 3.9× the disk. A sibling lane recorded 3.0× for the query cost; this run says 2.18×, and the
spread column is why those are not in conflict — the incumbent's own p50 moved between 82 ms and
179 ms across three rounds of the same measurement. Both numbers say the same thing at the
precision that matters: fp32 is worth roughly twice to three times a query, for 0.6% MRR.

`q4` is the clearest reject on the page: it matches q8's query latency, is **1.35× slower per
document**, uses 1.7× the memory and 2.7× the disk (805 MB — the embedding table is not
quantised), and lands between q8 and fp32 on accuracy. Dominated on every axis simultaneously.

---

## 7. Question 4 — is the query prefix applied?

[MEASURED] **Yes, correctly, on every path** — and it is worth more than any model or dtype
decision on this page.

`queryPrefixFor` maps `/arctic-embed-\w*-v2/i → 'query: '`, `createLocalEmbeddingProvider`
applies it in `embedQuery` and *not* in `embed`, and all five query call sites go through
`embedQuery`: `cli/query-command.ts`, `mcp/tools.ts`, `store/context-composer.ts`,
`transcripts/search.ts`, and `cli/program.ts`'s eval command. Documents are never prefixed,
which matches arctic's card — it declares a query prompt and no document prompt.

What it is worth, changing nothing else:

| suite | with prefix | without | Δ MRR | Δ R@3 |
| --- | --- | --- | --- | --- |
| semantic-suite (110) | 0.8873 | 0.8462 | **+0.0411** | +0.0455 |
| retrieval-suite (500) | 0.9637 | 0.9508 | **+0.0129** | +0.0120 |

On the tiered suite the loss concentrates exactly where vector search earns its place — the
`moderate` tier, MRR 0.7310 → 0.5992. **The prefix is worth 3.4× what fp32 buys on the same
suite, and 2.0× on the 500-case suite, and it is free.**

### It had no test

All twelve `embedQuery` implementations the suite had were stubs returning fixed vectors. The
one line that applies the prefix had no coverage at all: deleting it left all 1,725 tests green
while handing back a larger regression than switching models could have caused.

There is a second reason it needed pinning rather than watching. **Dropping the prefix makes the
cosines look better.** Mean gold cosine on `semantic-suite.json` goes *up* — 0.4487 with the
prefix to 0.4915 without — while MRR goes down. Any monitor built on "are the similarity scores
healthy" would have read the regression as an improvement.

`tests/ai/embeddings.test.ts` now pins it — the query is prefixed, the document is not, an
unknown model gets nothing invented for it, a config override wins, and each family maps to the
string its own card documents. Verified to fail when the prefix is removed from
`embedQuery` before being committed.

---

## 8. What a change would have cost — the migration nobody priced

[MEASURED] Changing the model **or** the dtype changes `fingerprintProfile`, and both stores
purge on it: `purgeEmbeddingsNotMatching` for knowledge, and
`DELETE FROM transcript_vectors WHERE fingerprint <> ?` for the archive. Measured on a copy of
the largest real store on this machine (DuckPrep-server):

| | rows | bytes |
| --- | --- | --- |
| `knowledge_embeddings` | 514 (of 516 items) | 1.5 MB |
| `transcript_vectors` | 21,950 (of 22,837 indexed messages) | 16.9 MB |

Re-embedding both, at the rates measured on that store's own content with the shipped batch
plan (`maxBatch: 1` for knowledge, the default plan for transcripts):

| | per item | full rebuild |
| --- | --- | --- |
| knowledge atoms | 825 ms | 7.1 min |
| transcript messages | 486 ms | 178 min |
| **total** | | **≈ 3.1 hours** |

**That is a floor, not an estimate.** The 240 sampled messages have p50 122 and mean 335
characters against the archive's real p50 169 and mean 832 — the sample is shorter than the
population, so the true rebuild is longer. Knowledge is 4% of it; the archive is the whole cost,
and it is the thing a user does not know they signed up for when they change a preset.

So the price of any row in §3 that is not the incumbent is: three hours of local CPU, per repo,
plus everything below.

### The cost nobody would have seen coming

A model swap does not only invalidate vectors — it **silently re-points `MIN_VECTOR_RELEVANCE`
and the calibrated `score`**. That constant is an *absolute cosine*
(`src/store/agent-query.ts:145`), chosen in `floor-sweep.md` because on the real store junk
topped out at 0.2678 and real answers started at 0.3137. That band is a property of the corpus
*under a particular embedder*, not of the corpus.

[MEASURED] Top cosine per query, 110 on-topic queries against 10 deliberately off-topic ones
(sourdough, the capital of Peru, bicycle tyres…), same fixtures, same method as `floor-sweep.md`:

| model | off-topic band | on-topic band | junk answered at floor 0.30 | answers labelled weak |
| --- | --- | --- | --- | --- |
| **arctic-m-v2 q8 (incumbent)** | 0.0563–0.1927 | 0.1638–0.7336 | **0 / 10** | 24 / 110 |
| gte-modernbert-base q8 | 0.3669–0.4764 | 0.5248–0.8718 | **10 / 10** | 0 / 110 |
| embeddinggemma-300m q8 | 0.3512–0.4925 | 0.5007–0.8270 | **10 / 10** | 0 / 110 |

**Both challengers put their entire off-topic band above the floor.** Adopting either would
leave `MIN_VECTOR_RELEVANCE = 0.30` in place, passing its own unit tests, while the abstention
verdict it exists to produce silently became "yes" for every query ever asked — including
`what is the capital of Peru`. Nothing would fail. `knowl_query` would simply stop ever saying
it does not know.

The same applies to K-35's calibrated `score`, which reads the same scale: on arctic a 0.50
cosine is a strong hit; on gte-modernbert it is below the weakest real answer.

So the true price of a model change is not "re-embed" — it is **re-embed, then re-run
`floor-sweep.md` and re-derive the constant, then re-calibrate `score`**. That is the second
thing this pass was able to weigh only because it measured it, and it is worth more against
switching than any accuracy number on this page.

---

## 9. Adversarial review

Points against this conclusion, and what survives.

**"The suites are synthetic; a model ranked on Northwind fixtures is not ranked on real
memory."** The strongest objection, and `floor-sweep.md` already showed the two corpora have
different cosine distributions. Addressed in §10 by re-running the decisive comparison on a real
store with real recovered queries — which found something the suites could not have shown, and
which still points the same way.

**"§10 shows q8 disagrees with fp32 on 23% of real top-1s. That is an argument FOR fp32."** It
would be, if fp32 were the relevance oracle. It is not — it is the unquantised graph, so it is
the oracle for *what this model computes*, not for *what is relevant*. The relevance arbiters
here are the labelled suites, and they price the same disagreement at +0.0064 MRR and +0.0007
Recall@3. Both facts are reported precisely because either alone misleads.

**"The real-corpus run used 150 atoms, not the whole store."** True — fp32 costs ~8 s/atom and
the full 482 active atoms in both dtypes would not fit the session. A 150-atom pool makes
top-10 agreement easier to achieve than the real 482-atom pool would, so the measured 0%
top-10-order agreement is if anything an *under*-statement of the churn. The direction of the
bias is known and runs against the conclusion drawn from it.

**"Pure-semantic scoring exaggerates the model's importance."** It does, and deliberately: the
shipped ranker mixes in a lexical half that scores MRR 0.95 alone, so under fusion every gap
here shrinks. That bias runs *against* switching, so it cannot have manufactured the
keep-verdict.

**"embeddinggemma won and was rejected on cost."** True, and the win was 1.7 cases on a
110-case instrument — under two resolution units. Its 500-case run could not be completed (the
parent process was killed twice around this 1.6 GB model), so the accuracy claim for it rests on
the small suite alone. It does not matter to the decision: at 7× query latency, 2.1× resident
memory, and a document prefix the provider cannot express, it would be rejected at any MRR in
that range. Recorded as unresolved rather than resolved in our favour.

**"The extreme tier shows a real gap."** embeddinggemma 0.7158 vs 0.5328 looks large, but the
tier has **11 cases** — the gap is two of them. Not a finding.

**"You only enumerated 220 of 701 plausible candidates."** True. The 481 unverified are the ones
outside both the top-110-by-downloads and the top-110-by-recency slices — models that are
neither used nor new. A better one could hide there; the residual risk is accepted and named.

**"q4 and fp16 were dismissed quickly."** fp16 does not load, which is not a judgement call. q4
is larger, slower and no more accurate than q8 — dominated on every axis, so no weighting of
those axes changes the ranking.

---

## 10. The decisive comparison, on the real corpus

[MEASURED] Every suite in `docs/evals` is synthetic. This is the same q8-vs-fp32 question asked
on real data: **150 active atoms from a copy of the DuckPrep store**, and **150 real
`knowl_query` strings** — recovered from 1,763 local transcript files, 885 distinct, median 43
characters, i.e. queries that were actually run against this memory. Both dtypes embed the same
atoms and the same queries with `maxBatch: 1`, so dtype is the only variable. fp32 is the
reference, being the unquantised graph.

| | |
| --- | --- |
| stored-vector self-cosine, q8 vs fp32 | min 0.9332, p05 0.9458, **p50 0.9616**, max 0.9871 |
| top-1 result identical | **115/150 (76.7%)** |
| top-3 set identical | 65/150 (43.3%) |
| top-10 set identical | 15/150 (10.0%) |
| top-10 order identical | **0/150 (0.0%)** |
| mean rank of fp32's top result, under q8 | **0.34** |

**q8 is not reproducing fp32's ranking, at all.** Not one of 150 real queries returned the same
top ten in the same order, and nearly a quarter returned a different single best atom. The
stored vectors sit a median 0.038 cosine away from the unquantised ones — the same order as the
batch-composition perturbation K-71 measured at up to 5.4e-2, which the codebase already went to
some trouble to eliminate.

And it does not matter, because of the last row. **fp32's best answer sits at mean rank 0.34
under q8** — when q8 disagrees about which atom is best, the one fp32 preferred is almost always
still sitting immediately below it, inside every `limit` a caller uses. The churn is lateral: it
reshuffles items that are all correct, which is exactly what the labelled suites report from the
other direction as +0.0064 MRR and +0.0007 Recall@3.

That is the whole answer to question 1, and it needed both halves. The suites alone would say
"q8 is 0.6% worse" and understate how much it moves; this alone would say "q8 disagrees with the
truth on 23% of real queries" and sound alarming. Together: **q8 perturbs the order a great deal
and the relevance almost not at all**, and paying 2.2× per query and 3.9× the disk to remove a
perturbation that costs 0.0007 Recall@3 is not a trade worth a three-hour migration.

---

## 11. Decision

**Keep `arctic-embed-m-v2 / q8 / cls / 768 / "query: "`.** No vector is invalidated and no
re-embed is required.

The reasoning, in order of weight:

1. **A model change silently disarms the abstention floor.** Both challengers score every
   off-topic query above `MIN_VECTOR_RELEVANCE = 0.30` (§8). That is not a migration cost that
   can be paid once — it is a correctness constant that has to be re-derived, with nothing
   failing if it is not.
2. **Nothing better exists inside the constraints.** 1,545 models enumerated in both orders,
   220 verified, 69 loadable at q8; the two candidates that outscore the incumbent do so by
   under two cases on a 110-case instrument, and are rejected on 7×–14× query latency and on
   pooling/prefix machinery the provider does not have.
3. **fp32 buys 0.6% MRR for 2.2× per query, 2.1× the memory and 3.9× the disk.** It moves
   Recall@3 by 0.0007. On the real corpus it reshuffles constantly and improves almost nothing
   (§10).
4. **Truncation buys nothing measurable** and would save 1.0 MB on the largest real store.
5. **Any of the above costs a ≥3-hour re-embed per repo**, almost entirely transcript vectors.
6. **The prefix, which is free and already applied, is worth 2–3× what any of the above buys** —
   so the highest-value change available was to stop it from being silently deletable.

### Shipped with this pass

- `tests/ai/embeddings.test.ts` — the query-prefix guard described in §7. Proved failing when
  the prefix is removed.
- `scripts/benchmark-embedding-models.mjs` — `ALL_PRESETS` was missing `arctic-embed-m-v2`,
  so `npm run bench:embeddings` compared four alternatives to each other and **left the shipped
  default out of its own bake-off**. Fixed.
- `tests/core/vector-profile.test.ts` — that list carried a comment saying it was "kept in step
  with PRESET_IDS", which is how it drifted. It is now a test. Proved failing when a preset is
  removed from the script.

### What was not measured

- **The 481 candidates outside both top-110 slices.** Named in §9.
- **embeddinggemma on the 500-case suite** — the run was killed twice; §9. Its 110-case number
  stands alone and is treated as unresolved.
- **The shipped fused ranker.** Everything here is pure-semantic. `knowl eval retrieval
  --vector` would give the end-to-end figure, and `scripts/benchmark-embedding-models.mjs` can
  now produce it for every preset including arctic — but the fusion compresses these gaps rather
  than opening them, so it cannot reverse a verdict that already says "keep".
- **Multilingual retrieval.** Every suite here is English. arctic-m-v2 and embeddinggemma are
  both multilingual; the real store contains Vietnamese queries (visible in the recovered query
  set) that no labelled asset covers.
- **Long-document behaviour.** Everything is clipped at `MAX_EMBED_TOKENS = 2,560`, which clips
  0 of 470 real atoms, so the 8k-context advantage of several candidates was never exercised.
- **A separate defect, noted not fixed:** `embedQuery` does not pass its text through
  `clipToTokenBudget`, so a pathological query is not bounded the way a document is. Out of
  scope for this pass.
