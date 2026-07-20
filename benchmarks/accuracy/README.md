# Knowl accuracy benchmark

This benchmark compares agent-memory **accuracy only**. Latency, RAM, storage, token use, monetary cost, and setup effort are intentionally excluded from its leaderboard.

There are no reproduced competitor scores in this directory yet. AgentMemory, ProjectMem, AIngram, Graphiti, and Hindsight remain `N/A` until their pinned adapters are installed, run from clean isolated stores three times, and their raw predictions are scored by this harness. Numbers from project READMEs are never copied into the leaderboard.

## Protocol

The benchmark publishes two separate result tables:

- **Normalized retrieval:** every system receives the same prepared records. System-specific extraction, summarization, and consolidation are disabled. This isolates retrieval, ranking, provenance, stale-memory handling, abstention, and strict temporal filtering.
- **Native pipeline:** every system receives the same raw agent sessions and may use its normal capture, extraction, consolidation, graph, and lifecycle behavior. This measures end-to-end capture and answer accuracy.

The deterministic `coding-memory-v1` dataset contains 5 fictional projects, 100 multi-session histories, 400 sessions, and 200 questions. It covers architecture, project state, history, constraints, workflows, symbols, failed approaches, supersession, contradictions, stale evidence, multi-session reasoning, and abstention. Records carry stable source IDs and timestamps.

Public inputs and evaluator gold are separate files. An adapter receives only public records or native events plus the query; it never receives relevance labels, harmful-source lists, expected answers, or correctness flags. Retrieval is source-attributed and graded `3/2/1/0`. An output without source provenance is `N/A` for source-scored metrics.

Release controls are fixed before results are seen:

- dataset seed `20260713`;
- 3 clean runs, reported as the median of run-level metrics;
- `topK = 10` and a 2,000-token context budget;
- identical record/query order and a fresh isolated store for every run;
- unsupported capabilities are `N/A`, not zero;
- normalized and native results are never merged into an unlabeled score.

The full frozen rules, metric definitions, secondary quality formula, and publication requirements are in [preregistration.json](./preregistration.json). Exact external releases are in [systems.lock.json](./systems.lock.json). A tagged release alone does not make a result available: runtime dependencies, model revisions, configuration hashes, and the adapter must also be pinned and recorded.

## Reproduce

Use Node.js 22 or newer from a clean checkout:

```sh
npm ci
npm run benchmark:accuracy
```

`npm run benchmark:accuracy` is the canonical release command. It generates and validates the dataset, runs the locally available normalized adapters with the preregistered controls, scores predictions using evaluator-owned gold, and writes a new result directory. Do not add per-system flags or query-specific tuning to a release run.

External systems that are not installed remain in the report with an explicit `N/A` reason. Answer and semantic-vector tracks likewise remain `N/A` until their exact model revisions and prompt/configuration hashes are configured; the built-in signed-FNV hash-vector implementation is labeled as a deterministic control, not a semantic embedding baseline.

## Published artifacts

Each run writes `results/<commit-or-date>/` containing at least:

```text
environment.json
systems.json
capabilities.json
raw-predictions.ndjson
raw-results.ndjson
raw-capture.ndjson
reader-results.ndjson
judge-results.ndjson
normalized-summary.json
native-summary.json
leaderboard.md
knowl-ablations.md
failures.md
artifacts.sha256
```

The generated leaderboard must identify the benchmark commit, date, dataset version and hashes, question/run counts, hardware, model pins, raw-output path, and reproduction command. It may claim a category winner only from reproduced results and must disclose failed adapters, every `N/A`, and the paired uncertainty analysis defined by the preregistration.
