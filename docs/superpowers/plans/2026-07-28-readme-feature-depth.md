# README Feature Depth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore complete, current feature documentation to `README.md` without reintroducing
competitor commentary, conversational filler, or stale claims.

**Architecture:** Keep one layered README with fast onboarding first and detailed feature
workflows below it. Treat current source, tests, changelog, and checked-in benchmark artifacts as
the authority; use the pre-rewrite README only as a coverage inventory.

**Tech Stack:** Markdown, Mermaid, SVG, Node.js CLI/MCP implementation, Vitest, PowerShell
verification scripts.

---

### Task 1: Establish the final README structure

**Files:**
- Modify: `README.md`
- Reference: `docs/superpowers/specs/2026-07-28-readme-feature-depth-design.md`

- [ ] **Step 1: Preserve the verified orientation material**

Keep the current hero, badges, overview, quick start, workspace setup, benchmark result values,
CLI inventory, MCP inventory, local-data section, and license.

- [ ] **Step 2: Replace the capability-table-only treatment with a layered outline**

The README must contain these top-level chapters in this order:

```text
Overview
Quick start
Core knowledge model
Retrieval and context
Tasks, sessions, and agent lifecycle
Evidence, code intelligence, and drift
Workspaces
Learned skills and synthesis
Portability and maintenance
Local viewer
Architecture and security boundaries
Agent setup
Benchmarks
CLI reference
MCP tools and resources
Optional AI
Local data
License
```

- [ ] **Step 3: Keep navigation useful**

Update the hero navigation links so they point to the main workflows and references. Do not add
an exhaustive table of contents that duplicates every third-level heading.

- [ ] **Step 4: Verify the outline**

Run:

```powershell
rg -n '^## ' README.md
```

Expected: every required top-level chapter appears once, in the required order.

### Task 2: Restore the core model, governance, and retrieval chapters

**Files:**
- Modify: `README.md`
- Reference: `src/core/types.ts`
- Reference: `src/store/knowledge-writer.ts`
- Reference: `src/store/agent-query.ts`
- Reference: `src/store/context-composer.ts`
- Reference: `src/store/write-embedding.ts`

- [ ] **Step 1: Document structured atoms and metadata**

Add the seven-category table and explain status, freshness, confidence, tags, source metadata,
affected paths, assertions, evidence, repository ownership, and knowledge commits.

- [ ] **Step 2: Document governed writes and current truth**

State the deterministic validation boundary and the category-neutral reconciliation contract:
exact title/content no-op, explicit `supersedes`, title-containment same-subject supersession,
reported coexistence for other overlaps, and pre-insert exclusive-conflict rejection.

Include a decision example and correction workflow using the exact CLI/MCP surfaces that exist.

- [ ] **Step 3: Document retrieval behavior**

Explain vector-primary ranking, bounded BM25 fallback, exact identifiers, freshness/status/
confidence/recency adjustments, active-item filtering, current versus `--as-of` retrieval, and
timeline assertions.

Include:

```bash
knowl query "auth token design"
knowl query "sqlite persistence" --as-of 2026-01-01T00:00:00Z
knowl reindex --vectors
knowl config set search.vector.enabled false
```

State the exact model-setup and fallback behavior plus
`KNOWL_SKIP_MODEL_DOWNLOAD=1` and `KNOWL_DISABLE_WRITE_EMBEDDING=1`.

- [ ] **Step 4: Document bounded context**

Show `knowl context --query ... --task ... --token-budget ...`. Explain pinned constraints,
budget exclusions, and the current session-plus-project scope without claiming organization or
global context composition.

- [ ] **Step 5: Verify exact commands and stale-claim exclusions**

Run:

```powershell
rg -n "reindex --vectors|search.vector.enabled|KNOWL_SKIP_MODEL_DOWNLOAD|KNOWL_DISABLE_WRITE_EMBEDDING|--as-of|token-budget" README.md
rg -ni "lazy download|decisions and state auto|facts.*always coexist" README.md
```

Expected: the first command finds all current controls; the stale-claim search returns no
matches.

### Task 3: Restore lifecycle, evidence, skills, and workspace depth

**Files:**
- Modify: `README.md`
- Reference: `src/store/host-lifecycle.ts`
- Reference: `src/store/change-watermark.ts`
- Reference: `src/store/session-repository.ts`
- Reference: `src/cli/agents/hosts/`
- Reference: `src/store/evidence-repository.ts`
- Reference: `src/code/`
- Reference: `src/skills/`
- Reference: `src/workspace/`

- [ ] **Step 1: Document automatic and manual work loops**

Show `knowl task run` and a complete start/checkpoint/finish workflow. Explain verified-hook
ownership, bounded session scratch, recovery, failure checkpoints, hard-failure handoffs, and
deterministic candidate promotion without raw transcript retention. State the eight-candidate cap
and distinguish promoted `skill` atoms from executable file-backed skill packages.

- [ ] **Step 2: Document host and subagent behavior**

Add a host matrix for Codex, Claude Code, Cursor, Gemini CLI, and Claude Desktop. Explain
main-session bootstrap, half-budget subagent bootstrap where supported, per-agent bindings,
watermarks, own-write suppression, change cards, the 12-event reminder, and Cursor's upstream
delivery limitation.

- [ ] **Step 3: Document evidence, code intelligence, drift, and access**

Explain evidence types and relationships, file-hash staleness, `symbol://` evidence,
Tree-sitter-supported extensions, `knowl code index`, `knowl code symbols`, `knowl pr check`,
retrieval feedback, and `knowl access report`.

- [ ] **Step 4: Expand workspace behavior**

Keep the setup commands and add separate-database federation, external manifests, ownership,
promotion, read-only peers, repository labels, embedding identity, explicit-query fan-out, local
implicit contexts, graceful peer failure, and shipped limits. Include the current limitation that
post-join writes lack `origin_repo` ownership and cannot be promoted until ownership is repaired.

- [ ] **Step 5: Document learned skills and synthesis**

Show the package layout and create/list/read/run workflow. Explain inspected entrypoints, safe
paths, run metadata, and deterministic tag-scoped synthesis.

- [ ] **Step 6: Verify required lifecycle and workspace boundaries**

Run:

```powershell
rg -n "12 consecutive|48 hours|seven days|half.*budget|own writes|read-only|no live|tag-scoped|symbol://" README.md
rg -ni "shared database|workspace.*as-of|context.*organization|context.*global" README.md
```

Expected: current boundaries are present; no result claims a shared workspace database,
cross-workspace historical retrieval, or unsupported context namespaces.

### Task 4: Restore portability, maintenance, viewer, architecture, and AI boundaries

**Files:**
- Modify: `README.md`
- Reference: `src/store/portability.ts`
- Reference: `src/store/import-policy.ts`
- Reference: `src/store/tombstones.ts`
- Reference: `src/store/gc.ts`
- Reference: `src/store/snapshots.ts`
- Reference: `src/store/integrity.ts`
- Reference: `src/viewer/`
- Reference: `src/pipeline/`
- Reference: `src/ai/`

- [ ] **Step 1: Document export/import and convergence**

Explain checksummed JSONL, transactional validation, dry runs, all four divergence policies,
verbatim adoption for convergence, tombstone propagation, and best-effort post-import vector
indexing.

- [ ] **Step 2: Document snapshots, audit, doctor, and garbage collection**

Explain restore confirmation, manifest validation when present, pre-restore snapshot,
post-restore audit, the limited restored table set, read-only audit behavior, doctor readiness
breadth, GC preview/apply, protected categories, access heat, archive/compression thresholds, and
tombstone retention.

- [ ] **Step 3: Restore viewer depth**

Explain localhost-only binding, GET-only APIs, node/link construction, search and category
filters, stale markers, neighborhood focus, and the evidence/timeline inspector. Keep both
screenshots without stale atom/link counts. Clarify that retrieval inspection records access
telemetry even though the viewer does not mutate knowledge.

- [ ] **Step 4: Restore architecture**

Add a fuller Mermaid diagram and source-layer table covering protocol adapters, shared core
services, storage/retrieval, workspace federation, lifecycle, optional AI, code intelligence,
skills, and viewer.

- [ ] **Step 5: Clarify the optional AI boundary**

State that structured storage/retrieval, governance, lifecycle, skills, and synthesis are
deterministic. Limit provider-dependent behavior to `ask`, explicitly supplied raw-source
`ingest`, configured decision comparison/state derivation, and configured AI pipeline stages. Add
provider-neutral OpenAI, Anthropic, Ollama, and custom endpoint examples.

- [ ] **Step 6: Verify operational claims**

Run:

```powershell
rg -n "newer.*skip.*theirs.*fail|tombstone|pre-restore|127\\.0\\.0\\.1|GET-only|filter.*extract.*verify.*merge" README.md
rg -ni "AI-assisted decision-conflict|requires AI.*structured|viewer.*221|593 links" README.md
```

Expected: current behavior appears; vague AI-conflict and stale viewer-count claims do not.

### Task 5: Reconcile benchmarks and exhaustive references

**Files:**
- Modify: `README.md`
- Modify only if figures are stale: `docs/assets/benchmark-governance.svg`
- Reference: `docs/evals/retrieval-suite.json`
- Reference: `docs/evals/retrieval-governance.json`
- Reference: `docs/evals/memoryagentbench-cr.md`
- Reference: `src/mcp/server.ts`
- Reference: `src/index.ts`

- [ ] **Step 1: Keep current benchmark results and add methodology**

Retain the MemoryAgentBench ablation and 500-case retrieval suite. Explain dataset size,
adversarial case families, known misses, hardware scoping, and reproducibility without absolute
performance promises.

- [ ] **Step 2: Restore the governance regression suite**

Run the checked-in governance dataset, record its current metrics and scenario counts, and reuse
`benchmark-governance.svg` only after correcting the misleading MRR label and distinguishing
rejected-item filtering from stale-active returns. Clearly label this suite as internal.

- [ ] **Step 3: Reconcile CLI and MCP references**

Verify every public CLI command/option against `src/index.ts`. Verify the README lists exactly the
24 registered MCP tools. Advertise only `knowl://brain` and `knowl://recent`; if the category URI
is retained, label it as directly readable but not advertised by resource discovery.

- [ ] **Step 4: Reproduce benchmark checks**

Run:

```powershell
npm run build
npm run test:bench
node dist/index.js eval retrieval --dataset docs/evals/retrieval-suite.json --vector
node dist/index.js eval retrieval --dataset docs/evals/retrieval-governance.json --vector
```

Expected: build and benchmark tests exit zero; the README numbers match fresh output or
checked-in isolated result artifacts.

### Task 6: Perform complete documentation verification

**Files:**
- Verify: `README.md`
- Verify: all README-referenced local assets
- Verify: `docs/superpowers/specs/2026-07-28-readme-feature-depth-design.md`

- [ ] **Step 1: Validate tone and prohibited content**

Run:

```powershell
rg -ni "honestly|we keep it|blam|glaz|inferior|superior to|other tools fail|competitors?|Git of project knowledge" README.md
```

Expected: no matches.

- [ ] **Step 2: Validate links and SVG assets**

Resolve every relative Markdown/HTML link from the repository root. Parse every used SVG as XML
and render modified SVGs for clipping and readability review.

- [ ] **Step 3: Validate Markdown and repository contracts**

Run:

```powershell
git diff --check
npx vitest run tests/core/knowl-guidance.test.ts
npm run build
npm run test:bench
npm test
```

Expected: all commands exit zero and the full suite reports no failed tests.

- [ ] **Step 4: Run benchmark type diagnostics**

Run:

```powershell
npm run typecheck:bench
```

Expected: either exit zero or document the exact pre-existing product-source diagnostics without
attributing them to the documentation change.

- [ ] **Step 5: Request independent reviews**

Run a specification review against the design document, then a documentation-quality review for
technical accuracy, tone, navigation, examples, and unsupported claims. Fix and re-review every
Critical or Important finding.

- [ ] **Step 6: Record final repository state**

Store the verified README baseline in Knowl, finish the manual task loop once, and report branch,
commit, push, and working-tree state explicitly.
