# Autonomous Project Memory Design

## Purpose

Move Knowl from a model-cooperated project notebook to a reliable local project-memory system. `AGENTS.md` remains compatibility guidance, but correctness must come from deterministic write guards, automatic lifecycle capture, evidence, measurable retrieval, and explicit memory lifetimes.

## Product Boundary

Knowl stores verified project decisions, constraints, architecture, state, and reusable procedures. It does not permanently archive raw conversations or every tool call. Normal writes remain local and deterministic; optional model processing runs only when synthesizing bounded candidates or summaries.

## Success Criteria

- Supported agent sessions capture useful outcomes without requiring the model to call `knowl_store`.
- Unsupported agents retain a universal `knowl task run` fallback.
- Every write path rejects secrets and unsafe raw output.
- Durable knowledge can cite multiple evidence records.
- Retrieval quality and latency are regression-tested.
- Temporary observations expire instead of polluting durable knowledge.
- Historical truth, conflicts, retrieval use, and context-budget decisions are inspectable.
- Each subsystem ships through a separate executable plan and leaves the repository passing tests/build.

## Architecture

```text
Agent / CLI / MCP
        |
        v
Universal write validation
        |
        +--------------------------+
        |                          |
        v                          v
Session event buffer         Structured direct write
        |                          |
        v                          |
Session finalizer                 |
        |                          |
        v                          |
Candidate validation + dedupe + conflict checks
        |
        v
Durable knowledge assertions <--> evidence/provenance
        |
        +--> retrieval index + access feedback
        +--> context composer
        +--> timeline/conflict/audit/viewer surfaces
```

## Memory Tiers

### Scratch

Session events, hypotheses, errors, and temporary observations. Scratch records have an expiry and never appear as durable active knowledge unless promoted.

### Durable

Verified facts, decisions, constraints, architecture, state, goals, and skills. Promotion requires validation, deduplication, confidence, and evidence appropriate to the claim.

### Synthesized

Compact module summaries and recurring project patterns derived from durable knowledge. Synthesized items preserve links to their source items and evidence.

## Automatic Session Lifecycle

`knowl init` configures lifecycle automation where an agent exposes supported hooks. Adapters report whether lifecycle capture is configured, unsupported, or degraded. Unsupported environments use `knowl task run` and explicit session CLI commands.

Session flow:

1. Start a session with agent, task, query, timestamps, baseline Git state, and optional process identity.
2. Capture bounded events: task outcome, changed paths, diff summary, tests, errors, commits, and explicit decisions.
3. Apply size limits and secret filtering before persistence.
4. Finalize on normal stop. A later startup recovers sessions abandoned beyond a heartbeat threshold.
5. Produce a small candidate set, normally no more than five atoms.
6. Validate, deduplicate, attach evidence, then promote eligible candidates.
7. Retain unpromoted events only until their TTL expires.

Hooks must not invoke a model per event. Agent-specific hook support is optional; the session store and finalizer are agent-neutral.

## Universal Write Validation

All MCP, CLI, pipeline, work-loop, session-finalizer, skill-index, and internal repository writes pass through one deterministic `validateKnowledgeWrite` boundary before durable storage.

Validation rejects or bounds:

- common API keys and tokens;
- PEM/private-key material;
- credential-bearing connection strings;
- configured secret patterns;
- high-entropy credential-like values;
- disallowed source paths such as `.env`;
- oversized command output or transcript-like payloads.

Validation errors identify the rule, never echo the detected secret.

## Evidence and Provenance

Evidence is stored separately and linked many-to-many to knowledge items or assertions. Evidence types include file, symbol, commit, test, command, URL, user, and agent. Each record can store locator, content hash, safe excerpt, observation time, and structured metadata.

Relationships are `supports`, `contradicts`, or `derived_from`. File and symbol evidence can later be marked stale when its hash changes.

## Temporal Knowledge

Current `knowledge_items` remains the stable identity and retrieval entrypoint. Immutable `knowledge_assertions` store content, validity interval, transaction timestamps, confidence, and source identity. Updating a temporal item closes the previous assertion and opens a new one in one transaction.

Required surfaces:

- current active retrieval;
- query as-of a timestamp;
- item timeline;
- audit reconstruction from assertions without replaying mutable rows.

## Conflict Identity

Knowledge may optionally declare a `conflictKey`, scope, and exclusivity. Only one active assertion may occupy an exclusive key and scope. Writes that collide return a structured conflict unless the caller explicitly supersedes the previous assertion.

The model may explain a conflict, but deterministic storage owns the conflict boundary.

## Retrieval Quality

A versioned evaluation dataset defines queries, expected item IDs, forbidden stale/rejected IDs, and optional category/task context. The harness measures recall@3, recall@10, MRR, nDCG, latency, active-versus-stale errors, and injected-context size.

Ranking improvements occur only after the baseline exists. Planned improvements include standard RRF, bounded category/freshness/confidence weights, exact identifier boosts, MMR diversification, and result score explanations. Vector-index replacement remains optional until benchmarks show scale pressure.

## Context Composer

One `knowl_context` operation accepts query, task, changed files, token budget, and evidence preference. It returns pinned constraints, task state, decisions, architecture, failed approaches, skills, evidence, and an excluded/truncated report.

Composition is deterministic after retrieval: reserve budgets by section, remove semantic duplicates, enforce critical pins, and truncate safely. Existing `knowl_recent`, `knowl_query`, and `knowl_state` remain available.

## Retrieval Feedback

Access records track item, query fingerprint, timestamp, rank, surface, and optional used/useful/corrected outcomes. Initial ranking does not automatically punish ignored results because absence of feedback is not negative evidence. Feedback first powers measurement and stale/high-value reports; ranking use requires evaluation evidence.

## Code Awareness

A separate Tree-sitter structural index stores files, symbols, and symbol edges. Knowledge evidence references locators such as `symbol://src/auth/token.ts#createAccessToken`. Symbol extraction is incremental by file hash. The atom table does not become a general code graph.

## Namespaces

Reads may layer session scratch, project, organization, and global-user stores. Physical databases remain separate. Every result carries its namespace, and write targets are explicit. Project-local memory remains the default and highest-priority durable source.

## Local Viewer

A local read-first viewer exposes current brain, timeline, decisions, stale knowledge, conflicts, evidence, retrieval debugger, access metrics, and skills. Mutation endpoints reuse the same validation and repository services as CLI/MCP; the viewer must not create a second storage implementation.

## Plan Decomposition and Order

Each item below becomes a separate implementation plan. Execute one plan at a time; finish verification and record the outcome in Knowl before opening the next plan.

1. **Universal write guard and integrity tooling**
   - Central validation, audit command, safe snapshots, restore verification.
2. **Evidence and provenance**
   - Evidence schema/repository, links, stale-hash checks, CLI/MCP reads.
3. **Retrieval evaluation and explanations**
   - Dataset format, metrics runner, baseline report, score explanations.
4. **Session event buffer and scratch memory**
   - Sessions/events schema, TTL, bounded capture API, recovery state machine.
5. **Session finalizer and candidate promotion**
   - Outcome collection, deterministic candidates, optional bounded synthesis, dedupe/evidence/promotion.
6. **Agent lifecycle adapters and automatic context bootstrap**
   - Hook capability model, supported adapters, degraded fallback, doctor/init reporting.
7. **Temporal assertions and timelines**
   - Immutable assertion history, as-of queries, timeline surfaces.
8. **Conflict keys and deterministic contradiction handling**
   - Exclusive keys/scopes, collision responses, explicit supersession.
9. **Context composer and retrieval diversification**
   - Token budgets, pinned sections, RRF/MMR, excluded-item report.
10. **Knowledge access feedback**
    - Retrieval telemetry, feedback APIs, usefulness/staleness reports.
11. **Code symbol index**
    - Tree-sitter extraction, symbol evidence locators, incremental refresh.
12. **Synthesized project understanding**
    - Module summaries and mental models derived from durable sources.
13. **Layered memory namespaces**
    - Separate stores, precedence, namespace-aware retrieval and writes.
14. **Local viewer**
    - Read-first UI and retrieval/evidence/timeline debugging.
15. **Synchronization and portability**
    - Import/export first; optional team synchronization only after namespace and evidence semantics stabilize.

## Cross-Plan Rules

- TDD: failing focused test, minimal implementation, passing focused test, broader verification.
- Surgical changes: no unrelated refactors.
- Every durable write uses the universal guard after Plan 1.
- Every new stored fact supports evidence after Plan 2.
- Retrieval changes must compare against the evaluation baseline after Plan 3.
- Plans 5-6 depend on Plan 4; Plans 7-8 depend on Plan 2; Plan 9 depends on Plan 3; Plan 11 depends on Plan 2; Plan 14 depends on Plans 2, 7-10.
- Schema upgrades must be idempotent and tested against an existing project database.
- No plan permanently stores secrets, raw transcripts, or unbounded command output.
- Each completed plan updates README/doctor/status only when user-facing behavior changes.

## Verification Standard

Every plan ends with focused tests, full tests, build, `git diff --check`, and a Knowl durable implementation summary. Database plans additionally verify fresh initialization and upgrade of an existing fixture. Security plans verify error messages do not reproduce rejected secret material.
