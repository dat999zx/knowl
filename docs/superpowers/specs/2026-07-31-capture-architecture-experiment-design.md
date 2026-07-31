# Capture architecture experiment: rules or a model?

Date: 2026-07-31
Status: approved for planning
Baseline commit: `b8eefd4`
Gates: `docs/superpowers/specs/2026-07-31-unassisted-capture-design.md`, section 2 ("The extractor, rebuilt")

## The question

The unassisted capture spec commits to rebuilding the extractor as **pattern rules** — plain
code over the hook event stream, no model involved. That preserves a real property:
capture runs with no API key, no per-session cost, and offline. `finalizeMemorySession`
reports `usedAi: false` today, and no competitor's manual curation matches it.

Competitive research on the same date found direct evidence against that bet. ByteRover's
paper argues the opposite thesis — memory should *not* be an external extraction pipeline,
and the same model that reasons about the work should curate it. They report LoCoMo 96.1%
and LongMemEval-S 92.8% on their production codebase.

Nobody has measured which is right for Knowl. Building the rules is most of the capture
spec's work. **This experiment decides the architecture before that work starts.**

## Terms

| Term | Meaning |
| --- | --- |
| Answer key | The hand-written list of what should have been remembered from a session |
| Method | One extraction approach being tested |
| Corpus | The saved sessions the methods are tested against |
| Recall | Of the answer key, what fraction the method found |
| Precision | Of what the method saved, what fraction was genuinely worth keeping |
| Junk limit | A minimum precision, fixed before measuring, that a method must clear |
| Findable | An answer-key item derivable from the hook events alone |
| Thinking-only | An answer-key item that existed only in reasoning; no event carries it |

Both recall and precision are required. A method that saves everything achieves perfect
recall while burying the store in noise; either number alone can be gamed.

## The corpus

### Why it was captured before this document was finished

`purgeExpiredSessionEvents` (`src/store/session-repository.ts:57`) hard-deletes events past
`expires_at`, where `EVENT_TTL_HOURS = 48`. It is not a timer: it runs on **session start**
only (`src/store/host-lifecycle.ts:294`), so deletion is bursty and its timing depends on
when the next session opens — 97 sessions opened in the two-day window, so the gap is
typically short but never predictable.

Measured 2026-07-31T11:36Z with an ISO comparison matching the purge's own: **114 events were
already past expiry** and would be erased by the next session start, 506 expire within six
hours, and **1,522 of 1,848 within twenty-four**. A snapshot was taken first and this spec
written after.

An earlier reading of these figures used `expires_at <= datetime('now')`, which compares
ISO-8601 (`2026-07-31T10:09:04.317Z`) against SQLite's `datetime` format
(`2026-07-31 11:36:02`); the `T`-versus-space mismatch silently matches nothing and reported
zero expired rows. Any future check must pass `new Date().toISOString()` as a bound
parameter, exactly as the purge does.

### What it contains

Built by `benchmarks/unassisted-capture/build-corpus.mjs`, committed under
`benchmarks/unassisted-capture/corpus/`.

| Quantity | Value |
| --- | --- |
| Sessions in the database | 96 |
| **Sessions selected** | **32** |
| Events | 1,424 |
| Sessions with at least one error | 16 |
| Sessions with a transcript available | 3 |
| Seed knowledge items | 41 |

**Selection rule: at least 10 events and at least 2 distinct changed paths.** Of 96 sessions
carrying events, 64 fail it — they are stubs, a session opened with no work done. Including
them would flatten every score toward zero regardless of extractor quality and hide any
real difference. The threshold is recorded in `manifest.json` and is part of the
preregistration: it is not tuned after seeing results.

### What is committed, and what is not

`.knowl/` is gitignored — the project deliberately keeps its live database out of version
control. The corpus respects that boundary rather than routing around it: only the 32
selected sessions and their events are committed, not the other 64 sessions and not the
full 380-item knowledge store.

Transcripts are **never** committed. They are 53 MB of raw conversation text — exactly the
secret-bearing content the hook security boundary exists to exclude. `build-corpus.mjs`
records only whether a transcript exists for each session, never its content.

## The answer key

One per session, for all 32.

**Written cold.** The labeller reads the session's events and writes what a careful reviewer
would have wanted retained, without first looking at what Knowl actually stored.

The obvious cheaper route — seeding from the 41 items the model wrote via `knowl_store`
during those sessions — was rejected. Only 41 items exist across 32 sessions, so seeding
would cover a minority of the corpus anyway, while biasing every labelled item toward what a
model already thought worth writing.

**The 41 seed items become a check instead of a source.** After cold labelling, they are
compared against the answer key. An item the model stored that the labeller missed is
examined and the disagreement recorded. This inverts the bias: the seeds audit the labeller
rather than seeding them.

### The strictness standard, fixed before labelling began

A permissive key makes any extractor look good, so the bar is written down first and applied
uniformly. **An item enters the answer key only if all four hold:**

1. **Durable** — still true and worth knowing in six months. Not "tests were run", not "the
   session finished", not "these files changed".
2. **Specific** — names a concrete artifact, cause, or decision. "Fixed a bug" fails.
   "The manifest test needed its own `KNOWL_HOME` because parallel workers shared one" passes.
3. **Not trivially recoverable** — reading the current code for thirty seconds does not
   answer it. Facts a `grep` settles do not need memory.
4. **Session-grounded** — actually supported by what happened in this session, not general
   knowledge about the project.

Rejected by construction, however often they appear: command inventories, "the suite
passed", file-change lists with no conclusion attached, and restatements of a file's
existence.

**Why this is preregistered.** The labeller for this run is the same model that wrote the
harness, and during implementation four of its prescribed tests turned out to assert nothing
— the same instinct writes a lenient key. Fixing the bar in advance is the mitigation, and
the bar is published so a reader can judge the number against it.

**Every item is marked `findable` or `thinking-only`.** A root-cause conclusion drawn across
a whole session appears in no event; scoring it against an event-driven method makes the
metric unwinnable and uninformative. Headline recall is computed over `findable` items.
`thinking-only` coverage is reported separately as the ceiling hooks cannot cross.

`findable` means the **rendered event stream alone** supports it — the exact text
`renderSessionEvents` produces, which is error messages, changed paths, commands with exit
codes, and stop status. Not the session title, not the transcript. When genuinely unsure,
mark `thinking-only`: that removes the item from headline recall, which is the conservative
direction, because wrongly marking an underivable item `findable` makes every method look
worse than it is.

### The model under test is named before the run

The experiment measures whether *a model* can do this, so which model is part of the result.
The exact model identifier is recorded here **before** `run` executes; a result carrying no
model name is not readable. The model must support structured output, since the method binds
a zod schema.

A negative result is bounded by the model tested: if a small model fails, that does not
establish that a larger one would. Any "stop, do not use a model" reading must therefore name
the model it applies to.

**Model used: the local Codex CLI, `codex-cli 0.145.0`, authenticated by ChatGPT login.**
Recorded 2026-07-31 before the run, by the maintainer's decision, after the `OPENAI_API_KEY`
in the environment was found to return 401 and `config.ai` was null.

This is a departure worth stating plainly: Codex is a **coding agent**, not a bare model
behind a structured-output call. It may take multiple turns and use tools. Method 2 was
specified as "a model reading the events", and an agent is a strictly more capable thing. So
a *good* result here does not establish that a plain model call would do as well, and the
reading must say "an agent with the events" rather than "a model with the events". A *poor*
result is the stronger signal, since it would mean even an agent could not recover the
knowledge. Determinism is also weaker than an API call at fixed temperature; runs will vary.

Structured output is obtained with `codex exec --output-schema`, whose JSON Schema mirrors
`PredictedAtomSchema`, so the atoms reaching the scorer have the same shape either way.

### The matcher ships below its own gate, by decision

Calibration returned **0.80 agreement against a preregistered floor of 0.90** (details in
`benchmarks/unassisted-capture/answer-key/README.md`). The maintainer's decision on
2026-07-31 was to proceed with the existing local MiniLM matcher rather than adjudicate every
pair by hand or adopt a stronger embedding model.

The consequence is recorded here rather than discovered later. **Roughly one comparison in
five is wrong**, in both directions, so:

- Stage 1's reading is **indicative, not decisive**. Any number it produces is reported as an
  estimate with a stated ±20% pairwise matcher error, never as a verdict.
- The 20-point stage-2 margin cannot be reliably resolved by this matcher. If stage 2 is ever
  reached, the margin must either be re-derived with a better matcher or the decision made on
  other grounds.
- A result near any threshold — 0.30 recall, 0.80 precision — should be treated as
  unresolved rather than as clearing or failing the gate.

This does not invalidate the run. It bounds what the run can be used to claim.

Labels reuse the `targets` shape from
`benchmarks/accuracy/datasets/coding-memory-v1/gold/capture-labels.ndjson`, extended with the
mark. Matching by shared source ID does not transfer — hook atoms are free text — so
matching is defined below.

## The methods

1. **Rules** — pattern code over events, as the capture spec proposes.
2. **Model, events only** — the same input as the rules, read by a model.

**Method 2 is the ceiling for method 1.** A model reading the events cannot extract more
than the events contain, and will outperform hand-written rules over the same input. If
method 2 scores low, no rule set will score well, because the information is absent.

Building the rules is the expensive part, so method 2 runs first and may make method 1
unnecessary.

### Method 3 is deferred, not cancelled

A third method — a model reading the full conversation transcript — would measure what the
restricted hook payload costs, separating "the extractor is weak" from "the events are too
thin". It cannot run now: only **3** of the 32 sessions have a transcript, and a 20-point
margin across 3 sessions is noise.

It becomes runnable when `manifest.json` reports **20 or more** sessions with transcripts.
Reaching that requires the retention changes below. Until then the payload question stays
open and is not silently answered.

## Stages and decision rule

Fixed before any measurement, per the discipline `benchmarks/accuracy` already enforces.

**Stage 1 — method 2 alone.** Precision is checked first; recall is only consulted for a
method that clears the junk limit.

| Method 2 | Reading | Action |
| --- | --- | --- |
| Precision below 0.80 | **Disqualified.** The model produces too much noise to be trusted at any recall | Do not adopt model-based capture. Build the rules and hold them to the same junk limit. Recall is not consulted and does not appear in the verdict |
| Precision ≥ 0.80, recall below 0.30 | The events do not carry recoverable knowledge | Stop. Do not build the rules either. The payload, not the extractor, is the constraint — escalate method 3 and the retention work |
| Precision ≥ 0.80, recall 0.30 or above | The events carry real signal | Proceed to stage 2 |

The disqualified row was added on 2026-07-31, **before any measurement**, after a review
found `readStage1` implemented three outcomes while this table described two. Settling it
after seeing a number is precisely the reinterpretation preregistration exists to prevent.

**Stage 2 — build method 1, then compare.**

A model-based extractor ships only if it beats the finished rules by **at least 20 points of
recall over `findable` items**, with both at or above the junk limit. Below 20 points,
including any tie, the rules ship. The margin protects the no-API-key, zero-cost, offline
property; a marginal accuracy gain does not justify losing it.

**Junk limit: precision ≥ 0.80.** The store already contains promoted noise such as
`Work Loop finish`, and noise degrades every future retrieval. A method below 0.80 is
disqualified regardless of recall.

**Match threshold.** Two statements count as the same fact by cosine similarity over the
local MiniLM model Knowl already ships — deterministic, reproducible, no API key, and it
avoids using a model to judge an experiment about whether to use a model.

Calibrated **before** the run and then frozen: 20 pairs drawn from `knowledge_items` outside
the 32 sessions (10 hand-picked same-fact pairs, 10 clear non-matches), threshold set to the
value maximising agreement with those hand judgments. Pairs within ±0.10 of the frozen
threshold are adjudicated by hand and the adjudications recorded. Above it matches, below it
misses.

**Small-sample guard.** Per-session spread is reported with every headline number. Gaps
under the 20-point margin are treated as ties, which the decision rule already resolves
toward the rules.

## Stopping the data loss

Two changes are needed before the corpus can grow, and both are recommendations for the
maintainer rather than part of this experiment's build:

1. **Event TTL.** `EVENT_TTL_HOURS` gives roughly two days. This is a product decision with
   storage and privacy consequences, not a benchmark knob, so it is flagged rather than
   changed here.
2. **Transcript retention.** 14 transcripts exist for 96 sessions; the rest are gone. Method
   3 needs 20 sessions with transcripts and currently has 3.

Until both are settled, `build-corpus.mjs` should be re-run periodically — it is the only
thing standing between the corpus and hard deletion.

## Scope

**In scope.** The corpus builder and its committed output; the answer key with both marks;
the seed-item audit; the similarity matcher and its calibration; a runner for methods 1 and
2; a results table with the stage-1 reading and, if reached, the stage-2 verdict.

**Out of scope.** Building the production extractor — that is the capture spec's job, and
this experiment tells it which architecture to build. CI wiring. The permanent
unassisted-capture benchmark, which scores one shipped extractor under the zero-write
condition and should not be designed before its subject is chosen. Method 3 and any widening
of the hook payload, which needs its own threat model.

## Risks, stated rather than buried

- **Shared blind spot.** The answer key is written by a model and method 2 is a model. They
  may agree on what matters and be wrong together. The 41-item seed audit partly tests this.
  Disclosed in the writeup, not omitted.
- **One developer, one repository, two days.** The corpus is roughly two days of a single
  developer's work on Knowl itself. Conclusions generalise no further than that, and the
  writeup says so.
- **32 sessions is small.** Reported as a limitation on every number.
- **Selection threshold shapes the result.** Requiring 10 events and 2 changed paths selects
  for substantial sessions, which flatters every method relative to real-world use where
  most sessions are stubs. The 64 excluded sessions are reported alongside, so the headline
  number is never mistaken for "captures knowledge from an average session".
- **Precision is capped by how densely the answer key was written.** Matching is one-to-one,
  so per-session precision cannot exceed `min(|gold|, |predictions|) / |predictions|`. A
  session whose `targets` array is empty makes every prediction a precision miss by
  construction. If a method emits more atoms per session than the key lists targets, its
  precision is bounded below the junk limit however good those atoms are — the limit would
  then be measuring the labeller's density rather than the method's noise.

  Mitigation, fixed here rather than after the fact: the achievable precision ceiling is
  computed and published beside the measured precision as
  `Σ min(findableTotal + thinkingOnlyTotal, predictedTotal) / Σ predictedTotal`. Every term
  is already in `results.json` under `score.perSession`, so this needs no new code — it is
  arithmetic over the run's own output, done at step 4 of the run task.

  **A disqualification is only read as disqualification when the ceiling itself clears
  0.80.** If it does not, the labelling is too sparse to support the judgment, and the answer
  key is extended before the number is read. An earlier draft would have used an
  `exclusions` field for this; that field was removed as dead surface, and publishing the
  ceiling is the honest replacement.

## Success criteria

1. The corpus is committed, and `build-corpus.mjs` reproduces it from a live database.
2. The answer key exists for all 32 sessions, dual-marked, with the seed audit published.
3. The similarity threshold is calibrated, frozen, and recorded before any method runs.
4. Stage 1 produces a reading from the table above and the resulting action is recorded as a
   decision.
5. If stage 2 runs, the decision rule is applied as written, with the losing method's numbers
   published alongside the winner's.

## Results — stage 1, 2026-07-31

Run at commit `cc544fd`. Generator: local Codex CLI 0.145.0, model `gpt-5.6-sol` (recorded
from the CLI banner; the run itself logged `null` because the banner goes to stderr and the
capture read stdout only — fixed afterwards, and noted here rather than back-filled into
`results.json`). 32 sessions, 0 failed. Frozen threshold 0.4012, calibration agreement 0.80.

| Measure | Value |
| --- | --- |
| Recall over `findable` | **0.862** |
| Recall over `thinking-only` | 0.667 |
| Precision | 0.243 |
| **Achievable precision ceiling** | **0.279** |
| Predictions | 111 (3.5 per session) |
| Gold items | 32 (1.0 per session) |
| Per-session recall spread | 0.00 – 1.00 |
| Band pairs awaiting adjudication | 48 |

### The reading

**The precision disqualification is not readable, by the rule fixed before the run.** One-to-one
matching caps precision at 0.279 for this answer key, so the 0.80 junk limit could not have
been reached by any method however clean its output. Codex reached 87% of the maximum
attainable. The number measures the key's density, not the method's noise — which is exactly
the failure mode the ceiling rule was added to catch.

**Recall of 0.862 clears the 0.30 stage-1 gate by a wide margin, and that is the substantive
result.** The events do carry recoverable knowledge; the hook payload is not the binding
constraint. This holds even allowing for the matcher's ~20% pairwise error, because the margin
over the gate is far larger than that error.

**The 3.5 : 1 ratio of predictions to gold is unresolved.** Inspection of individual sessions
shows the surplus is mixed, not uniformly noise:
- Genuine misses in the answer key — e.g. "the workspace cache does not detect a repository
  joining mid-process", a real durable constraint the labeller did not record.
- Inventory-style items the strictness standard rejects by construction — e.g. "repository
  management is split across `repo-registry.ts`, `repo-discovery.ts`, `upgrade.ts`", which
  reading the directory answers in seconds.

Separating the two requires adjudicating the 48 band pairs and extending the key. Until then
no precision figure should be quoted.

### What this does and does not license

- **Licensed:** proceeding on the basis that hook events contain recoverable durable knowledge.
- **Licensed:** the signal attribution (`answer-key/signal-attribution.json`) — 52% of items
  derive from git commit subjects, 45% from error text, 0% from changed paths alone. That
  measurement does not route through the matcher and is the most reliable output of this run.
- **Not licensed:** any claim about precision, the junk limit, or rules-versus-model on
  precision grounds.
- **Not licensed:** "a model does this well" in general. Codex is an agent, and the strong
  recall may owe as much to its multi-turn latitude as to the payload.

Stage 2 is not entered. The comparison it exists to make cannot be settled by a matcher with
0.80 agreement against a 20-point margin.
