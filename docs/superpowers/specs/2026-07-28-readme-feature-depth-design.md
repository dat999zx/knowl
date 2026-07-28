# README Feature Depth Design

## Goal

Make `README.md` a complete, professional entry point for Knowl: concise enough to onboard a
new user quickly, but detailed enough to explain every major shipped feature, its operational
semantics, its safety boundaries, and the commands used to operate it.

## Problem

The July 28 README rewrite removed stale claims, competitor comparisons, promotional language,
and conversational filler, but also compressed most feature behavior into a short capability
table. The resulting document accurately inventories commands and MCP tools without explaining
how Knowl's governed memory, retrieval, lifecycle, evidence, skills, maintenance, and workspace
features behave in practice.

The previous README is a useful feature inventory, but it cannot be restored verbatim. Several
details changed in releases 2.1 through 2.5, including supersession policy, embedding setup,
lifecycle retention, reminder cadence, import divergence, and workspace boundaries.

## Audience

The README must serve:

1. A developer evaluating whether Knowl fits an agent workflow.
2. A user installing Knowl for one repository.
3. An operator maintaining long-lived memory or a multi-repository workspace.
4. An agent-integration author verifying CLI, MCP, lifecycle, and fallback behavior.

## Documentation Architecture

Use one layered README rather than splitting primary feature documentation into separate files.

1. **Orientation:** hero, overview, five-minute quick start, and a short end-to-end model.
2. **Core model:** structured atoms, governed writes, current truth, history, conflicts, and
   evidence.
3. **Feature workflows:** retrieval and context, task/session lifecycle, subagents, evidence and
   drift, workspaces, learned skills, synthesis, code indexing, portability, maintenance, and
   the viewer.
4. **System behavior:** agent host matrix, architecture, storage, validation, optional AI, and
   fallback behavior.
5. **Evidence and reference:** benchmarks, exhaustive CLI reference, MCP tools/resources, local
   data, and license.

The first 80–120 lines must remain sufficient for installation and a first query. Technical
depth follows below it, so the README supports both scanning and close reading.

## Chapter Contract

Each feature chapter must include the relevant subset of:

- the problem the feature solves;
- one concrete CLI or MCP workflow;
- exact operational semantics;
- safety, privacy, or failure behavior;
- important limits and scope boundaries;
- a link to checked-in evaluation data or design material when it materially helps verification.

Avoid repeating command tables inside prose. Examples should demonstrate workflows that are not
obvious from a command signature.

## Required Feature Coverage

### Core knowledge model and governed writes

- Explain all seven atom categories and when each is appropriate.
- Document status, freshness, confidence, tags, source metadata, affected paths, conflict
  identities, repository ownership, assertions, and knowledge commits.
- Explain deterministic write validation for secrets, sensitive paths, and size.
- State the current category-neutral reconciliation contract: exact content is a no-op,
  same-subject title containment supersedes, explicit `supersedes` wins, and other overlaps
  coexist with a reported near-duplicate.
- Explain that supersession retires history rather than deleting it and that exclusive conflict
  collisions fail before insertion.

### Retrieval, history, and bounded context

- Explain default local vector-primary retrieval, bounded BM25 fallback, exact-identifier
  support, and freshness/status/confidence/recency adjustments.
- Document best-effort model preparation during `knowl init`, cached-model-only write embedding,
  BM25 operation when offline, `knowl reindex --vectors`, `KNOWL_SKIP_MODEL_DOWNLOAD`, and
  `KNOWL_DISABLE_WRITE_EMBEDDING`.
- Show current and `--as-of` queries without claiming cross-workspace historical reconstruction.
- Explain assertions and timelines.
- Explain token-budgeted context composition, pinned constraints, exclusions, and its
  session-plus-project scope.

### Tasks, sessions, lifecycle hooks, and subagents

- Distinguish verified automatic lifecycle hooks from manual task loops.
- Show `task run` and a resumable start/checkpoint/finish workflow with structured checkpoint
  fields.
- Explain bounded session events, recovery, hard-failure handoffs, and deterministic candidate
  promotion without storing transcripts.
- State current retention precisely: events expire after 48 hours; active session rows receive a
  nominal seven-day expiration timestamp but are not currently purged automatically; sessions
  idle for two hours can be marked recovered without terminal promotion.
- Explain deterministic terminal promotion, including the eight-candidate cap and the distinction
  between promoted `skill` atoms and executable file-backed skill packages.
- Explain main-session and subagent bootstrap, half-budget subagent context, per-agent bindings,
  change watermarks, own-write suppression, compact sibling-change cards, and the 12-event
  continuation reminder.
- Include a host capability matrix for Codex, Claude Code, Cursor, Gemini CLI, and Claude Desktop,
  with unsupported or upstream-limited channels stated explicitly.

### Evidence, code intelligence, drift, and access feedback

- Document evidence types and `supports`, `contradicts`, and `derived_from` relationships.
- Explain hash-based file staleness and `symbol://` evidence.
- Explain incremental Tree-sitter indexing for TS, TSX, JS, and JSX.
- Show `knowl pr check --since` preview and apply behavior.
- Explain retrieval access logging, `knowl_feedback`, and `knowl access report`.

### Workspaces

- Keep the current v2.5 setup workflow and exhaustive command table.
- Explain external machine-local manifests, separate repository databases, ownership, explicit
  promotion, read-only peer results, repository labels, embedding-identity compatibility, and
  graceful degradation when a peer is unavailable.
- State that explicit current queries fan out, while historical queries, recent context, context
  packs, work loops, synthesis, code indexing, and mutations remain local.
- Preserve shipped limits: no live peer-write notification, no cross-repository mutation, and no
  un-promotion command.
- Document the current ownership limitation: joining backfills existing items with an origin
  repository, but newly written rows do not yet populate `origin_repo` and therefore cannot be
  selected for promotion until ownership is repaired.

### Learned skills and deterministic synthesis

- Document the `.knowl/skills/<name>/` package layout, `SKILL.md`, `skill.json`, optional files,
  inspected entrypoints, path validation, and execution metadata.
- Include create, list, read, and run examples.
- Explain that synthesis is deterministic and tag-scoped, uses fresh active sources, and requires
  no AI provider.

### Portability, maintenance, and inspection

- Explain manifest-verified JSONL export/import, transactional validation, dry-run behavior,
  divergence policies, convergence, and tombstone propagation.
- Explain snapshot checksums, mandatory restore confirmation, validation when a manifest is
  present, pre-restore snapshots, post-restore audit, and the exact restored table scope. Do not
  imply assertions, evidence, access telemetry, sessions, code indexes, or tombstones are restored.
- Explain preview-before-apply garbage collection, protected categories, access heat,
  compression, and tombstone retention controls.
- Explain the read-only audit and the breadth of `doctor`.
- Document the localhost-only, GET-only viewer, graph semantics, filters, stale markers, and
  evidence/timeline inspector. Clarify that it does not mutate knowledge, while retrieval
  inspection can still record access telemetry.

### Architecture and AI boundary

- Restore the fuller architecture diagram and source-layer table, including `src/workspace`.
- Make the deterministic boundary explicit: structured CLI/MCP memory, retrieval, governance,
  lifecycle, skills, and synthesis do not require a provider.
- Limit optional AI claims to `ask`, explicitly supplied raw-source `ingest`, and configured
  pipeline behavior. Note that configured AI can also assist CLI decision comparison and
  best-effort MCP state derivation; deterministic operation remains available without it.
- Provide provider-neutral configuration templates for OpenAI, Anthropic, Ollama, and custom
  OpenAI-compatible endpoints without freezing fast-changing model recommendations.

### Benchmarks and references

- Retain MemoryAgentBench conflict-resolution and the 500-case internal retrieval suite.
- Restore the internal governance regression suite with checked-in data and clearly label it as
  internal.
- Add concise methodology and known-miss interpretation without restoring absolute latency,
  prompt-overhead, launch-time, or token-cost claims.
- Keep the CLI inventory exhaustive.
- Keep the MCP inventory at exactly 24 registered tools.
- Advertise only `knowl://brain` and `knowl://recent`; mention the category URI only as a
  directly readable, non-advertised handler if useful.

## Tone and Editorial Rules

- Write in direct, technical language specific to Knowl.
- Do not compare Knowl with competitors.
- Do not use conversational asides, blame, praise, slogans, or first-person editorial commentary.
- Avoid unsupported superlatives and subjective claims.
- Use active voice and concrete behavior.
- Keep limitations next to the feature they constrain.
- Preserve UTF-8 punctuation only where it improves readability; do not rely on emoji headings.

## Visuals

- Retain the current hero and conflict-resolution benchmark SVG.
- Reuse `benchmark-governance.svg` only after its figures and labels match the current checked-in
  governance evaluation.
- Retain the two current viewer screenshots and remove stale screenshot-count captions.
- Do not restore the stale speed or overhead SVGs.
- Every SVG used by the README must have a descriptive accessible name and valid XML.

## Verification

The implementation is complete only when:

1. Every required feature area has a dedicated explanation and at least one concrete workflow
   where appropriate.
2. Commands and options match `src/index.ts`.
3. MCP tools exactly match the registered 24-tool surface.
4. Workspace, lifecycle, retrieval, reconciliation, import, GC, and viewer claims match current
   source and tests.
5. Benchmark figures reproduce from checked-in data or result artifacts.
6. Relative links resolve and every referenced asset exists.
7. Used SVGs parse as XML and render without clipping.
8. Tone scans find no competitor, blame, praise, or conversational filler.
9. `git diff --check`, `npm run build`, benchmark tests, focused README contract tests, and the
   full test suite pass, except for any separately documented pre-existing diagnostics.
10. Independent specification and documentation-quality reviews report no Critical or Important
    issues.

## Non-Goals

- No product-code changes.
- No new commands, MCP tools, configuration keys, or runtime behavior.
- No competitor matrix or externally sourced product comparison.
- No restoration of stale latency, prompt-overhead, launch-time, or token-cost claims.
- No duplication of the complete README into a second feature-document hierarchy.
