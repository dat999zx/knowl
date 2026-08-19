# Knowl as a MemoryAgentBench method

The half of the FactConsolidation replication that runs **inside** MemoryAgentBench. The other
half — the Node bridge, the fact parser, the CLI and the checked-in results — is the parent
directory.

This exists because the first version of it did not. It lived only as untracked files inside a
local MAB clone, and it was lost when the clone was reset onto the `fix/utf8-and-force` branch.
The published **90** then had no reproduction path, which is fatal for a number whose entire value
is that a stranger can check it.

## Install

```bash
python benchmarks/memoryagentbench/mab/install.py /path/to/MemoryAgentBench
```

Copies `knowl.py` into `methods/`, both configs into
`configs/agent_conf/RAG_Agents/gpt-4o-mini/`, and makes three anchored edits to `agent.py`.
Idempotent — re-running reports `already applied`. If an anchor stops matching, upstream moved;
re-anchor the edit rather than forcing it.

Then build the bridge and point the harness at it:

```bash
npx tsup benchmarks/memoryagentbench/mab-bridge.ts --format esm --outDir .benchmark-dist --no-dts
export KNOWL_BRIDGE=/abs/path/to/knowl/.benchmark-dist/mab-bridge.js
```

## The two arms

| config | `agent_name` | supersession |
| --- | --- | --- |
| `Knowl_gpt-4o-mini.yaml` | `Agentic_memory_knowl` | on — the published arm |
| `Knowl_gpt-4o-mini-nosupersede.yaml` | `Agentic_memory_knowl_nosupersede` | off — the ablation |

Same corpus, same retrieval, governance toggled. `KNOWL_SUPERSEDE=0` overrides the config for a
one-off run.

## Why this is a like-for-like comparison

Every value in the config except the `knowl_*` pair is **copied from the baselines, not chosen**.
Verified against the repo's own configs on 2026-08-18:

| setting | Knowl | baselines |
| --- | --- | --- |
| `model` / `temperature` | gpt-4o-mini / 0.7 | identical across every gpt-4o-mini config |
| `input_length_limit` | 10000000 | identical |
| `buffer_length` | 200 | identical to `Simple_rag_bm25` |
| `retrieve_num` | **10** | 10 for BM25, Zep, Cognee, HippoRAG-v2, RAPTOR, GraphRAG, Self-RAG and all four embedding baselines. **Mem0 uses 100.** MemoRAG uses 3. |

The reader assembly is byte-identical to `_handle_bm25_rag`: each retrieved item gets a trailing
newline, items are labelled `Memory i:` and joined, then `retrieval_memory_string + "\n" + message`
goes in the user turn under the generic system template. The task instruction therefore **trails**
the facts, as it does for every RAG baseline.

Retrieval uses `agent._extract_retrieval_query(message)`, the same extractor every RAG baseline
calls. Skipping it is not a small error: MAB wraps each question in ~200 tokens of boilerplate
that is byte-identical across all 100 questions, so retrieving on the raw message retrieves on
noise. That bug once scored us **20.0** at 262k with no error and clean `input_len`.

**One asymmetry worth disclosing rather than hiding:** MAB's own baselines are not uniform on
reader layout. `_handle_mem0_agent` puts its memories in a *system* message and appends a
`Current Time:` line to the user turn; the RAG family does neither. We match the RAG family. That
is MAB's inconsistency, not ours, but any writeup comparing against Mem0's 18 should say so.

`KNOWL_MAB_READER_LAYOUT=system-first` exists only as a labelled diagnostic. Two independent
implementations of that layout produced opposite signs, so no number from it may be published in
either direction.

## Ingestion

Chunks are buffered and written on `flush`, not per chunk: the titling rule derives each fact's
subject+relation by shared-prefix discovery across the whole fact list, so it cannot run
incrementally. `flush` is called at the top of the first query and timed into
`memory_construction_time` — without that the harness reports ~0.01s and buries a 559s ingest
inside the latency of question 1.

The bridge frames every response with an `@@KNOWL@@` sentinel because the embedding runtime and
the SQLite bindings both write to stdout freely. An unframed protocol eventually eats a stray log
line and desynchronises mid-run, which surfaces as a plausible score rather than an error.
