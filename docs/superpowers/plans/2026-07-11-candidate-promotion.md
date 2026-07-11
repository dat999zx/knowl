# Session Candidate Promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert completed session evidence into a small, validated set of durable knowledge candidates without relying on the agent to remember write-back.

**Architecture:** The finalizer reads terminal session events, Git state, and work-loop results; produces deterministic candidates first; optionally asks one configured model to refine the bounded candidate set; then validates, deduplicates, attaches evidence, and promotes at most five atoms in one knowledge commit.

**Tech Stack:** TypeScript, existing knowledge writer/pipeline, Git CLI, evidence repository, session repository, optional existing AI provider, Vitest.

**Status:** Complete — verified 2026-07-11.

---

### Task 1: Define candidate types and deterministic extraction

**Files:**
- Modify: `src/core/types.ts`
- Create: `src/store/session-candidates.ts`
- Test: `tests/store/session-candidates.test.ts`

- [ ] **Step 1: Write failing extraction tests**

Create sessions for: successful changed files/tests, failed command with recurring error, explicit decision event, no-op session, and transcript-like noise. Assert candidate categories, titles, content bounds, confidence, evidence locators, and maximum count.

- [ ] **Step 2: Run focused test and verify failure**

Run: `rtk npm.cmd test -- tests/store/session-candidates.test.ts`

Expected: FAIL because candidate types/extractor do not exist.

- [ ] **Step 3: Define candidate contract**

```ts
export interface MemoryCandidate extends KnowledgeAtom {
  candidateType: 'outcome' | 'decision' | 'error' | 'verified-command' | 'task-state';
  sessionId: string;
  evidence: Array<{
    type: EvidenceType;
    locator: string;
    relationship: EvidenceRelationship;
    excerpt?: string;
    contentHash?: string;
  }>;
}
```

- [ ] **Step 4: Implement deterministic extraction**

Rules:

- explicit decision event -> `decision` candidate;
- successful test event plus changed paths -> `state` outcome candidate;
- repeated matching errors -> scratch/error candidate eligible only above confidence threshold;
- successful command marked reusable -> `skill` or `fact` verified-command candidate;
- incomplete/failing task -> one `state` checkpoint candidate;
- no durable signal -> zero candidates.

Deduplicate within the session by normalized title/content and cap output at five candidates ordered decision, constraint, outcome, verified command, task state.

- [ ] **Step 5: Run focused tests and commit**

Run: `rtk npm.cmd test -- tests/store/session-candidates.test.ts`

Expected: PASS.

```bash
rtk git add src/core/types.ts src/store/session-candidates.ts tests/store/session-candidates.test.ts
rtk git commit -m "feat: derive deterministic session memory candidates"
```

### Task 2: Collect Git and test evidence safely

**Files:**
- Create: `src/store/session-evidence.ts`
- Modify: `src/store/drift.ts`
- Test: `tests/store/session-evidence.test.ts`

- [ ] **Step 1: Write failing evidence-collection tests**

Use a temporary Git repository. Assert collection of baseline/current commits, changed paths, diff stat, safe excerpts, and test command/result. Assert `.env`, ignored credential files, binary files, and oversized diffs are excluded.

- [ ] **Step 2: Run focused test and verify failure**

Run: `rtk npm.cmd test -- tests/store/session-evidence.test.ts`

Expected: FAIL because the collector does not exist.

- [ ] **Step 3: Implement bounded collection**

Use `git diff --name-only`, `git diff --stat`, and `git rev-parse`; never store full diffs by default. Build file evidence locators with repository-relative paths and content hashes. Reuse Plan 1 path/secret validation and Plan 2 evidence types.

- [ ] **Step 4: Run focused tests and commit**

Run: `rtk npm.cmd test -- tests/store/session-evidence.test.ts`

Expected: PASS.

```bash
rtk git add src/store/session-evidence.ts src/store/drift.ts tests/store/session-evidence.test.ts
rtk git commit -m "feat: collect bounded session evidence"
```

### Task 3: Implement transactional promotion

**Files:**
- Create: `src/store/candidate-promotion.ts`
- Modify: `src/store/knowledge-writer.ts`
- Modify: `src/store/session-repository.ts`
- Test: `tests/store/candidate-promotion.test.ts`

- [ ] **Step 1: Write failing promotion tests**

Assert guard rejection stores nothing, duplicate candidates reuse/update according to existing writer behavior, evidence links are atomic, one knowledge commit records all promoted items, low-confidence errors remain scratch, and rerunning finalization is idempotent.

- [ ] **Step 2: Run focused test and verify failure**

Run: `rtk npm.cmd test -- tests/store/candidate-promotion.test.ts`

Expected: FAIL because the promotion service does not exist.

- [ ] **Step 3: Implement promotion states**

Add session finalization metadata: `finalizedAt`, `promotionStatus` (`pending`, `promoted`, `skipped`, `failed`), and safe `promotionErrorCode`. Promote candidates through `storeKnowledgeAtomsDeduped`, create/reuse evidence, and create one commit message `Finalize memory session: <title>`.

- [ ] **Step 4: Guarantee idempotency**

Use session ID plus candidate content hash as a promotion key. If a session is already promoted, return existing item IDs. A partial transaction must roll back items, evidence links, commit, and promotion state.

- [ ] **Step 5: Run focused tests and commit**

Run: `rtk npm.cmd test -- tests/store/candidate-promotion.test.ts`

Expected: PASS.

```bash
rtk git add src/store/candidate-promotion.ts src/store/knowledge-writer.ts src/store/session-repository.ts tests/store/candidate-promotion.test.ts
rtk git commit -m "feat: promote validated session candidates"
```

### Task 4: Add the session finalizer and optional bounded synthesis

**Files:**
- Create: `src/store/session-finalizer.ts`
- Modify: `src/ai/prompts.ts`
- Modify: `src/ai/schemas.ts`
- Modify: `src/ai/provider.ts`
- Test: `tests/store/session-finalizer.test.ts`

- [ ] **Step 1: Write failing finalizer tests**

Cover deterministic-only mode, configured-AI refinement, invalid model output fallback, crash-recovered sessions, zero-candidate sessions, and no more than one AI call per session finalization.

- [ ] **Step 2: Run focused test and verify failure**

Run: `rtk npm.cmd test -- tests/store/session-finalizer.test.ts`

Expected: FAIL because the finalizer does not exist.

- [ ] **Step 3: Implement deterministic-first finalization**

Load the terminal session, collect evidence, extract candidates, validate, and promote. If AI is configured and `memory.autoSynthesis` is enabled, send only the bounded candidate summaries/evidence metadata to one structured-output call. The model may merge/rephrase candidates but may not add unsupported facts or remove evidence requirements.

- [ ] **Step 4: Add fallback behavior**

On AI timeout/schema failure, promote deterministic candidates. On guard/evidence failure, mark promotion failed with a safe code and leave scratch events until TTL so recovery can retry.

- [ ] **Step 5: Run focused tests and commit**

Run: `rtk npm.cmd test -- tests/store/session-finalizer.test.ts`

Expected: PASS.

```bash
rtk git add src/store/session-finalizer.ts src/ai/prompts.ts src/ai/schemas.ts src/ai/provider.ts tests/store/session-finalizer.test.ts
rtk git commit -m "feat: finalize sessions into durable knowledge"
```

### Task 5: Wire finalization into CLI/MCP/work loops

**Files:**
- Modify: `src/index.ts`
- Modify: `src/mcp/tools.ts`
- Modify: `src/store/work-loop.ts`
- Test: `tests/cli/session-cli.test.ts`
- Test: `tests/mcp/server.test.ts`

- [ ] **Step 1: Write failing integration tests**

Assert `session finish`, successful/failed `task run`, and recovered sessions invoke finalization once and report promoted item IDs or a safe skip reason. Add `--no-promote` for diagnostic runs.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `rtk npm.cmd test -- tests/cli/session-cli.test.ts tests/mcp/server.test.ts`

Expected: FAIL because finalization is not wired.

- [ ] **Step 3: Implement integration**

Default normal session finish to automatic finalization. Keep `session event` cheap. MCP adds `knowl_session_finish` with `promote` defaulting true; do not add separate tools for internal extraction steps.

- [ ] **Step 4: Verify and commit**

Run: `rtk npm.cmd test -- tests/cli/session-cli.test.ts tests/mcp/server.test.ts`; `rtk npm.cmd test`; `rtk npm.cmd run build`; `rtk git diff --check`

Expected: PASS.

```bash
rtk git add src/index.ts src/mcp/tools.ts src/store/work-loop.ts tests/cli/session-cli.test.ts tests/mcp/server.test.ts
rtk git commit -m "feat: automate session memory promotion"
```

### Task 6: Plan completion checkpoint

**Files:**
- Modify: `README.md`
- Modify: `src/cli/doctor-report.ts`

- [ ] **Step 1: Document candidate rules and deterministic fallback**

State the five-candidate cap, evidence requirement, optional one-call synthesis, and idempotent retry behavior.

- [ ] **Step 2: Store the completed-plan outcome in Knowl**

Record finalizer entrypoints, candidate cap/order, AI fallback semantics, promotion idempotency, and verification commit.
