# Evidence and Provenance Implementation Plan

> **Status:** Completed 2026-07-11. Verification: `rtk npm.cmd test` (127 tests), `rtk npm.cmd run build`, `rtk git diff --check`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let every durable knowledge item cite multiple inspectable sources, including files, symbols, commits, tests, commands, URLs, users, and agents.

**Architecture:** Evidence is an independent row with a stable ID, locator, safe excerpt, hash, timestamp, and metadata. A join table links evidence to knowledge items with `supports`, `contradicts`, or `derived_from`. Existing `source`, `sourceCommit`, and `affectedPaths` remain compatibility fields and are mirrored into evidence when available.

**Tech Stack:** TypeScript, Drizzle/libSQL schema bootstrap, repository services, Commander, MCP, Vitest.

---

### Task 1: Add evidence types and schema

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/store/schema.ts`
- Modify: `src/store/bootstrap.ts`
- Test: `tests/store/store.test.ts`

- [ ] **Step 1: Write failing schema/type tests**

Assert a fresh database creates `evidence` and `knowledge_evidence`, both tables are idempotent on a second bootstrap, the relationship enum accepts only the three planned values, and deleting a knowledge item removes links while deleting evidence removes links.

- [ ] **Step 2: Run focused test and verify failure**

Run: `rtk npm.cmd test -- tests/store/store.test.ts -t evidence`

Expected: FAIL because the tables/types do not exist.

- [ ] **Step 3: Define the public types**

Add:

```ts
export type EvidenceType = 'file' | 'symbol' | 'commit' | 'test' | 'command' | 'url' | 'user' | 'agent';
export type EvidenceRelationship = 'supports' | 'contradicts' | 'derived_from';

export interface Evidence {
  id: string;
  type: EvidenceType;
  locator: string;
  contentHash?: string | null;
  excerpt?: string | null;
  observedAt: string;
  metadata?: Record<string, unknown> | null;
}

export interface KnowledgeEvidence {
  knowledgeItemId: string;
  evidenceId: string;
  relationship: EvidenceRelationship;
}
```

- [ ] **Step 4: Add SQL and Drizzle definitions**

Create `evidence(id, type, locator, content_hash, excerpt, observed_at, metadata)` and `knowledge_evidence(knowledge_item_id, evidence_id, relationship)` with composite primary key and cascading foreign keys. Add indexes on locator, type, observed time, and relationship. Make bootstrap add the tables without changing existing item IDs.

- [ ] **Step 5: Run focused tests and commit**

Run: `rtk npm.cmd test -- tests/store/store.test.ts -t evidence`

Expected: PASS.

```bash
rtk git add src/core/types.ts src/store/schema.ts src/store/bootstrap.ts tests/store/store.test.ts
rtk git commit -m "feat: add evidence and provenance schema"
```

### Task 2: Implement evidence repository operations

**Files:**
- Create: `src/store/evidence-repository.ts`
- Modify: `src/store/repository.ts`
- Test: `tests/store/evidence-repository.test.ts`

- [ ] **Step 1: Write failing repository tests**

Cover create-or-reuse by `(type, locator, contentHash)`, safe excerpt length limits, link/unlink, list by item, list by evidence, and stale detection when a file evidence hash no longer matches the current file hash.

- [ ] **Step 2: Run focused test and verify failure**

Run: `rtk npm.cmd test -- tests/store/evidence-repository.test.ts`

Expected: FAIL because the repository module does not exist.

- [ ] **Step 3: Implement repository APIs**

Expose:

```ts
createEvidence(input: Omit<Evidence, 'id'>): Promise<Evidence>;
linkKnowledgeEvidence(input: KnowledgeEvidence): Promise<void>;
listEvidenceForItem(itemId: string): Promise<Array<Evidence & { relationship: EvidenceRelationship }>>;
unlinkKnowledgeEvidence(itemId: string, evidenceId: string): Promise<void>;
```

Normalize locators, cap excerpts at a fixed safe length, run the Plan 1 validator on excerpts/metadata strings, and keep writes transactional.

- [ ] **Step 4: Run focused tests and commit**

Run: `rtk npm.cmd test -- tests/store/evidence-repository.test.ts`

Expected: PASS.

```bash
rtk git add src/store/evidence-repository.ts src/store/repository.ts tests/store/evidence-repository.test.ts
rtk git commit -m "feat: add evidence repository services"
```

### Task 3: Attach evidence during structured writes

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/store/repository.ts`
- Modify: `src/store/knowledge-actions.ts`
- Modify: `src/store/knowledge-writer.ts`
- Modify: `src/pipeline/derive.ts`
- Test: `tests/store/evidence-repository.test.ts`
- Test: `tests/pipeline/pipeline.test.ts`

- [ ] **Step 1: Add failing structured-write tests**

Pass an evidence array to a direct decision and to a deduplicated atom batch. Assert new evidence is created, linked with the requested relationship, and preserved when the item is updated. Assert duplicate evidence reuses one evidence row.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `rtk npm.cmd test -- tests/store/evidence-repository.test.ts tests/pipeline/pipeline.test.ts`

Expected: FAIL because `KnowledgeAtom` and direct-write inputs do not accept evidence.

- [ ] **Step 3: Add optional evidence input and transactional linking**

Add `evidence?: Array<Omit<Evidence, 'id'>> & { relationship?: EvidenceRelationship }` to write inputs. Create the knowledge item, create/reuse evidence, and insert links in the same transaction. Preserve legacy writes with no evidence. When `sourceCommit` or `affectedPaths` is present and no explicit evidence was supplied, create compatibility evidence records for the commit/path metadata.

- [ ] **Step 4: Run focused tests and commit**

Run: `rtk npm.cmd test -- tests/store/evidence-repository.test.ts tests/pipeline/pipeline.test.ts`

Expected: PASS.

```bash
rtk git add src/core/types.ts src/store/repository.ts src/store/knowledge-actions.ts src/store/knowledge-writer.ts src/pipeline/derive.ts tests/store/evidence-repository.test.ts tests/pipeline/pipeline.test.ts
rtk git commit -m "feat: attach provenance evidence to knowledge writes"
```

### Task 4: Expose evidence through CLI/MCP and drift checks

**Files:**
- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/resources.ts`
- Modify: `src/index.ts`
- Modify: `src/store/drift.ts`
- Test: `tests/mcp/server.test.ts`
- Test: `tests/cli/cli.test.ts`

- [ ] **Step 1: Write failing surface tests**

Test `knowl_evidence_list`, `knowl evidence list <item-id>`, and evidence included by `knowl_query` only when requested. Test drift marks file/symbol evidence stale when the content hash changes, without changing the knowledge item’s current text.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `rtk npm.cmd test -- tests/mcp/server.test.ts tests/cli/cli.test.ts`

Expected: FAIL because the new tool/command and stale evidence mapping do not exist.

- [ ] **Step 3: Implement minimal read surfaces**

Add a list operation with item ID, relationship, type, locator, excerpt, hash, observed time, and stale status. Keep default query payload compact; evidence is opt-in through `includeEvidence`. Reuse the existing MCP project initialization path and CLI formatting conventions.

- [ ] **Step 4: Verify and commit**

Run: `rtk npm.cmd test -- tests/mcp/server.test.ts tests/cli/cli.test.ts`; `rtk npm.cmd run build`; `rtk git diff --check`

Expected: PASS.

```bash
rtk git add src/mcp/tools.ts src/mcp/resources.ts src/index.ts src/store/drift.ts tests/mcp/server.test.ts tests/cli/cli.test.ts
rtk git commit -m "feat: expose knowledge evidence and provenance"
```

### Task 5: Plan completion checkpoint

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document evidence types, relationships, and opt-in retrieval**

Include one safe example with file lines, a commit, and a passing test. Do not include credentials or raw command output.

- [ ] **Step 2: Run full verification**

Run: `rtk npm.cmd test`; `rtk npm.cmd run build`; `rtk git diff --check`

Expected: PASS.

- [ ] **Step 3: Store the completed-plan outcome in Knowl**

Record the evidence tables, repository APIs, stale-hash behavior, and verification commit as a concise implementation state item.
