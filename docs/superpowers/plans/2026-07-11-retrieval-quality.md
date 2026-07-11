# Retrieval Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a repeatable retrieval benchmark, explain rankings, and improve fusion only when measured gains do not regress stale-memory behavior or latency.

**Architecture:** A versioned JSON evaluation set feeds a pure metrics runner over the existing `queryKnowledgeForAgent` API. Query results gain optional score explanations and access telemetry. Ranking changes remain bounded and are compared against the checked-in baseline before adoption.

**Tech Stack:** TypeScript, JSON fixtures, existing FTS5/BM25 and SQLite vector search, Commander, MCP, Vitest.

---

### Task 1: Create the evaluation dataset and metrics runner

**Files:**
- Create: `docs/evals/retrieval-baseline.json`
- Create: `src/store/retrieval-evaluation.ts`
- Test: `tests/store/retrieval-evaluation.test.ts`

- [ ] **Step 1: Write failing metric tests**

Use an in-memory fixture with known relevant, stale, and forbidden items. Assert recall@3, recall@10, MRR, nDCG, stale-hit count, forbidden-hit count, and context-character count match hand-computed values.

- [ ] **Step 2: Run focused test and verify failure**

Run: `rtk npm.cmd test -- tests/store/retrieval-evaluation.test.ts`

Expected: FAIL because the evaluation module and fixture do not exist.

- [ ] **Step 3: Define the dataset format**

Create at least ten representative queries covering decisions, architecture, failures, commands, filenames, stale knowledge, and category misclassification. Each case has:

```json
{
  "id": "database-choice",
  "query": "why are we using sqlite",
  "expectedItemIds": ["fixture-current-sqlite"],
  "mustNotReturn": ["fixture-rejected-postgres"],
  "limit": 10
}
```

Keep fixture IDs deterministic and document that production IDs are mapped by title/content during benchmark setup.

- [ ] **Step 4: Implement pure metrics**

Expose `evaluateRetrieval(cases, execute)` where `execute` receives a case and returns ranked item IDs plus latency and serialized context size. Implement recall@k, reciprocal rank, graded nDCG, stale/forbidden counts, p50/p95 latency, and average context size without database access inside the metric functions.

- [ ] **Step 5: Run focused tests and commit**

Run: `rtk npm.cmd test -- tests/store/retrieval-evaluation.test.ts`

Expected: PASS.

```bash
rtk git add docs/evals/retrieval-baseline.json src/store/retrieval-evaluation.ts tests/store/retrieval-evaluation.test.ts
rtk git commit -m "test: add retrieval evaluation harness"
```

### Task 2: Add score explanations without changing default output

**Files:**
- Create: `src/store/retrieval-explanation.ts`
- Modify: `src/store/agent-query.ts`
- Modify: `src/core/types.ts`
- Test: `tests/store/store.test.ts`

- [ ] **Step 1: Write failing explanation tests**

Assert an explained result contains final score, BM25 rank, vector rank when present, text-match contribution, category contribution, recency/confidence/freshness contributions, and a human-readable reason. Assert ordinary `queryKnowledgeForAgent` callers still receive `KnowledgeItem[]`.

- [ ] **Step 2: Run focused test and verify failure**

Run: `rtk npm.cmd test -- tests/store/store.test.ts -t explanation`

Expected: FAIL because explained query types and implementation do not exist.

- [ ] **Step 3: Introduce an opt-in query result type**

Add:

```ts
export type KnowledgeSearchExplanation = {
  finalScore: number;
  bm25Rank?: number;
  vectorRank?: number;
  contributions: Record<string, number>;
  reason: string;
};

export type ExplainedKnowledgeItem = KnowledgeItem & { explanation: KnowledgeSearchExplanation };
```

Implement `queryKnowledgeForAgentExplained` by sharing the existing candidate collection and sort logic. Do not duplicate ranking code.

- [ ] **Step 4: Run focused tests and commit**

Run: `rtk npm.cmd test -- tests/store/store.test.ts -t explanation`

Expected: PASS.

```bash
rtk git add src/store/retrieval-explanation.ts src/store/agent-query.ts src/core/types.ts tests/store/store.test.ts
rtk git commit -m "feat: explain agent retrieval scores"
```

### Task 3: Expose benchmark and explanations through CLI/MCP

**Files:**
- Modify: `src/index.ts`
- Modify: `src/mcp/tools.ts`
- Test: `tests/cli/cli.test.ts`
- Test: `tests/mcp/server.test.ts`

- [ ] **Step 1: Write failing surface tests**

Test `knowl eval retrieval --dataset docs/evals/retrieval-baseline.json --json` returns metrics and per-case failures. Test `knowl_query` accepts `explain: true` and returns explanations only when requested.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `rtk npm.cmd test -- tests/cli/cli.test.ts tests/mcp/server.test.ts`

Expected: FAIL because the command/option is not wired.

- [ ] **Step 3: Implement the surfaces**

Use the project-root fixture and existing CLI JSON conventions. MCP defaults remain compact and explanation-free. Benchmark output includes dataset path, timestamp, metrics, latency, context size, and failed case IDs.

- [ ] **Step 4: Verify and commit**

Run: `rtk npm.cmd test -- tests/cli/cli.test.ts tests/mcp/server.test.ts`; `rtk npm.cmd run build`

Expected: PASS.

```bash
rtk git add src/index.ts src/mcp/tools.ts tests/cli/cli.test.ts tests/mcp/server.test.ts
rtk git commit -m "feat: expose retrieval evaluation and explanations"
```

### Task 4: Measure access feedback

**Files:**
- Modify: `src/store/schema.ts`
- Modify: `src/store/bootstrap.ts`
- Create: `src/store/access-feedback.ts`
- Modify: `src/store/agent-query.ts`
- Modify: `src/mcp/tools.ts`
- Test: `tests/store/access-feedback.test.ts`
- Test: `tests/mcp/server.test.ts`

- [ ] **Step 1: Write failing telemetry tests**

Assert one access row records item ID, query fingerprint, retrieval time, surface, rank, and optional `used`, `useful`, and `causedCorrection` values. Assert query telemetry is bounded to returned items and failures never block retrieval.

- [ ] **Step 2: Run focused test and verify failure**

Run: `rtk npm.cmd test -- tests/store/access-feedback.test.ts tests/mcp/server.test.ts`

Expected: FAIL because the table/service/tool do not exist.

- [ ] **Step 3: Implement append-only access records**

Add `knowledge_access` with indexes on item/time and query fingerprint. Hash query text before storage. Record access after a successful query in a best-effort transaction; never persist raw query secrets and never lower ranking solely because an item was ignored.

- [ ] **Step 4: Add feedback and report reads**

Expose `knowl_feedback` and `knowl access report`. Reports show high-value, stale-but-frequently-retrieved, and repeatedly corrected items. Keep ranking unchanged until the evaluation harness demonstrates a benefit.

- [ ] **Step 5: Run focused tests and commit**

Run: `rtk npm.cmd test -- tests/store/access-feedback.test.ts tests/mcp/server.test.ts`

Expected: PASS.

```bash
rtk git add src/store/schema.ts src/store/bootstrap.ts src/store/access-feedback.ts src/store/agent-query.ts src/mcp/tools.ts tests/store/access-feedback.test.ts tests/mcp/server.test.ts
rtk git commit -m "feat: track retrieval access feedback"
```

### Task 5: Apply measured ranking improvements

**Files:**
- Modify: `src/store/agent-query.ts`
- Modify: `tests/store/store.test.ts`
- Modify: `docs/evals/retrieval-baseline.json`

- [ ] **Step 1: Add regression cases**

Add cases for category-hint dominance, exact filenames/functions/commands, stale versus active duplicates, semantic contradiction, and diversified results with near-duplicate titles.

- [ ] **Step 2: Implement bounded fusion**

Replace reciprocal rank terms with `1 / (60 + rank)` for each retrieval list. Keep category, freshness, confidence, and exact-identifier contributions bounded below the dominant relevance signal. Preserve active-status defaults and vector-disabled behavior.

- [ ] **Step 3: Add deterministic diversification**

Implement a small MMR pass over the top candidate window using token-set overlap; keep the requested limit and expose the diversity contribution in explanations. Avoid adding a vector dependency.

- [ ] **Step 4: Run the benchmark and compare**

Run: `rtk npm.cmd test -- tests/store/store.test.ts tests/store/retrieval-evaluation.test.ts`; `rtk npm.cmd run build`; `node dist/index.js eval retrieval --dataset docs/evals/retrieval-baseline.json --json`

Expected: all regression tests pass; record baseline-versus-new metrics in the plan checkpoint. Revert a ranking change if recall or stale-hit rate regresses without a documented tradeoff.

- [ ] **Step 5: Commit and store outcome**

```bash
rtk git add src/store/agent-query.ts tests/store/store.test.ts docs/evals/retrieval-baseline.json
rtk git commit -m "feat: improve measured retrieval fusion and diversity"
```

Store the metrics, latency, and accepted tradeoffs in Knowl as a concise decision/state item.
