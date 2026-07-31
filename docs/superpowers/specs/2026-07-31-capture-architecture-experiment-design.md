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
`expires_at`. Measured 2026-07-31T10:04Z, the oldest events expired at 10:09Z — four minutes
out — with 506 expiring inside 24 hours and the whole window gone by 2026-08-02. A snapshot
was taken first and this spec written after.

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

**Every item is marked `findable` or `thinking-only`.** A root-cause conclusion drawn across
a whole session appears in no event; scoring it against an event-driven method makes the
metric unwinnable and uninformative. Headline recall is computed over `findable` items.
`thinking-only` coverage is reported separately as the ceiling hooks cannot cross.

Labels reuse the `targets` / `exclusions` shape from
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

**Stage 1 — method 2 alone.**

| Method 2 recall over `findable` | Reading | Action |
| --- | --- | --- |
| Below 0.30 | The events do not carry recoverable knowledge | Stop. Do not build the rules. The payload, not the extractor, is the constraint — escalate method 3 and the retention work |
| 0.30 or above | The events carry real signal | Proceed to stage 2 |

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

## Success criteria

1. The corpus is committed, and `build-corpus.mjs` reproduces it from a live database.
2. The answer key exists for all 32 sessions, dual-marked, with the seed audit published.
3. The similarity threshold is calibrated, frozen, and recorded before any method runs.
4. Stage 1 produces a reading from the table above and the resulting action is recorded as a
   decision.
5. If stage 2 runs, the decision rule is applied as written, with the losing method's numbers
   published alongside the winner's.
