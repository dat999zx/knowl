# FactConsolidation: Knowl vs agentmemory, measured in MemoryAgentBench's own harness

Runs from 2026-08-19. Every number here was produced by MemoryAgentBench's harness and scored by
its own code, with `gpt-4o-mini` as the reader for every row. The raw result files are in
[`results/`](results/) and carry the full per-question record, the `agent_config` actually used,
and the token counts.

**These are single runs at `temperature: 0.7` and should be read as directional.** The ablation gap
moved 4 points between two runs of the same 6k cell, so no figure here is publication-grade until
it has been repeated at least three times with the spread reported. Nothing in this document has
been published anywhere else.

## Results

`FactConsolidation` single-hop, substring exact match, 100 questions, `retrieve_num: 10`.

| system | 6k SubEM | 262k SubEM |
| --- | ---: | ---: |
| **Knowl**, supersession on | **95.0** | **89.0** |
| **agentmemory v0.9.29** | **83.0** | **79.0** |
| Knowl, supersession off | 75.0 | 73.0 |

Conflicts resolved at write time, same corpus, same order:

| system | 6k | 262k |
| --- | ---: | ---: |
| Knowl | 149 of 455 facts | 6,761 of 18,332 facts |
| agentmemory | 48 | 3,913 |
| Knowl, supersession off | 0 | 0 |

**agentmemory falls between Knowl's two arms at both sizes.** That ordering holding across a 40×
corpus change is the reason to believe the measurement; a system that scored below the disabled
arm would suggest a broken adapter rather than a real result.

### Why the gap exists

Both systems resolve conflicts at write time. They key them differently.

- **Knowl** keys on subject+relation — the atom title, derived by shared-prefix discovery across
  the fact list. The size of the changed value does not affect whether a conflict is detected.
- **agentmemory** keys on Jaccard token similarity over whole content, superseding at `> 0.7`
  (`src/functions/remember.ts:135`). This is length-sensitive, and the sensitivity runs against
  this task: the shorter the fact and the larger the swapped value, the lower the similarity, so
  the clearest contradictions are the ones most likely to fall under the bar.

A hand-checked pair from the corpus shape lands exactly on the boundary:

```
goaltender is associated with the sport of ice hockey
goaltender is associated with the sport of pesapallo
```

Shared tokens 7, union 10, Jaccard **0.7000** — and the threshold is a strict `> 0.7`. Against a
live server both records stayed `isLatest: true` with `supersedes: []`, and search returned both
with the **stale** one ranked first.

**The ratio is not stable across corpus sizes.** agentmemory resolved 32% of the conflicts Knowl
did at 6k (48 of 149) but 58% at 262k (3,913 of 6,761), because the mix of fact shapes changes what
clears the threshold. Do not quote the 6k ratio as if it generalises.

## Why this comparison is like-for-like

Every value in the Knowl and agentmemory configs except the `knowl_*` pair is **copied from
`Simple_rag_bm25`**, not chosen:

| setting | both methods | baselines |
| --- | --- | --- |
| `model` / `temperature` | gpt-4o-mini / 0.7 | identical across every gpt-4o-mini config |
| `input_length_limit` | 10000000 | identical |
| `buffer_length` | 200 | identical to `Simple_rag_bm25` |
| `retrieve_num` | **10** | 10 for BM25, Zep, Cognee, HippoRAG-v2, RAPTOR, GraphRAG, Self-RAG and all four embedding baselines. **Mem0 uses 100**, MemoRAG 3. |

- **Same reader assembly.** Both adapters call the same `build_reader_messages` and
  `format_retrieval_memory_string`, which reproduce `_handle_bm25_rag` byte for byte: each item
  gets a trailing newline, items are labelled `Memory i:` and joined, and the instruction **trails**
  the facts under the generic system template. Sharing the code means neither method can drift on
  its own. Measured `input_len`: 349.3 (Knowl on), 350.2 (Knowl off), 349.5 (agentmemory).
- **Same retrieval query.** Both call the harness's own `_extract_retrieval_query`. Skipping it is
  not a small error — MAB wraps every question in ~200 tokens of boilerplate that is byte-identical
  across all 100 questions, and retrieving on the raw message once scored Knowl **20.0** at 262k
  with no error and clean `input_len`.
- **Same input.** Both receive the identical parsed fact list, one record per write, in context
  order, through a shared `parse_fact_lines` port of `facts.ts:parseFactLines`.

### A choice that must travel with these numbers

Feeding raw 4096-character chunks instead of parsed facts was considered and rejected. agentmemory
stores one memory per `remember` call, so a chunk would land as a single record holding ~70 facts:
supersession could never fire and retrieval would return a wall of text. That would measure our
chunking rather than their memory. This is the normalized mode — identical prepared records, no
system-specific extraction — and it is a deliberate choice, not a neutral one.

### An asymmetry in the harness itself

MemoryAgentBench's own baselines are **not uniform** on reader layout. `_handle_mem0_agent` puts
its memories in a *system* message and appends a `Current Time:` line to the user turn; the RAG
family does neither. Both methods here match the RAG family. Anyone comparing these figures against
Mem0's published 18.0 should know that row was produced under a different assembly.

## Two systems that were adapted and then excluded

Both are recorded here rather than quietly omitted, because a missing competitor is more
conspicuous than an explained one.

**Graphiti** — adapter works ([`graphiti_bench.py`](graphiti_bench.py)); excluded on cost. Its
ingest is LLM-driven: `add_episode` runs entity extraction, edge extraction, dedup of both, and
temporal invalidation as separate model calls. Measured **42 episodes in 6.4 minutes**, which
extrapolates to roughly **45 hours and $20–60 for a single 262k run**, before the repetitions
variance requires. A smoke test was encouraging for them — after ingesting both sides of a conflict,
search returned only the newer fact — so this is a cost exclusion, not a quality one. Two upstream
defects found on the way, for anyone retrying: graphiti-core 0.29.2 and 0.29.3 both fail on the
first write against Kuzu 0.11.3, the version their own `kuzu` extra requires, with `Table
RelatesToNode_ doesn't have an index with name edge_name_and_fact`; and passing a `group_id` reads
`driver._database` (`graphiti.py:1079`, `:1307`), which only the Neo4j and FalkorDB drivers set.
FalkorDB is the working backend.

**mem0** — not measured; cite the published 18.0 instead. MemoryAgentBench pins `mem0ai`
**unversioned** (`requirements.txt:89`), so installing today gives 2.0.18 against an adapter written
for the v0.x-era API. `add()` returns `{'results': []}` — it stores nothing and raises nothing, and
the reader then answers from an empty memory string and scores in the low teens. The endpoint was
ruled out: mem0's own LLM call and its JSON-mode call both work. Anyone attempting this must pin
`mem0ai` explicitly and assert `get_all()` is non-empty after ingest before trusting any score.

**The rule both of these teach**, which has now cost twice: a memory system scoring far below what
retrieval can account for has stored nothing, rather than being bad. Check corpus size after ingest
before reading the score.

## Reproducing

```bash
# 1. Install both methods into a MemoryAgentBench checkout (idempotent).
python benchmarks/memoryagentbench/mab/install.py /path/to/MemoryAgentBench

# 2. Build the Knowl bridge and point the harness at it.
npx tsup benchmarks/memoryagentbench/mab-bridge.ts --format esm --outDir .benchmark-dist --no-dts
export KNOWL_BRIDGE=/abs/path/to/knowl/.benchmark-dist/mab-bridge.js

# 3. For agentmemory only, start its server (a Node service; nothing lands in the harness venv).
cd /path/to/agentmemory && node dist/cli.mjs        # REST on :3111

# 4. Run any arm.
cd /path/to/MemoryAgentBench
python main.py \
  --agent_config configs/agent_conf/RAG_Agents/gpt-4o-mini/Knowl_gpt-4o-mini.yaml \
  --dataset_config configs/data_conf/Conflict_Resolution/Factconsolidation_sh_262k.yaml --force
```

Swap the agent config for `Knowl_gpt-4o-mini-nosupersede.yaml` or `AgentMemory_gpt-4o-mini.yaml`,
and the dataset config for `Factconsolidation_sh_6k.yaml`, to reach any cell in the table.

Reader cost is about **$0.0054 per 100-question run** for all three arms — the retrieved context is
~350 tokens per question. A long-context baseline sending 262k tokens per question would cost
roughly $3.93 for the same 100 questions.

## Versions

| | |
| --- | --- |
| agentmemory | v0.9.29, commit `2d38daf` |
| graphiti-core | 0.29.2 and 0.29.3 (both fail on Kuzu; FalkorDB used) |
| mem0ai | 2.0.18 — **unpinned upstream**, and the reason mem0 is not measured here |
| reader | `gpt-4o-mini`, temperature 0.7 |
| paper figures quoted elsewhere | arXiv 2507.05257 **v4**, Table 3 |

The paper's comparison table is versioned and has moved: in v1 it was Table 2, BM25 read 56.0
rather than 48.0, and Zep and MIRIX were absent. Always cite the version alongside the table
number — a row can vanish upstream rather than merely change.
