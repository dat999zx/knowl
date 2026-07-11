# Knowledge Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Preserve historical truth, detect deterministic conflicts, and compose diversified task context within an explicit token budget.

**Architecture:** `knowledge_items` remains the stable identity/current projection. Immutable assertions record validity and transaction time. Optional exclusive conflict keys constrain active assertions. The context composer consumes explained retrieval and evidence, then applies section budgets and MMR without changing lower-level query APIs.

**Tech Stack:** TypeScript, SQLite/libSQL, Drizzle bootstrap, existing retrieval/evidence services, Commander, MCP, Vitest.

---

### Task 1: Add immutable assertion history

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/store/schema.ts`
- Modify: `src/store/bootstrap.ts`
- Create: `src/store/assertions.ts`
- Test: `tests/store/assertions.test.ts`

- [x] **Step 1: Write failing assertion tests**

Assert new knowledge creates one open assertion, content updates close the previous assertion and open another atomically, metadata-only retrieval access does not create assertions, and bootstrap backfills one assertion for every existing item.

- [x] **Step 2: Run focused test and verify failure**

Run: `rtk npm.cmd test -- tests/store/assertions.test.ts`

Expected: FAIL because assertion storage does not exist.

- [x] **Step 3: Define assertion schema and types**

```ts
export interface KnowledgeAssertion {
  id: string;
  knowledgeItemId: string;
  content: string;
  validFrom: string;
  validTo?: string | null;
  recordedAt: string;
  replacedAt?: string | null;
  confidence: number;
  sourceEvidenceId?: string | null;
}
```

Create `knowledge_assertions` with indexes on item, validity interval, and recorded time. Backfill existing rows using item creation/update timestamps without changing current item content.

- [x] **Step 4: Implement assertion repository operations**

Expose create-current, replace-current, list timeline, and find as-of. Reject overlapping open assertions for one item. Keep operations transaction-aware so item update and assertion replacement commit together.

- [x] **Step 5: Run focused tests and commit**

Run: `rtk npm.cmd test -- tests/store/assertions.test.ts`

Expected: PASS.

```bash
rtk git add src/core/types.ts src/store/schema.ts src/store/bootstrap.ts src/store/assertions.ts tests/store/assertions.test.ts
rtk git commit -m "feat: preserve immutable knowledge assertions"
```

### Task 2: Integrate updates and add timeline/as-of queries

**Files:**
- Modify: `src/store/repository.ts`
- Modify: `src/store/knowledge-actions.ts`
- Modify: `src/store/queries.ts`
- Modify: `src/index.ts`
- Modify: `src/mcp/tools.ts`
- Test: `tests/store/assertions.test.ts`
- Test: `tests/cli/cli.test.ts`
- Test: `tests/mcp/server.test.ts`

- [x] **Step 1: Write failing integration tests**

Update an item twice and assert current retrieval returns version three, `knowl timeline <id>` returns all assertions, and `knowl query ... --as-of <timestamp>` returns the historically valid content. Assert status-only archival does not rewrite historical content.

- [x] **Step 2: Run focused tests and verify failure**

Run: `rtk npm.cmd test -- tests/store/assertions.test.ts tests/cli/cli.test.ts tests/mcp/server.test.ts`

Expected: FAIL because current writes and query surfaces ignore assertions.

- [x] **Step 3: Integrate assertions transactionally**

When title/content/reasoning/confidence changes, replace the open assertion in the same transaction as `knowledge_items`. Preserve knowledge commits as the user-facing audit summary; assertions are the authoritative temporal record.

- [x] **Step 4: Add read surfaces**

Add CLI `knowl timeline <item-id>` and `--as-of` on text query. MCP adds optional `asOf` to `knowl_query` plus `knowl_timeline`. Default queries remain current-only.

- [x] **Step 5: Verify and commit**

Run: `rtk npm.cmd test -- tests/store/assertions.test.ts tests/cli/cli.test.ts tests/mcp/server.test.ts`; `rtk npm.cmd run build`

Expected: PASS.

```bash
rtk git add src/store/repository.ts src/store/knowledge-actions.ts src/store/queries.ts src/index.ts src/mcp/tools.ts tests/store/assertions.test.ts tests/cli/cli.test.ts tests/mcp/server.test.ts
rtk git commit -m "feat: query temporal knowledge history"
```

### Task 3: Add deterministic conflict keys

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/store/schema.ts`
- Modify: `src/store/bootstrap.ts`
- Create: `src/store/conflicts.ts`
- Modify: `src/store/knowledge-writer.ts`
- Test: `tests/store/conflicts.test.ts`

- [x] **Step 1: Write failing conflict tests**

Cover two exclusive values for `database.production.engine`, scoped values for different environments, non-exclusive keys, explicit supersession, and concurrent attempts that leave only one active assertion.

- [x] **Step 2: Run focused test and verify failure**

Run: `rtk npm.cmd test -- tests/store/conflicts.test.ts`

Expected: FAIL because conflict identity/storage does not exist.

- [x] **Step 3: Add conflict identity fields**

Add optional `conflictKey`, `conflictScope`, and `conflictExclusive` to items/assertions. Normalize keys to lowercase dot-separated segments and scopes to stable JSON. Add an index supporting active-key lookup.

- [x] **Step 4: Implement collision checks**

Before opening an active exclusive assertion, query existing active assertions with the same key/scope. Return a structured `KnowledgeConflictError` containing IDs/titles only. Allow the caller to explicitly supersede one existing item in the same transaction; never auto-resolve silently.

- [x] **Step 5: Run focused tests and commit**

Run: `rtk npm.cmd test -- tests/store/conflicts.test.ts`

Expected: PASS.

```bash
rtk git add src/core/types.ts src/store/schema.ts src/store/bootstrap.ts src/store/conflicts.ts src/store/knowledge-writer.ts tests/store/conflicts.test.ts
rtk git commit -m "feat: enforce deterministic knowledge conflict keys"
```

### Task 4: Expose conflict management

**Files:**
- Modify: `src/mcp/tools.ts`
- Modify: `src/index.ts`
- Test: `tests/mcp/server.test.ts`
- Test: `tests/cli/cli.test.ts`

- [x] **Step 1: Write failing surface tests**

Assert direct writes can provide key/scope/exclusivity, conflicting writes return structured alternatives, `knowl conflicts` lists active collisions, and `knowl update --supersede <id>` resolves one collision atomically.

- [x] **Step 2: Run focused tests and verify failure**

Run: `rtk npm.cmd test -- tests/mcp/server.test.ts tests/cli/cli.test.ts`

Expected: FAIL because the fields/commands are not exposed.

- [x] **Step 3: Implement minimal surfaces**

Extend structured MCP schemas and CLI options. Do not require conflict keys for ordinary atoms. Conflict reports include evidence counts and freshness, not full content dumps.

- [x] **Step 4: Verify and commit**

Run: `rtk npm.cmd test -- tests/mcp/server.test.ts tests/cli/cli.test.ts`; `rtk npm.cmd run build`

Expected: PASS.

```bash
rtk git add src/mcp/tools.ts src/index.ts tests/mcp/server.test.ts tests/cli/cli.test.ts
rtk git commit -m "feat: expose deterministic conflict management"
```

### Task 5: Implement the context composer

**Files:**
- Create: `src/store/context-composer.ts`
- Modify: `src/core/types.ts`
- Modify: `src/store/agent-query.ts`
- Test: `tests/store/context-composer.test.ts`

- [x] **Step 1: Write failing composer tests**

Cover pinned constraints, current task state, relevant decisions/architecture, failed approaches, skills, optional evidence, duplicate removal, token-budget truncation, and an excluded-item report. Assert critical pinned constraints survive a small budget.

- [x] **Step 2: Run focused test and verify failure**

Run: `rtk npm.cmd test -- tests/store/context-composer.test.ts`

Expected: FAIL because the composer does not exist.

- [x] **Step 3: Define input/output contracts**

```ts
export type ContextRequest = {
  query?: string;
  task?: string;
  changedFiles?: string[];
  tokenBudget: number;
  includeEvidence?: boolean;
};

export type ContextPack = {
  sections: Array<{ name: string; items: KnowledgeItem[]; estimatedTokens: number }>;
  excluded: Array<{ itemId: string; reason: 'duplicate' | 'budget' | 'stale' | 'lower-rank' }>;
  estimatedTokens: number;
};
```

- [x] **Step 4: Implement deterministic composition**

Retrieve an expanded candidate window with explanations; reserve budget for pinned constraints/task state; group remaining candidates; remove normalized duplicates; run MMR using token overlap/evidence identity; estimate tokens conservatively as `ceil(characters / 4)`; truncate content only at paragraph boundaries.

- [x] **Step 5: Run focused tests and commit**

Run: `rtk npm.cmd test -- tests/store/context-composer.test.ts`

Expected: PASS.

```bash
rtk git add src/store/context-composer.ts src/core/types.ts src/store/agent-query.ts tests/store/context-composer.test.ts
rtk git commit -m "feat: compose budget-aware agent context"
```

### Task 6: Expose `knowl_context` and verify intelligence features

**Files:**
- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/resources.ts`
- Modify: `src/index.ts`
- Modify: `README.md`
- Test: `tests/mcp/server.test.ts`
- Test: `tests/cli/cli.test.ts`

- [x] **Step 1: Write failing MCP/CLI tests**

Test `knowl_context` inputs/output, CLI `knowl context`, evidence opt-in, excluded report, invalid budgets, timeline/conflict coexistence, and default compact behavior.

- [x] **Step 2: Run focused tests and verify failure**

Run: `rtk npm.cmd test -- tests/mcp/server.test.ts tests/cli/cli.test.ts`

Expected: FAIL because surfaces are not registered.

- [x] **Step 3: Implement surfaces and bootstrap integration**

Register one MCP operation, one CLI command, and one resource view. Update Plan 6 context bootstrap to prefer the composer while retaining `knowl_recent` fallback.

- [x] **Step 4: Run benchmark and full verification**

Run: `rtk npm.cmd test`; `rtk npm.cmd run build`; `rtk git diff --check`; `node dist/index.js eval retrieval --dataset docs/evals/retrieval-baseline.json --json`

Expected: PASS; context size remains within requested budgets and retrieval benchmark does not regress forbidden/stale hits.

- [x] **Step 5: Commit and store outcome**

```bash
rtk git add src/mcp/tools.ts src/mcp/resources.ts src/index.ts README.md tests/mcp/server.test.ts tests/cli/cli.test.ts
rtk git commit -m "feat: expose temporal conflict-aware context packs"
```

Store assertion semantics, conflict resolution rules, composer budgets, benchmark result, and commit hash in Knowl.
