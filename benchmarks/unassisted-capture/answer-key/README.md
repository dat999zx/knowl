# Answer key: how it was built, and what is wrong with it

Written 2026-07-31, after cold labelling all 32 sessions and before any method ran.

## What is here

| File | Contents |
| --- | --- |
| `gold.ndjson` | 32 sessions, 32 items — 29 `findable`, 3 `thinking-only`. Ten sessions carry no items. |
| `calibration-pairs.json` | 20 hand-judged pairs, 10 same-fact and 10 different-fact. |
| `threshold.json` | The frozen match threshold produced from those pairs. **See the blocker below.** |

Labelling followed the strictness standard preregistered in the design spec: an item enters
only if it is durable, specific, not trivially recoverable from current code, and grounded in
that session. Command inventories, "the suite passed", and bare file-change lists were
rejected by construction.

## Blocker 1: the threshold failed its own calibration gate

The plan requires calibration agreement ≥ 0.90 before the threshold may be used. **Measured
agreement is 0.80** at threshold 0.4012 — 4 of 20 pairs misclassified.

The two classes overlap and cannot be separated by this embedder:

| Class | Similarity range |
| --- | --- |
| Same fact, different words | 0.422 – 0.753 |
| Different facts, shared project vocabulary | 0.002 – 0.559 |

The four misclassified pairs are all *different* facts scoring inside the same-fact range:

- "Session events are hard-deleted after 48 hours" vs "the purge only runs at session start" — 0.443
- "ByteRover retrieval is BM25 only" vs "ByteRover stores its context tree as markdown under git" — 0.559
- "Ownership is stamped only by the join-time backfill" vs "joining consumed unreleased repo names" — 0.509
- "A local and a peer change were reported as one item" vs "one change is announced by both channels" — 0.456

**The labels are not the problem — the embedder is.** Each of those pairs states two genuinely
different facts about the same subsystem. `Xenova/all-MiniLM-L6-v2` at 384 dimensions scores
topical relatedness, and within one project almost everything is topically related.

The plan's remedy — "revise the pairs, not the threshold" — does not honestly apply. Making
the different-pairs less near-miss would manufacture separability that the real
prediction-versus-gold comparison will not have, since real predictions are exactly
near-misses. **Any recall or precision figure computed with this matcher carries a roughly
20% pairwise error rate**, which is too coarse for a 20-point architecture decision.

Options, none taken unilaterally: adjudicate every pair by hand rather than only the ±0.10
band; use a stronger embedding model and re-preregister; or accept a wider band and a
correspondingly larger adjudication burden.

## Blocker 2: no working model credential

`config.ai` is null and the `OPENAI_API_KEY` in the environment returns 401. Method 2 cannot
run. Nothing was spent.

## The seed audit — and it went against me

The 41 items the model stored during these sessions were held back until cold labelling
finished, then compared. They were meant to audit the labeller. They did.

**The time-window join over-attributes.** Seed items are matched to a session by `created_at`
falling inside the session window, because knowledge items carry no session foreign key.
Two long sessions swallow items that concurrent sessions wrote: `339c502b` (12 hours) claims
8 items including several plainly from other work, and `6ce1193b` claims 8 more including
`Work Loop checkpoint` noise. Any per-session comparison against seeds is unreliable for those
two, and the audit below excludes them.

**Genuine misses in my answer key**, items the model judged durable that I did not record:

| Session | Item I missed | Verdict |
| --- | --- | --- |
| `987e4038` | Cross-repo advisory was silent for decisions while it fired for stores | Real miss — derivable from the `fix(decide)` commit message |
| `66be0607` | Scopeless exclusive conflict keys never worked; `eq(column, null)` renders as `= NULL` | Real miss — durable and specific |
| `e52ac7ec` | `releaseAll` now checkpoints WAL before closing, which was behind two long-standing test workarounds | Real miss |
| `0dbcd506` | Promote has accepted NULL `origin_repo` since 2.5.0; the cost is the remove guard | Real miss — I recorded nothing for this session |
| `1e14536b` | The write-path crash appeared at roughly 2,000 writes | Partial — I recorded the fix, not the threshold |

**Not misses:** `Work Loop checkpoint`, `Work Loop finish`, `Pending session handoff`, and
`Session outcome: …` are the promoted noise the capture spec already identifies as worthless.
Excluding them is the standard working as intended.

### What the audit means

Of roughly 25 seed items attributable to a single session, I missed 4 outright and partly
missed 1. **The answer key is under-inclusive by something like 15–20%.** An under-inclusive
key understates recall for every method equally, so it does not favour one architecture over
the other — but it does mean the absolute recall numbers are a floor, not an estimate, and
they must be published that way.

The concrete cause is worth recording: I under-weighted facts stated only in a **git commit
message embedded in a command string**. Those messages turn out to be the single richest
signal in the hook stream, and I skimmed them while reading the surrounding command noise.
A method that reads them carefully will beat this labeller on exactly those items.

## Status

The answer key is usable but flawed in a known, measured direction. The experiment should not
produce a headline number until Blocker 1 is resolved, because a 20% matcher error rate cannot
support a 20-point decision margin.
