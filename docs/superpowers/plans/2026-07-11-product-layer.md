# Product Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add code-symbol evidence, synthesized project understanding, layered namespaces, a local viewer, and portable import/export after core trust and intelligence features are stable.

**Architecture:** Structural code data lives outside knowledge atoms. Synthesized items retain evidence/source links. Namespaces use separate physical stores with explicit precedence. The viewer and import/export call existing repository services instead of implementing alternate storage logic.

**Tech Stack:** TypeScript, SQLite/libSQL, Tree-sitter for TypeScript/JavaScript first, Node HTTP server/static assets, Commander, existing MCP/repository services, Vitest.

---

### Task 1: Add the incremental code-symbol index

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/core/types.ts`
- Modify: `src/store/schema.ts`
- Modify: `src/store/bootstrap.ts`
- Create: `src/code/symbol-index.ts`
- Create: `src/code/languages.ts`
- Test: `tests/code/symbol-index.test.ts`

- [ ] **Step 1: Write failing symbol-index tests**

Index a TypeScript fixture and assert files, functions, classes, methods, imports, exports, line ranges, symbol locators, and file hashes. Modify one file and assert only that file reindexes. Delete a file and assert its symbols/edges disappear.

- [ ] **Step 2: Run focused test and verify failure**

Run: `rtk npm.cmd test -- tests/code/symbol-index.test.ts`

Expected: FAIL because the index and dependencies do not exist.

- [ ] **Step 3: Add parser dependencies and schema**

Add `tree-sitter` and TypeScript/JavaScript grammar packages compatible with the supported Node version. Create `code_files`, `code_symbols`, and `code_symbol_edges` with file-hash and locator indexes. Keep symbol data separate from `knowledge_items`.

- [ ] **Step 4: Implement incremental extraction**

Support `.ts`, `.tsx`, `.js`, and `.jsx` first. Emit stable locators `symbol://<relative-path>#<qualified-name>`, line ranges, kind, signature summary, and import/export edges. Skip ignored/binary/generated directories using Git ignore information.

- [ ] **Step 5: Run focused tests and commit**

Run: `rtk npm.cmd test -- tests/code/symbol-index.test.ts`

Expected: PASS.

```bash
rtk git add package.json package-lock.json src/core/types.ts src/store/schema.ts src/store/bootstrap.ts src/code/symbol-index.ts src/code/languages.ts tests/code/symbol-index.test.ts
rtk git commit -m "feat: add incremental code symbol index"
```

### Task 2: Connect symbols to evidence and drift

**Files:**
- Modify: `src/store/evidence-repository.ts`
- Modify: `src/store/drift.ts`
- Modify: `src/index.ts`
- Test: `tests/store/evidence-repository.test.ts`
- Test: `tests/cli/cli.test.ts`

- [ ] **Step 1: Write failing integration tests**

Attach `symbol://` evidence to an item, rename/change the symbol, reindex, and assert evidence becomes stale with a suggested replacement when unambiguous. Test `knowl code index` and `knowl code symbols <path>`.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `rtk npm.cmd test -- tests/store/evidence-repository.test.ts tests/cli/cli.test.ts`

Expected: FAIL because symbol evidence does not resolve.

- [ ] **Step 3: Implement symbol evidence resolution**

Resolve locators through the symbol index, compare stored content/signature hashes, and mark evidence stale without mutating knowledge content. Replacement suggestions require same file/kind and strong normalized-name/signature similarity.

- [ ] **Step 4: Verify and commit**

Run: `rtk npm.cmd test -- tests/store/evidence-repository.test.ts tests/cli/cli.test.ts`; `rtk npm.cmd run build`

Expected: PASS.

```bash
rtk git add src/store/evidence-repository.ts src/store/drift.ts src/index.ts tests/store/evidence-repository.test.ts tests/cli/cli.test.ts
rtk git commit -m "feat: link knowledge evidence to code symbols"
```

### Task 3: Add synthesized project understanding

**Files:**
- Create: `src/store/synthesis.ts`
- Modify: `src/core/types.ts`
- Modify: `src/store/knowledge-writer.ts`
- Modify: `src/mcp/tools.ts`
- Test: `tests/store/synthesis.test.ts`

- [ ] **Step 1: Write failing synthesis tests**

Given durable architecture/decision/evidence items for one module, assert deterministic source grouping, bounded source context, one synthesized item with `derived_from` links, replacement on source change, and no synthesis from scratch-only or stale unsupported data.

- [ ] **Step 2: Run focused test and verify failure**

Run: `rtk npm.cmd test -- tests/store/synthesis.test.ts`

Expected: FAIL because synthesis does not exist.

- [ ] **Step 3: Implement synthesis service**

Group by module/path/tag, require at least two durable supporting items, and create a compact `architecture` item tagged `synthesized`. Deterministic mode concatenates normalized claims; optional AI mode uses one bounded structured-output call. Preserve all `derived_from` evidence and source item IDs.

- [ ] **Step 4: Add MCP/CLI trigger and commit**

Expose `knowl synthesize --scope <path-or-tag>` and `knowl_synthesize`. Never run synthesis per normal write.

Run: `rtk npm.cmd test -- tests/store/synthesis.test.ts tests/mcp/server.test.ts`; `rtk npm.cmd run build`

Expected: PASS.

```bash
rtk git add src/store/synthesis.ts src/core/types.ts src/store/knowledge-writer.ts src/mcp/tools.ts tests/store/synthesis.test.ts tests/mcp/server.test.ts
rtk git commit -m "feat: synthesize evidence-backed project understanding"
```

### Task 4: Implement layered namespaces

**Files:**
- Create: `src/store/namespaces.ts`
- Modify: `src/store/database.ts`
- Modify: `src/store/agent-query.ts`
- Modify: `src/store/context-composer.ts`
- Modify: `src/core/config.ts`
- Modify: `src/cli/config/schema.ts`
- Test: `tests/store/namespaces.test.ts`

- [ ] **Step 1: Write failing namespace tests**

Create separate session, project, organization, and global stores. Assert physical separation, explicit write targets, read precedence, namespace labels, project-default writes, duplicate handling across layers, and failure isolation when an optional upper layer is unavailable.

- [ ] **Step 2: Run focused test and verify failure**

Run: `rtk npm.cmd test -- tests/store/namespaces.test.ts`

Expected: FAIL because namespace routing does not exist.

- [ ] **Step 3: Implement store descriptors and layered reads**

Define `MemoryNamespace = 'session' | 'project' | 'organization' | 'global'`. Keep one database per namespace; do not attach/merge databases. Query each enabled store, annotate results, fuse with project precedence for equal relevance, and require an explicit namespace for non-project writes.

- [ ] **Step 4: Add safe configuration**

Store only paths/enabled flags in project config. Organization/global locations must be outside the project database and resolved without credentials. Default configuration enables project/session only.

- [ ] **Step 5: Run focused tests and commit**

Run: `rtk npm.cmd test -- tests/store/namespaces.test.ts`; `rtk npm.cmd run build`

Expected: PASS.

```bash
rtk git add src/store/namespaces.ts src/store/database.ts src/store/agent-query.ts src/store/context-composer.ts src/core/config.ts src/cli/config/schema.ts tests/store/namespaces.test.ts
rtk git commit -m "feat: add layered memory namespaces"
```

### Task 5: Add portable import/export

**Files:**
- Create: `src/store/portability.ts`
- Modify: `src/index.ts`
- Test: `tests/store/portability.test.ts`
- Test: `tests/cli/cli.test.ts`

- [ ] **Step 1: Write failing portability tests**

Export items, assertions, evidence, links, conflict identity, skills, and namespace metadata to versioned JSONL. Import into an empty store, verify hashes/counts/relationships, reject secrets through Plan 1, and support dry-run conflict reporting without mutation.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `rtk npm.cmd test -- tests/store/portability.test.ts tests/cli/cli.test.ts`

Expected: FAIL because portability service/commands do not exist.

- [ ] **Step 3: Implement streaming format**

Use a header record with format/schema versions followed by typed records. Export deterministic ordering and SHA-256 manifest. Import validates the entire stream, reports inserts/updates/conflicts/skips, then applies in one transaction per namespace.

- [ ] **Step 4: Add CLI commands and commit**

Add `knowl export <path> [--namespace project]` and `knowl import <path> [--dry-run] [--namespace project]`. Import never auto-resolves exclusive conflicts.

Run: `rtk npm.cmd test -- tests/store/portability.test.ts tests/cli/cli.test.ts`

Expected: PASS.

```bash
rtk git add src/store/portability.ts src/index.ts tests/store/portability.test.ts tests/cli/cli.test.ts
rtk git commit -m "feat: add verified memory import and export"
```

### Task 6: Build the local read-first viewer

**Files:**
- Create: `src/viewer/server.ts`
- Create: `src/viewer/api.ts`
- Create: `src/viewer/assets/index.html`
- Create: `src/viewer/assets/app.js`
- Create: `src/viewer/assets/styles.css`
- Modify: `src/index.ts`
- Test: `tests/viewer/server.test.ts`

- [ ] **Step 1: Write failing API/server tests**

Test localhost-only binding, random/default port handling, CSRF-safe mutation refusal, JSON endpoints for current brain/timeline/decisions/stale/conflicts/evidence/retrieval/access/skills, and graceful shutdown. Assert no endpoint returns configured secrets or raw session events by default.

- [ ] **Step 2: Run focused test and verify failure**

Run: `rtk npm.cmd test -- tests/viewer/server.test.ts`

Expected: FAIL because viewer modules do not exist.

- [ ] **Step 3: Implement read APIs using existing services**

Use Node `http`; bind `127.0.0.1` only. API handlers call repository/context/evidence/timeline/conflict/access services. Do not execute SQL directly from viewer modules. Return bounded pagination and score explanations for the retrieval debugger.

- [ ] **Step 4: Implement minimal static UI**

Create navigation for Current Brain, Timeline, Decisions, Stale, Conflicts, Evidence, Retrieval, Access, and Skills. Use plain HTML/CSS/JS; no frontend framework dependency. Viewer is read-only in this plan.

- [ ] **Step 5: Add `knowl view` and commit**

Run: `rtk npm.cmd test -- tests/viewer/server.test.ts tests/cli/cli.test.ts`; `rtk npm.cmd run build`

Expected: PASS; CLI prints the exact localhost URL and shuts down cleanly on SIGINT.

```bash
rtk git add src/viewer src/index.ts tests/viewer/server.test.ts tests/cli/cli.test.ts
rtk git commit -m "feat: add local Knowl memory viewer"
```

### Task 7: Product-layer verification checkpoint

**Files:**
- Modify: `README.md`
- Modify: `src/cli/doctor-report.ts`
- Modify: `docs/evals/retrieval-baseline.json`

- [ ] **Step 1: Document symbols, synthesis, namespaces, portability, and viewer**

Include namespace precedence and security boundaries. Mark team synchronization as deferred until import/export and namespace behavior have production usage.

- [ ] **Step 2: Extend doctor**

Report symbol index readiness, enabled namespace stores, viewer availability, and import/export format version. Optional unavailable namespaces are warnings, not project-readiness failures.

- [ ] **Step 3: Run complete verification**

Run: `rtk npm.cmd test`; `rtk npm.cmd run build`; `rtk git diff --check`; `node dist/index.js eval retrieval --dataset docs/evals/retrieval-baseline.json --json`

Expected: PASS; benchmark shows namespace/synthesis additions do not increase forbidden or stale retrieval errors.

- [ ] **Step 4: Store the completed-plan outcome in Knowl**

Record supported languages, symbol locator format, synthesis rules, namespace precedence, export format version, viewer command, verification metrics, and commit hash.
