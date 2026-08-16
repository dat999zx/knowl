# The guidance card: what it costs, what it buys, and where its ceiling came from

Run 2026-08-16 against this machine's Claude Code transcript archive. Harness:
`npx tsx scripts/measure-card-cost.ts` (`npm run measure:card`). Nothing is written and no network
is touched; card sizes are rendered from `src/core/knowl-guidance.ts`, never hard-coded.

**Why this exists.** The compact card is the one surface charged to every session of every user,
and it was the only budget in this repository with no derivation. Its neighbours in
`src/core/token-budget.ts` each carry one inline: `MAX_ITEM_CONTENT_CHARS` has a four-row cost
table over 556 real items, `MAX_TITLE_CHARS` cites p50 62 / p90 100 / p99 120, `MAX_AFFECTED_PATHS`
cites percentiles over 710. The 2,000-character ceiling had none.

---

## 0. Where 2,000 came from

`git log -S` puts both the ceiling and its `20 *` multiplier in a single commit — **`1a65701`
"feat: add canonical Knowl guidance renderers" (2026-07-21)**, the commit that *created* the
renderers. The message is one bare line with no rationale. The number therefore predates the thing
it bounds having any measured cost: it is a requirement, not a finding.

It is also asserted three times where once would do. At `tests/core/knowl-guidance.test.ts:132-137`:

```js
card.length < 2_000
Math.ceil(card.length / 4) <= 500
20 * Math.ceil(card.length / 4) <= 10_000
```

For integer `n`, `ceil(x) <= n` iff `x <= n`. So the second **is** `length <= 2000`, and the third
is exactly the second. Only the first can ever fail; the `20×` reads like a fan-out budget but buys
no independent guarantee.

**The existing accuracy harness cannot supply a derivation.** `npm run benchmark:accuracy` and the
retrieval suites drive `queryKnowledge()` directly, so the ranker never sees the card and a card
change is invisible to them. `grep -rln 'OPERATIONAL_CARD|SERVER_INSTRUCTIONS|mcpServerInstructions'
benchmarks/ scripts/` returned nothing before this script existed.

---

## 1. The instrument

The same archive `docs/evals/agent-surface.md` used to refute the keyword cap: real sessions, where
the card's rules either changed agent behaviour or did not.

**Two traps, both of which silently corrupt the numbers.**

1. **Byte-identical duplicate project trees.** The 2026-08-12 drive move left `d--*` archive
   directories that are exact copies of `c--*` — verified 53/53 matching filenames, same size,
   same mtime, same bytes. Counting both doubles every figure. The first run of this measurement
   reported 422 sessions and 44k tok/month, both exactly 2× wrong. Session ids are uuids, so the
   script drops a filename it has already seen.
2. **Subagent transcripts outnumber sessions 5:1.** Of 2,268 `.jsonl` files, only 349 are main
   sessions; 1,919 sit under `<sessionId>/subagents/`. A probe established the MCP `instructions`
   block never reaches a subagent — which is why `KNOWL_SUBAGENT_BOOTSTRAP_CARD` exists — so
   including them would price a card they were never sent.

A project counts as knowl-configured when any session in it ever reached a knowl tool. That
undercounts projects configured but unused, so every cost figure below is **conservative**.

---

## 2. What the card costs

210 sessions across 5 knowl-configured projects, 2026-03-26 → 2026-08-16 (143 days, 1.5/day).

**29.5% of paying sessions never called a knowl tool at all.** They paid the card for nothing, and
that is the common case, not an edge case.

| card | chars | tok/session | tok/day | tok/month |
| --- | --- | --- | --- | --- |
| claude | 1,833 | 459 | 674 | 20.2k |
| server | 1,884 | 471 | 692 | 20.8k |
| **server + transcripts** | **1,989** | **498** | **732** | **21.9k** |
| the 2,000 ceiling | 2,000 | 500 | 735 | 22.0k |

Headroom on the binding variant: **11 characters**. Each additional 100 characters costs
**1.10k tok/month** at this session rate.

**For scale:** `tools/list` in the *same handshake* is 22,394 characters = 5,599 tokens. The card is
**8.9%** of what knowl already spends in the payload delivered beside it.

Only 2,000 is a decision. 1,833 / 1,884 / 1,989 are measurements of one card in three
configurations — claude→server is one swapped mode line (+51), transcripts adds one route bullet
(+105). Note that 1,833 and 1,884 are pinned to exact equality as change tripwires, while **1,989
is only bounded** — the variant that actually binds is the one no test pins.

---

## 3. What the card buys

Sessions that read repository files at all, split on the card's creation date. Sessions before it
never saw it.

| | before (n=52) | after (n=114) |
| --- | --- | --- |
| queried before first file read | 13.5% | **72.8%** |
| read files first | 26.9% | 20.2% |
| never queried at all | 59.6% | **7.0%** |

**This is observational, not an A/B, and the caveat must travel with the number.** The card, the
lifecycle hooks, `KNOWL.md` and the prompt reminder all arrived as one guidance system. This says
the system works. It cannot attribute the gain to the 2,000 characters in isolation.

---

## 4. Where room exists

Share of 1,933 observed knowl calls:

| share | group |
| --- | --- |
| 62.5% | durable writes |
| 33.5% | retrieval |
| 1.1% | leaving work |
| 0.3% | audit |
| 0.3% | skills |
| 0.1% | special |
| 0.0% | work loop |

Writes and retrieval are **96% of all traffic**. Audit, skills and special together carry **0.7% of
calls for roughly 450 characters** of route bullets — the cheapest measured place to buy room.

**Two honest limits on reading that as dead weight.** The work-loop line reads zero calls, but zero
is exactly what its own rule asks for when lifecycle hooks are active, and they always are on this
machine; this data cannot separate "the prohibition works" from "irrelevant here". And low call
volume is not low value — a skill read once can decide a session.

---

## 5. What this settles, and what it does not

**Settled:** the ceiling is a convention, not a measurement, and it is now priced. A line costing
67 characters costs 0.75k tok/month against a 21.9k baseline that is itself 8.9% of its own
handshake.

**Not settled:** whether to spend those characters. Buying room means compressing prose that has a
retrieval eval behind it, and this script measures cost and observed use — not what compression
would do to routing quality. Pair it with `npm run benchmark:accuracy` before shipping a trim.
