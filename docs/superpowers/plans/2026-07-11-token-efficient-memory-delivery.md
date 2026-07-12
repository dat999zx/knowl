# Token-Efficient Memory Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Knowl from repeatedly injecting stale/verbose context or returning unbounded MCP payloads while preserving explicit, durable-memory workflows.

**Architecture:** Separate lifecycle capture from context delivery. Session-start may deliver one compact bootstrap pack; ordinary prompts/events deliver no repeated context. All model-facing responses pass through bounded compact DTOs, global result limits, and explicit opt-in detail paths. Automatic command noise remains ephemeral unless deliberately promoted.

**Tech Stack:** TypeScript, Commander CLI, MCP stdio server, Drizzle/libSQL SQLite, Vitest, existing markdown formatters.

**Success criteria:**

- Repeated `UserPromptSubmit` emits no `additionalContext` after the initial bootstrap.
- Bootstrap context is bounded by one shared character/token budget.
- Routine successful shell commands do not become durable recent-context items.
- Every retrieval path enforces a global result limit, including fallback, `asOf`, and layered namespaces.
- Default MCP responses are compact, single-line JSON or bounded markdown; full detail requires an explicit option.
- Tests assert output/context budgets, not only semantic fields.

**Non-goals:** Raw transcript retention, LLM summarization for every event, removing explicit full-detail inspection commands, or changing knowledge categories/DB schemas unless a migration is required for noise filtering.

---

### Task 1: Add shared compacting and budget primitives

**Files:**
- Create: `src/core/token-budget.ts`
- Test: `tests/core/token-budget.test.ts`

- [ ] **Step 1: Write failing unit tests**

Cover:

```ts
expect(truncateText('abcdef', 4)).toBe('abcd');
expect(estimateTokens('12345678')).toBe(2);
expect(compactKnowledgeItem(item)).toEqual(expect.objectContaining({ id: item.id, title: item.title, content: item.content }));
expect(compactKnowledgeItem({ ...item, reasoning: 'x', alternatives: ['y'], affectedPaths: ['z'] })).not.toHaveProperty('reasoning');
```

Define one shared default budget (3,000 chars for automatic context; 1,200 estimated tokens) and named limits for item text, tags, evidence, and result counts. Tests must assert deterministic truncation markers.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `rtk npm.cmd test -- tests/core/token-budget.test.ts`

Expected: FAIL because `src/core/token-budget.ts` does not exist.

- [ ] **Step 3: Implement the minimal primitives**

Export:

```ts
export const DEFAULT_CONTEXT_MAX_CHARS = 3_000;
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 1_200;
export const DEFAULT_RESULT_LIMIT = 3;
export const MAX_ITEM_CONTENT_CHARS = 600;
export const MAX_EVIDENCE_ITEMS = 5;
export function truncateText(value: string, maxChars: number, marker?: string): string;
export function estimateTokens(value: string): number;
export function compactKnowledgeItem(item: KnowledgeItem): CompactKnowledgeItem;
```

`compactKnowledgeItem` retains only `id`, `category`, `title`, bounded `content`, `freshness`, `confidence`, and bounded tags. Omit null/verbose provenance fields by default.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `rtk npm.cmd test -- tests/core/token-budget.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/token-budget.ts tests/core/token-budget.test.ts
git commit -m "perf: add shared token budget primitives"
```

### Task 2: Make lifecycle context one-shot, not per-prompt

**Files:**
- Modify: `src/store/context-bootstrap.ts`
- Modify: `src/store/host-session-bindings.ts`
- Modify: `src/store/host-lifecycle.ts`
- Test: `tests/store/context-bootstrap.test.ts`
- Test: `tests/store/host-lifecycle.test.ts`
- Test: `tests/cli/agent-lifecycle.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Add assertions:

```ts
const sessionStart = await handleHostLifecycleEvent(projectId, sessionStartHook);
expect(sessionStart.hostOutput?.hookSpecificOutput.additionalContext).toContain('KNOWL');

const firstPrompt = await handleHostLifecycleEvent(projectId, turnStartHook);
expect(firstPrompt.hostOutput).toBeUndefined();

const secondPrompt = await handleHostLifecycleEvent(projectId, anotherTurnStartHook);
expect(secondPrompt.hostOutput).toBeUndefined();
```

Also assert repeated `session-event`/`checkpoint` calls do not invoke context composition or return context fields. Preserve a one-time fallback: if a host sends `UserPromptSubmit` without a prior `SessionStart` binding, that first prompt may receive the compact bootstrap.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `rtk npm.cmd test -- tests/store/context-bootstrap.test.ts tests/store/host-lifecycle.test.ts tests/cli/agent-lifecycle.test.ts`

Expected: FAIL because `turn-start` currently returns `additionalContext` and every existing binding re-runs `bootstrapAgentSession`.

- [ ] **Step 3: Split session state from context delivery**

Change `bootstrapAgentSession` to accept `{ includeContext?: boolean }`:

```ts
bootstrapAgentSession(input, { includeContext: true });  // SessionStart/fallback
bootstrapAgentSession(input, { includeContext: false }); // normal turns/events
```

When `includeContext` is false, heartbeat/create the memory session but return `context: undefined`, `truncated: false`, and never call `getRecentContext`.

Update `getOrCreateHostSession` and `handleHostLifecycleEvent`:

- `session-start` → full compact context once.
- `turn-start` → no context unless no session binding exists.
- `session-event`, `checkpoint`, `turn-stop`, `session-stop` → no context.
- `hostContextOutput` → return only when context exists.

Use the existing host binding table to detect whether the session-scope binding exists; do not infer state from prompt text.

- [ ] **Step 4: Enforce the shared context budget**

Replace the local 6,000-character truncation in `src/store/context-bootstrap.ts` with `DEFAULT_CONTEXT_MAX_CHARS` and compact formatting from Task 1. Keep the `[Context truncated]` marker. Do not include full reasoning, alternatives, evidence, or commit changes in automatic bootstrap.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `rtk npm.cmd test -- tests/store/context-bootstrap.test.ts tests/store/host-lifecycle.test.ts tests/cli/agent-lifecycle.test.ts`

Expected: PASS; only SessionStart (or first-prompt fallback) emits context.

- [ ] **Step 6: Commit**

```bash
git add src/store/context-bootstrap.ts src/store/host-session-bindings.ts src/store/host-lifecycle.ts tests/store/context-bootstrap.test.ts tests/store/host-lifecycle.test.ts tests/cli/agent-lifecycle.test.ts
git commit -m "perf: deliver lifecycle context once per session"
```

### Task 3: Stop promoting routine command noise

**Files:**
- Modify: `src/store/session-candidates.ts`
- Modify: `src/store/candidate-promotion.ts` (only if result metadata needs compacting)
- Test: `tests/store/session-finalizer.test.ts`
- Test: `tests/store/session-repository.test.ts`
- Test: `tests/store/candidate-promotion.test.ts`

- [ ] **Step 1: Write failing promotion tests**

Create a session containing successful `command` events plus an explicit `decision` and `stop` summary. Assert finalization promotes the decision/outcome but not `Verified command: ...` items:

```ts
expect(promoted.itemIds).toHaveLength(2);
expect(await listActiveItemsByTitle('Verified command: npm test')).toHaveLength(0);
```

Retain command events for the 48-hour ephemeral session window; only durable promotion changes.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `rtk npm.cmd test -- tests/store/session-finalizer.test.ts tests/store/candidate-promotion.test.ts`

Expected: FAIL because successful command events currently become `skill` candidates.

- [ ] **Step 3: Remove automatic verified-command candidates**

Delete the command loop in `extractSessionMemoryCandidates`. Keep explicit decision candidates and one bounded outcome candidate. Preserve the five-candidate safety cap for remaining candidate types.

- [ ] **Step 4: Add a durable opt-in path**

Document that users/agents can call `knowl_store` for a command worth retaining. Do not add a new automatic command classifier or LLM call.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `rtk npm.cmd test -- tests/store/session-finalizer.test.ts tests/store/candidate-promotion.test.ts tests/store/session-repository.test.ts`

Expected: PASS; routine shell commands no longer enter recent active knowledge.

- [ ] **Step 6: Commit**

```bash
git add src/store/session-candidates.ts src/store/candidate-promotion.ts tests/store/session-finalizer.test.ts tests/store/session-repository.test.ts tests/store/candidate-promotion.test.ts
git commit -m "perf: keep routine commands ephemeral"
```

### Task 4: Compact and filter recent context everywhere

**Files:**
- Modify: `src/store/recent-context.ts`
- Modify: `src/core/format.ts`
- Modify: `src/mcp/tools.ts` (`knowl_recent`)
- Modify: `src/mcp/resources.ts` (`knowl://recent`)
- Modify: `src/core/agents-guidance.ts`
- Test: `tests/store/store.test.ts`
- Test: `tests/mcp/server.test.ts`
- Test: `tests/cli/cli.test.ts`

- [ ] **Step 1: Write failing budget/filter tests**

Assert:

- default recent output is `<= DEFAULT_CONTEXT_MAX_CHARS`;
- item content is bounded and tags are compact;
- auto-captured/work-loop noise is excluded by default;
- explicit `itemLimit`, `commitLimit`, and `maxChars` remain honored;
- `knowl://recent` and `knowl_recent` use the same formatter/budget.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `rtk npm.cmd test -- tests/store/store.test.ts tests/mcp/server.test.ts tests/cli/cli.test.ts -t "recent|context"`

Expected: FAIL on current 12-item/8-commit and uncapped MCP/resource output.

- [ ] **Step 3: Add compact recent-context options**

Extend the formatter with an options object:

```ts
formatRecentContextToMarkdown(context, {
  maxChars: DEFAULT_CONTEXT_MAX_CHARS,
  maxItemChars: MAX_ITEM_CONTENT_CHARS,
  includeTags: false,
  includeCommitDetails: false,
});
```

Use a deterministic final truncation marker, never split an unbounded JSON object into the model context.

- [ ] **Step 4: Filter low-value entries before formatting**

Update `getRecentContext` to exclude auto-captured lifecycle items and routine work-loop checkpoints by default, then apply limits after filtering. Keep an explicit `includeEphemeral` option for inspection/debugging.

- [ ] **Step 5: Remove duplicate retrieval instruction**

Update the generated Knowl section in `src/core/agents-guidance.ts`:

- automatic lifecycle bootstrap is the default initial context;
- call `knowl_recent` only when lifecycle hooks are unavailable or an explicit refresh is needed;
- use `knowl_query` for focused follow-up;
- store only durable findings, not every checkpoint/command.

Update CLI guidance tests and regenerate the project section through the normal `knowl init --yes` path in fixtures.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `rtk npm.cmd test -- tests/store/store.test.ts tests/mcp/server.test.ts tests/cli/cli.test.ts -t "recent|context|guidance"`

Expected: PASS; all automatic recent-context surfaces share one bounded compact format.

- [ ] **Step 7: Commit**

```bash
git add src/store/recent-context.ts src/core/format.ts src/mcp/tools.ts src/mcp/resources.ts src/core/agents-guidance.ts tests/store/store.test.ts tests/mcp/server.test.ts tests/cli/cli.test.ts
git commit -m "perf: compact and deduplicate recent context"
```

### Task 5: Enforce retrieval limits globally and fix budget accounting

**Files:**
- Modify: `src/store/queries.ts`
- Modify: `src/store/namespaces.ts`
- Modify: `src/store/context-composer.ts`
- Test: `tests/store/retrieval-evaluation.test.ts`
- Test: `tests/store/namespaces.test.ts`
- Test: `tests/store/context-composer.test.ts`
- Test: `tests/store/store.test.ts`

- [ ] **Step 1: Write failing limit tests**

Cover all paths:

```ts
expect((await queryKnowledgeBase(projectId, { query: 'missing', limit: 2 })).length).toBeLessThanOrEqual(2);
expect((await queryKnowledgeBase(projectId, { asOf, limit: 2 })).length).toBeLessThanOrEqual(2);
expect((await queryLayeredKnowledge(root, 'storage', fourNamespaces, 3)).length).toBeLessThanOrEqual(3);
```

Add a context test where reasoning/tags/provenance would push serialized output over the requested budget; assert the compact returned pack remains within the budget plus the documented envelope allowance.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `rtk npm.cmd test -- tests/store/retrieval-evaluation.test.ts tests/store/namespaces.test.ts tests/store/context-composer.test.ts tests/store/store.test.ts`

Expected: FAIL because SQL fallback/as-of paths ignore `limit`, namespaces multiply the limit, and token estimation omits returned fields.

- [ ] **Step 3: Apply limits at the final boundary**

In `queryKnowledgeBase`, slice fallback and historical results after all filtering. In `queryLayeredKnowledge`, deduplicate first, then slice the combined result to the caller’s limit. Preserve per-namespace candidate fetches only as an internal ranking aid.

- [ ] **Step 4: Make context budgeting serialize what is returned**

Use `compactKnowledgeItem` before estimating/adding items. Estimate the compact serialized text, not only title/content. Omit `excluded` entries by default; expose them only with an explicit explain/debug option.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `rtk npm.cmd test -- tests/store/retrieval-evaluation.test.ts tests/store/namespaces.test.ts tests/store/context-composer.test.ts tests/store/store.test.ts`

Expected: PASS; no retrieval path exceeds the requested result count and context budget is meaningful.

- [ ] **Step 6: Commit**

```bash
git add src/store/queries.ts src/store/namespaces.ts src/store/context-composer.ts tests/store/retrieval-evaluation.test.ts tests/store/namespaces.test.ts tests/store/context-composer.test.ts tests/store/store.test.ts
git commit -m "perf: enforce global retrieval and context budgets"
```

### Task 6: Compact default MCP responses and paginate heavy inspection tools

**Files:**
- Create: `src/mcp/response-format.ts`
- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/resources.ts`
- Test: `tests/mcp/server.test.ts`

- [ ] **Step 1: Write failing response-size tests**

Assert default responses:

- use compact JSON without pretty-print whitespace;
- return compact item DTOs, not full database rows;
- cap evidence/timeline results at a documented default;
- return summary/counts for `knowl_state`, GC, task, and session operations;
- require explicit `detail: 'full'`/`includeContent: true` for large skill/resource payloads.

- [ ] **Step 2: Run focused MCP tests and verify RED**

Run: `rtk npm.cmd test -- tests/mcp/server.test.ts`

Expected: FAIL on current full JSON rows, pretty-print output, and unbounded inspection results.

- [ ] **Step 3: Add shared MCP serializers**

Implement:

```ts
export function compactMcpJson(value: unknown): string;
export function compactItemResponse(item: KnowledgeItem): CompactKnowledgeItem;
export function boundedEvidence(items: Evidence[], limit = DEFAULT_EVIDENCE_LIMIT): unknown[];
```

Use `JSON.stringify(value)` with no indentation. Keep machine-stable keys needed by existing clients.

- [ ] **Step 4: Update high-frequency tools first**

Change `knowl_query`, `knowl_recent`, `knowl_context`, and `knowl_state` defaults to compact/bounded output. Add explicit options only where necessary:

- `knowl_query`: `detail`, `includeEvidence`, `limit` with global cap;
- `knowl_recent`: `maxChars`/`tokenBudget`;
- `knowl_context`: `explain` for excluded items;
- `knowl_state`: category/item limit and overflow counts.

- [ ] **Step 5: Bound low-frequency inspection tools**

Add `limit`/cursor-compatible bounds to timeline, evidence, category resources, and skill reads. Default `knowl_skill_read` to manifest/summary; full package content is explicit.

- [ ] **Step 6: Reduce tool-schema verbosity**

Shorten repetitive descriptions in `src/mcp/tools.ts`; move workflow policy to AGENTS guidance. Preserve argument names, required fields, enums, and security warnings. Do not remove tools in this task.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run: `rtk npm.cmd test -- tests/mcp/server.test.ts`

Expected: PASS; parsed semantic payloads remain compatible while serialized responses are materially smaller.

- [ ] **Step 8: Commit**

```bash
git add src/mcp/response-format.ts src/mcp/tools.ts src/mcp/resources.ts tests/mcp/server.test.ts
git commit -m "perf: compact and bound MCP responses"
```

### Task 7: Add token-budget regression coverage and documentation

**Files:**
- Create: `tests/performance/token-budget.test.ts`
- Modify: `README.md`
- Modify: `src/core/agents-guidance.ts` (if wording remains after Task 4/6)
- Test: `tests/cli/cli.test.ts`

- [ ] **Step 1: Add end-to-end budget assertions**

Measure actual strings returned by:

- Codex SessionStart/UserPromptSubmit hooks;
- `knowl_recent`, `knowl_query`, `knowl_context`, `knowl_state`;
- `knowl://recent` resource.

Assert documented upper bounds and assert repeated UserPromptSubmit output is empty.

- [ ] **Step 2: Document the delivery policy**

README must state:

- initial context is delivered once per host session;
- explicit `knowl_recent`/detail options can request more;
- routine lifecycle events are ephemeral;
- default MCP responses are compact and bounded.

- [ ] **Step 3: Run the focused regression suite**

Run: `rtk npm.cmd test -- tests/performance/token-budget.test.ts tests/cli/agent-lifecycle.test.ts tests/mcp/server.test.ts`

Expected: PASS with stable budgets.

- [ ] **Step 4: Commit**

```bash
git add tests/performance/token-budget.test.ts README.md src/core/agents-guidance.ts tests/cli/cli.test.ts
git commit -m "test: lock token-efficient delivery budgets"
```

### Task 8: Full verification and rollout check

**Files:**
- No new production files; review all task diffs.

- [ ] **Step 1: Run the full serial suite**

Run: `rtk npm.cmd test -- --maxWorkers=1 --testTimeout=15000`

Expected: all tests pass; record the exact count.

- [ ] **Step 2: Build and diff check**

Run:

```bash
rtk npm.cmd run build
rtk proxy git diff --check
```

Expected: build exit `0`; no whitespace errors.

- [ ] **Step 3: Verify live Codex hook behavior**

Run a live `knowl.cmd` smoke check:

- `SessionStart` returns one bounded `hookSpecificOutput.additionalContext`;
- `UserPromptSubmit` returns empty stdout;
- `PostToolUse` with multi-megabyte ignored output exits `0` and returns empty stdout;
- `Stop` exits `0` with empty stdout.

- [ ] **Step 4: Review token deltas**

Compare before/after character counts for the same fixture. Confirm no response became larger unless an explicit full-detail option was used.

- [ ] **Step 5: Commit the integrated result**

```bash
rtk git status --short
rtk git add docs/superpowers/plans/2026-07-11-token-efficient-memory-delivery.md
git commit -m "docs: plan token-efficient memory delivery"
```

## Rollout order

1. Tasks 1–2: immediate repeated-context reduction.
2. Task 3: stop memory-growth feedback loop.
3. Tasks 4–5: compact recent context + enforce retrieval/budget correctness.
4. Task 6: reduce MCP response/tool-schema overhead.
5. Tasks 7–8: lock budgets, verify live hooks, then ship.

## Risk controls

- Preserve explicit full-detail inspection paths.
- Keep event capture bounded/secret-filtered; only change promotion and delivery.
- Add tests before each behavior change; do not rely on output snapshots alone.
- Treat a failed full suite separately from known timeout/provider flakes; rerun isolated with the documented timeout before attributing regressions.
