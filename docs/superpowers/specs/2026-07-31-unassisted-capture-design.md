# Unassisted capture: make hooks worth having, and measure it

Date: 2026-07-31
Status: approved for planning
Baseline commit: `78ddb93`

## Why this, and why now

Knowl's stated edge is that it captures durable project knowledge without the agent
choosing to write it. Measured against the real database on 2026-07-31, that is not true
today: of 88 hook-driven sessions, **1 promoted, 79 skipped, 8 never finalized**. Thirteen
of 375 knowledge items came from session promotion, and they read like `Work Loop finish`
and `Session outcome: Review README depth architecture`. Every substantive item in the
store — root causes, release regressions, architecture decisions — was written by the model
calling `knowl_store`.

That matters because the competitive research on the same date found the category is
crowded and Knowl's other positions are taken. **ByteRover** (formerly Cipher) is
local-first, MCP-native across 22+ coding agents, has git-like versioning of a context
tree, multi-repo worktrees and read-only cross-project sources, a team cloud with SOC 2
Type II, published LoCoMo 96.1% / LongMemEval-S 92.8%, and shipped pricing at
Free / $14.90 / $149 / Enterprise. **ProjectMem** has an arXiv paper and already calls
itself "Memory-as-Governance". Zep/Graphiti already does bitemporal fact invalidation, so
supersession alone does not differentiate either.

What no one in the category has solved — including Knowl — is knowledge landing in the
store when nobody remembers to write it. ByteRover's capture is `brv curate`, explicitly
manual. ProjectMem's is agent-logged events. Neither has a hook layer. Knowl already has
one: it fires, streams events, promotes deterministically with `usedAi: false`, and carries
evidence locators. The plumbing exists and the extractor on top of it does nothing.

**This spec makes that plumbing produce real knowledge, and defines the number that proves
it.** The deliverable is a measured rate, not an adjective.

## Measured baseline

From `.knowl/knowl.db` at commit `78ddb93` on 2026-07-31.

| Quantity | Value |
| --- | --- |
| Memory sessions total | 403 |
| Sessions with hook events | 88 |
| Session events | 1,724 (1,720 unexpired) |
| Event window | 2026-07-29 → 2026-07-31 |
| Sessions promoted / skipped / pending | **1 / 79 / 8** |
| Knowledge items from promotion | 13 of 375 (3.5%) |

Events by type: `checkpoint` 937, `command` 562, `start` 88, `stop` 87, `error` 50,
`decision` **0**.

Counts were taken across three probes a few minutes apart, during a session that was itself
being captured, so `checkpoint` reads 937 in the first probe and 939 in the second. The
drift is the measurement observing itself and does not affect any conclusion here.

### Every existing extractor rule is dead

`src/store/session-candidates.ts` has three rules. None of them can fire on a hook-driven
session:

1. **`decision` event → decision atom** (line 25). There are **zero** `decision` events in
   the database. No hook path emits one.
2. **Command repeated `PROCEDURAL_SKILL_MIN_REPEATS = 3`+ times → skill** (line 42).
   **Zero** sessions contain any command repeated three times.
3. **`stop.summary` → outcome atom** (line 53). **One** of 87 `stop` events has a non-null
   summary; the host does not supply one.

The promoted items that do exist came from the manual `knowl task run` work loop, not from
hooks.

### The signal that does exist

| Signal | Volume | Notes |
| --- | --- | --- |
| `checkpoint.changedPaths` | 620 of 939 checkpoints | Real repo-relative paths. The other 319 are non-file tools. |
| `error.message` | 50 events | Rich: min 25, **mean 867**, max 2,293 characters. Real diagnostic text. |
| `command` | 562 | `{ command, exitCode }`. **`exitCode` is 0 on all 562** — the hook never records a failed command. |
| `stop.status` | 87 | `finished` 77, `recovered` 7, `failed` 3. |
| Sessions with ≥1 error | 19 | |
| **Sessions with an error followed by file changes** | **12** | 14% of sessions carry a recoverable failure→fix pair, currently discarded. |

Two consequences for design. First, **failure detection must key on `error` events, not exit
codes** — the exit-code path records only successes, so the extractor's `succeeded` check is
inert. Second, event retention is roughly two days (`expires_at`), so the benchmark must
capture forward or extend retention for its runs; historical mining is not available.

## Scope

### In scope

1. An **unassisted capture benchmark** and a committed baseline.
2. A **rebuilt extractor** keyed on the signal that actually exists.
3. A **preregistered precision floor** gating every new rule.
4. Fixing **session finalization** so sessions stop dying `pending`.

### Out of scope

Cloud or team tiers. Workspace v2 shared database. The full five-system accuracy
leaderboard. CLI startup performance. **Widening the hook payload** to carry stdout,
stderr, or diff content — that is the security boundary, secret-bearing payloads are
currently a hard failure, and reopening it needs its own threat model. If the metric
plateaus and clearly points there, that is a separate spec.

## Design

### 1. The metric

**Unassisted capture rate.** Run a real coding session with Knowl's write tools
(`knowl_store`, `knowl_decide`, `knowl_ingest_atoms`, `knowl_update`) disabled, so the model
physically cannot write. Only hooks run. Score what landed against evaluator-owned gold for
that session.

Reuse the existing native-capture evaluator in `benchmarks/accuracy`, which already does
source-attributed, gold-isolated, maximum-cardinality one-to-one matching and reports micro
precision / recall / F1 plus false-promotion, duplicate-promotion, and secret-leak rates.
What is new is the zero-write condition and the session corpus.

**Gold labeling.** For each benchmark session, gold is the durable knowledge a careful
reviewer would want retained. Seed it from what the model actually wrote via `knowl_store`
during that session, then hand-review.

**A fairness rule that must not be skipped:** some gold is pure reasoning — a root-cause
analysis is a conclusion drawn across a whole session, not an event. It is not derivable
from any event stream, and counting it against the extractor would make the metric
unwinnable and uninformative. Every gold item is labeled `event-derivable` or
`reasoning-only`. Headline recall is computed over `event-derivable` gold; `reasoning-only`
coverage is reported separately and honestly, as the ceiling that hooks alone cannot cross.

### 2. The extractor, rebuilt

Since no existing rule fires, this is a rebuild against real signal, not an addition.

- **Failure→fix pair.** An `error` event, then `checkpoint` events carrying `changedPaths`,
  then no further error with the same signature before the session ends. "Same signature"
  means a normalized form of the error message — the exception class, code, and first frame,
  with paths, line numbers, and hex addresses stripped — not raw string equality, since
  identical failures rarely produce byte-identical text. Emits a `fact` carrying the error
  text, the files that changed, and the resolution. Available in 12 of 88 sessions today.
  Highest value — this is ProjectMem's judgment-gate territory, derived rather than
  hand-logged.
- **Co-edit coupling.** Files repeatedly changed together within a session, above a
  threshold. Emits an `architecture` atom.
- **Session outcome, from a real source.** `stop.summary` is null in practice; derive the
  outcome from `stop.status` plus changed paths and commands instead, or drop the rule
  rather than keep emitting `Work Loop finish`.
- **Repeated-command skill.** The threshold of 3 never fires on any real session. Default to
  **deleting this rule.** It survives only if re-tuning clears the precision floor — a lower
  threshold means more candidates from a signal already shown to produce items like
  `Repeated workflow: npm.cmd test 2>&1 | tail -8`, which is noise, not knowledge.

Each rule ships behind the precision gate below. A rule that cannot clear it is deleted,
not weakened.

### 3. Precision floor, set before measuring

Recall alone would fill the store with noise, which is worse than capturing nothing — the
current `Work Loop finish` items are the existing proof. Dedup, supersession, and GC decay
help but do not substitute for a gate.

The benchmark reports precision and false-promotion rate alongside recall, and **a rule
ships only if precision stays above a floor committed to before the first run** — the same
preregistration discipline `benchmarks/accuracy` already enforces. The floor value is set in
the implementation plan, before any measurement.

### 4. Finalization reliability

Eight of 88 sessions are `pending`: finalization never ran, so they captured nothing
regardless of extractor quality. Crash recovery exists; this is a gap in reaching it. Fixed
as part of this work, since it caps the metric independently of everything else.

### 5. What ships publicly

The README claim becomes the measured number. No adjective without a figure behind it.

**On benchmarking ByteRover:** it can be added to `systems.lock.json` and run under the same
zero-write condition, but ByteRover positions curation as *intentional*, so scoring it on
unassisted capture measures something it does not claim to do. If published, it is framed as
"how much lands when nobody curates" — a real user question — and never as "we beat
ByteRover". The metric stands on its own without them; the head-to-head is best-effort and
does not gate the release.

## Testing

- Unit tests per extractor rule, over fixture event streams, including the negative cases
  that currently make every rule inert: zero `decision` events, all-zero exit codes, null
  `stop.summary`.
- A regression test asserting the baseline: the three existing rules produce nothing on a
  realistic hook session. It should fail once the rebuild lands, and that failure is the
  proof the work did something.
- Benchmark runs are 3-run medians with a fixed seed, matching the existing accuracy
  protocol.
- Precision, false-promotion, and secret-leak rates are asserted in CI against the
  preregistered floor.

## Success criteria

1. The unassisted capture benchmark exists, runs reproducibly, and the 2026-07-31 baseline
   above is committed as its first data point.
2. Recall over `event-derivable` gold improves materially against that baseline, with
   precision at or above the preregistered floor.
3. Sessions no longer die `pending`.
4. The README states a measured number, with the `reasoning-only` ceiling disclosed.

## Open questions for the plan

- The precision floor value.
- Whether to extend event retention for benchmark runs, or capture forward only.
- Whether the repeated-command rule survives re-tuning or is deleted.
