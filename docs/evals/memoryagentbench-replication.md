# MemoryAgentBench: independent rebuild of the FactConsolidation adapter

Measured 2026-08-07. Companion to [`memoryagentbench-cr.md`](./memoryagentbench-cr.md) (the
in-repo retrieval harness) and [`memoryagentbench-feasibility.md`](./memoryagentbench-feasibility.md).

A contributor reported scoring Knowl inside MemoryAgentBench's own harness. This document records
a rebuild of that adapter written from the report's prose alone — no access to the contributor's
branch — so that agreement counts as replication rather than reuse.

---

## What replicated exactly

| | reported | this rebuild |
| --- | --- | --- |
| facts parsed @262k SH | 18,332 | **18,332** |
| fact length min / median / max | 19 / 51 / 114 | **19 / 51 / 114** |
| conflict groups | 6,890 covering 13,961 | **6,890 covering 13,961** |
| gold in top-10, supersession ON | 97/100 | **97/100** |
| gold in top-10, supersession **OFF** | **100/100** | **100/100** |

The last row carries the strongest claim in the whole exercise: with supersession off, the correct
fact reaches the reader **every single time**, and the reader still answers most questions wrong.
The failure being measured is arbitration, not retrieval. That number is now independently
confirmed.

## What did not replicate

**Single-hop top-1 with supersession OFF: 42% here against 70% reported.**

The likely cause is the embedding preset. With supersession off, both versions of a fact are
active and share a subject, so which one ranks first is close to a tie that the embedding breaks.
Prior work in this repo already recorded that supersession-at-write is not fully independent of
the preset (active counts moved 1537→1535 and 3019→3016 when the default changed on 2026-08-02).
The ON arm also differs, in the other direction (87% here, 81% reported), which is consistent with
a preset difference rather than a defect on either side.

This is **not settled**. The reported run's preset is unrecorded — `runner.ts` only began stamping
`embedding` in each result recently. Neither OFF top-1 figure should be published.

---

## The delivery-shape bug, and why the fix is not "split on the serial instead"

The raw HuggingFace instance **is** newline-delimited (456 newlines for 455 facts at 6k), so
`split('\n')` was correct for the in-repo harness and no in-repo figure needs retracting.

MemoryAgentBench does not deliver it that way. `chunk_text_into_sentences`
(`utils/eval_other_utils.py:200-224`) rebuilds every chunk as `" ".join(nltk.sent_tokenize(text))`,
so the newlines are gone by the time a method sees the text. Splitting on `'\n'` there yields one
fact holding the entire context, which silently disables supersession — a single atom has nothing
to supersede.

So the parser must be **invariant to delivery shape**, not switched from one shape to the other.
`parseFactLines` now splits on the running serial number and is verified to produce byte-identical
output across three shapes — newline-delimited, space-joined, and glued-at-seam — on all five
cached instances.

Two properties are easy to get wrong, and both fail silently:

- **The marker must not require whitespace around it.** At a chunk seam the separator is gone
  entirely, producing `America.1163.` or `290.Søren`. Whitespace does not identify a fact; the
  running count does.
- **The marker must not consume the whitespace that follows it.** Sentences legitimately end in
  numbers (`Channel 4.`). A false marker that eats the space before the real next serial leaves
  that serial unmatched, and a strict +1 chain can never resume — burying every later fact inside
  one atom.

`assertChainComplete` throws when the chain stops at N while `N+1.` is still present in the text
the last fact swallowed. It is a **white-box invariant**: a forward scan always finds a successor
that is textually present, so correct code cannot violate it from the outside. It is exported and
tested directly rather than through a fabricated context.

> Do **not** implement the guard by comparing chain length to a raw marker count. In-sentence
> numbers (years, `Channel 4`, `iOS 6`) inflate that count on a perfectly correct parse.

---

## Multi-hop: top-1 is the wrong metric, and 262k has a hard ceiling

granite-small-en-r2, top-k 10, vector+bm25:

| | 6k ON | 6k OFF | 262k ON | 262k OFF |
| --- | --- | --- | --- | --- |
| top-1 | **0%** | **0%** | 2% | 1% |
| any-rank (gold in top-10) | **50%** | 37% | **14%** | 12% |
| stale leaks | **0** | 29 | **0** | 1 |

top-1 is ~0% in every arm because a multi-hop answer is not contained in any single fact — the
question needs two facts combined, so a substring match against one retrieved atom can never
succeed. **Do not report top-1 for the multi-hop instances.**

**The 14% at 262k is a ceiling, not a score.** Only 14 questions in 100 have the gold anywhere in
the retrieved set, so a perfect reader scores at most 14%. That fully explains the 7-8% reader
result reported earlier: the reader was never the binding constraint — retrieval was.

Multi-hop retrieval collapses with corpus size in a way single-hop does not (any-rank 50% → 14%,
while single-hop holds at 97-100% over the same range). The reason is structural: a multi-hop
question names the *first* hop's subject, so a single query against the second hop's fact has
nothing lexical or semantic to match on. More facts means more competition for the same ten slots
with no extra signal.

**This reframes the gap to the published 27%.** No reader can exceed what retrieval surfaces, so a
number roughly double our ceiling cannot be a reader advantage. Closing it needs **chained
retrieval** — resolve hop 1, then query again for hop 2 — which Knowl does not do: `knowl_query`
is single-shot and returns ranked atoms without iterating. Tuning supersession, ranking or the
reader prompt provably cannot move this number.

Supersession still helps on the appropriate metric (+13 any-rank and all 29 stale leaks
eliminated at 6k; only +2 at 262k, where the ceiling is dominated by hop 2 never being retrieved
at all). This corrects an earlier reading that supersession "did not help multi-hop and was
marginally negative" — that came from the reader score, a different measurement.

---

## What the ablation actually changes, in the retrieved set

The same question, same corpus, same reader — only governance toggled. Taken from the saved
retrieved-context dumps:

```
supersession ON                                supersession OFF
- William Waynflete speaks ... Latin           - William Waynflete speaks ... Latin
                                               - William Waynflete speaks ... English
```

The OFF arm hands the reader both the current and the retired value and asks it to pick, having
told it (in text that trails all ten facts) to prefer the larger serial number. The ON arm never
offers the retired value at all. That is the whole mechanism: write-time supersession does not win
the arbitration step, it **deletes** it.

## Upstream bugs, verified at source

1. **UTF-8 crash on Windows.** `open(path, "w")` with no encoding, in `agent.py` (×4) and
   `main.py:89`. On Windows this encodes cp1252 and raises on the first non-ASCII retrieved value
   (e.g. `pesäpallo`). **Every method crashes, not just this one.** Fixed across all handlers in
   the local clone.

2. **`--force` does not discard old results.** `load_existing_results` runs unconditionally
   (`main.py:182`) while `args.force` reaches only `should_skip_context` (`main.py:50-52`). Anyone
   re-running after fixing their method silently averages stale rows into the new score.
   *Not fixed — needs a maintainer decision between discarding and a new `--fresh` flag.*

3. **`answers` is not one shape across rows.** The 6k instances carry one string per question; the
   262k single-hop row carries an array wherever several surface forms are accepted. A schema
   admitting only one shape rejects the headline instance outright. Fixed here via
   `normalizeAnswers`.

**`input_len` is the cheapest contamination detector.** Stale rows from a different code path
carry a visibly different context size. A jump (137 → 1,024) means mixed rows, not a real change.
Delete the results JSON *and* `outputs/rag_retrieved/<agent_name>/` before every run; `--force` is
not sufficient.

---

## Reproduction

```bash
# Build the bridge into its OWN directory -- `bench:cr` cleans .benchmark-dist on every run and
# would delete a bridge built alongside the CLI mid-experiment.
npx tsup benchmarks/memoryagentbench/mab-bridge.ts --format esm --outDir .bridge-dist --no-dts

# Retrieval only (no API key needed)
npm run bench:cr -- fetch --row 7 --out benchmarks/memoryagentbench/data/cr-sh-262k.json
npm run bench:cr -- run --instance benchmarks/memoryagentbench/data/cr-sh-262k.json --top-k 10
npm run bench:cr -- run --instance benchmarks/memoryagentbench/data/cr-sh-262k.json --top-k 10 --no-supersede
```

Rows 0–3 are multi-hop 6k/32k/64k/262k; rows 4–7 the single-hop equivalents.

Full harness (needs an OpenAI-compatible key), from the MemoryAgentBench clone:

```bash
KNOWL_BRIDGE=<abs path>/.bridge-dist/mab-bridge.js \
OPENAI_API_KEY=<key> PYTHONIOENCODING=utf-8 \
python main.py \
  --agent_config configs/agent_conf/RAG_Agents/gpt-4o-mini/Knowl_gpt-4o-mini.yaml \
  --dataset_config configs/data_conf/Conflict_Resolution/Factconsolidation_sh_262k.yaml
```

Swap in `Knowl_gpt-4o-mini-nosupersede.yaml` for the ablation. The two arms use different
`agent_name`s so their results and retrieved-context dumps cannot mix.

The reader layout is byte-identical to MemoryAgentBench's own RAG handler
(`agent.py:875`, `retrieval_memory_string + "\n" + message`, generic system message), so the task
instruction trails the retrieved facts exactly as it does for every published baseline.
`KNOWL_MAB_READER_LAYOUT=system-first` moves that same instruction into a system message ahead of
the facts — a **labelled diagnostic and our own construction, not a standard**.

Timing on the machine used here: ON ingest ≈ 35 min at 262k (18,332 dedup-checked writes plus a
vector reindex); OFF is slower still, since the reindex covers 18,332 active atoms rather than
11,570.

---

## Not done

- [ ] **The reader half has not been run in this rebuild** — it needs an OpenAI-compatible API
      key. Everything up to the LLM call is verified end to end: dataset → chunks → `add` →
      `flush` → `query` → reader prompt → 401. The 85-vs-42 figures remain the contributor's,
      unreplicated.
- [ ] Multi-hop reader score not measured since the parser fix.
- [ ] The OFF top-1 divergence (42% vs 70%) is unexplained; confirm the preset used in the
      original run.
- [ ] Nothing pushed. The MemoryAgentBench clone lives at `D:/coding/MemoryAgentBench` and is not
      a fork yet.

### Prior art found while researching this

[*"Don't Ask the LLM to Track Freshness: A Deterministic Recipe for Memory Conflict Resolution"*](https://arxiv.org/abs/2606.01435)
(Reddy & Challaram) already evaluates on FactConsolidation, reporting FC-SH @262k of **82%**
(gpt-4o-mini) and **93%** (gpt-4o), and FC-MH of **27%**. Their mechanism is the opposite of ours:
keep every fact and arbitrate at read time by parsing the serial and taking `max()`.

That approach exploits FactConsolidation's synthetic structure — real memory carries no monotonic
version number on every fact — which is a fair rebuttal, but it has to be **argued explicitly**.
The score alone does not make it, and their multi-hop number is well ahead of anything measured
here.
