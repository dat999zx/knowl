# The guidance card: what it costs, what it buys, and where its ceiling came from

Run 2026-08-18 against this machine's Claude Code transcript archive, at `5957bb7`. Harness:
`npm run measure:card` (`scripts/measure-card-cost.ts`). Nothing is written and no network is
touched.

**Every number below is rendered or counted by the script.** Card sizes come from
`src/core/knowl-guidance.ts` and the `tools/list` payload they are compared against comes from
`knowlToolDefinitions`. That is not a stylistic preference: the first version of this document
hard-coded the `tools/list` comparison, and it was already wrong by a third — 22,394 characters
against a real 34,507 — which inverted the conclusion it was there to support.

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

It is also asserted three times where once would do. In `tests/core/knowl-guidance.test.ts`:

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
change is invisible to them. Grepping `benchmarks/` and `scripts/` for the card constants returned
nothing before this script existed.

---

## 1. The instrument, and the four ways it can lie

The same archive `docs/evals/agent-surface.md` used to refute the keyword cap: real sessions, where
the card's rules either changed agent behaviour or did not. Each of these corrupted an earlier run
of this measurement, so each is now handled in the script rather than described here.

1. **Duplicate project trees.** A drive move can leave a `d--*` archive directory copying `c--*`.
   Session ids are uuids, so a filename seen twice is one session reached by two paths, and
   counting both doubles every figure — an early run reported 422 sessions and 44k tok/month,
   exactly 2× wrong. The script keeps the **most recently modified** copy. It does not keep the
   first one alphabetically: ASCII sort puts `C--x` before `c--x`, so that rule reliably kept the
   *pre-move, staler* tree and discarded every call recorded since. Copies that differ in size are
   reported rather than assumed identical.
2. **Subagent transcripts outnumber main sessions.** On this machine, 192 main sessions against 166
   under `<sessionId>/subagents/`. A probe established the MCP `instructions` block never reaches a
   subagent — which is why `KNOWL_SUBAGENT_BOOTSTRAP_CARD` exists — so including them would price a
   card they were never sent. The script counts only depth-1 `.jsonl` files and reports what it
   skipped.
3. **Averaging across days before the card existed.** The rate that matters is sessions per day
   *while the card is being sent*. An earlier run divided by a 143-day span of which 117 predated
   the card, understating the cost several-fold. The window now starts at the card's creation date
   by default; `--all` widens it and says so in the output.
4. **Rows that do not sum.** The group table assigned each call to the first matching pattern and
   silently dropped the rest, while still counting them in the denominator — so a table that looked
   like full coverage was missing calls, including every transcript tool. Since the transcript
   route line is the +105 characters that make the card binding, the analysis of "where room
   exists" was structurally blind to the line that consumed the room. There is now a `transcripts`
   group and an explicit `other (unrouted)` row, and the rows sum to the total.

A project counts as knowl-configured when any session in it ever reached a knowl tool. That
undercounts projects configured but unused, so the cost figures are conservative in that direction.

---

## 2. What the card costs

186 sessions across 13 knowl-configured projects, 2026-07-21 → 2026-08-18 (28 days, 6.6/day).

**13.4% of paying sessions never called a knowl tool at all.** They paid the card for nothing.

| card | chars | tok/session | tok/day | tok/month |
| --- | --- | --- | --- | --- |
| claude | 1,828 | 457 | 3,006 | 90.2k |
| server | 1,879 | 470 | 3,091 | 92.7k |
| **server + transcripts** | **1,984** | **496** | **3,262** | **97.9k** |

Headroom on the binding variant: **16 characters**. Each additional 100 characters costs
**4.93k tok/month** at this session rate.

The `claude` row is priced for comparison only — **nothing currently delivers
`KNOWL_CLAUDE_OPERATIONAL_CARD`.** Grepping `src/` finds only its definition; the `SessionStart`
`additionalContext` wiring a 2026-07 design doc describes was never built. The two server rows are
live.

**For scale, measured in the same run:** `tools/list` in the *same handshake* is 30 tools and
**34,507 characters ≈ 8,627 tokens**. The binding card is **5.7%** of what knowl already spends in
the payload delivered beside it.

Only 2,000 is a decision. 1,828 / 1,879 / 1,984 are one card in three configurations — claude→server
is one swapped mode line (+51), transcripts adds one route bullet (+105). All three are pinned to
exact equality as change tripwires.

**These rates are this machine's.** 6.6 sessions/day is a heavy-use developer archive; the
per-session character counts are universal, the per-month totals scale with whoever is measured.

---

## 3. What the card buys — not answerable from this archive

The intended measurement is compliance with rule one (query before reading repository files), split
on the card's creation date. This archive cannot supply it:

| | before (n=3) | after (n=145) |
| --- | --- | --- |
| queried before first file read | 33.3% | **89.0%** |
| read files first | 66.7% | 7.6% |
| never queried at all | 0.0% | 3.4% |

**n=3 is not a baseline.** The archive begins 2026-07-15, six days before the card shipped, so
there is almost no "before" to compare against. The 89.0% post-card figure is solid and the
pre-card column is noise. An earlier run of this eval on a longer archive reported 13.5% → 72.8%
over n=52 / n=114; that is not reproduced here and is not restated as a finding.

Whatever the split, **it is observational, not an A/B, and the caveat must travel with the
number.** The card, the lifecycle hooks, `KNOWL.md` and the prompt reminder arrived as one guidance
system. A gain says the system works; it cannot attribute the gain to the 2,000 characters alone.

To reproduce on a longer archive: `npm run measure:card -- --all`.

---

## 4. Where room exists

Share of 2,009 observed knowl calls in the window. Rows sum to the total.

| calls | share | group |
| --- | --- | --- |
| 1,111 | 55.3% | durable writes |
| 835 | 41.6% | retrieval |
| 41 | 2.0% | skills |
| 13 | 0.6% | other (unrouted) |
| 4 | 0.2% | transcripts |
| 3 | 0.1% | leaving work |
| 2 | 0.1% | audit |
| 0 | 0.0% | work loop |
| 0 | 0.0% | special |

Writes and retrieval are **96.9% of all traffic**. Audit, special, leaving-work and transcripts
together carry **9 calls, 0.4%**, for roughly 450 characters of route bullets — the cheapest
measured place to buy room, if room is to be bought.

The `other` row is `mcp__knowl__knowl_cloud`, which the routing table does not mention at all. That
is a finding in its own right rather than a rounding error: a tool called 13 times has no line in
the surface that tells an agent when to call it.

**Three honest limits on reading the tail as dead weight.** The work-loop line reads zero calls, but
zero is exactly what its rule asks for when lifecycle hooks are active, and they always are on this
machine — this cannot separate "the prohibition works" from "irrelevant here". Low call volume is
not low value; a skill read once can decide a session. And share-of-calls measures *use*, not
*routing quality*: a line that stops a wrong call from happening produces no calls to count.

---

## 5. What this settles, and what it does not

**Settled:** the ceiling is a convention, not a measurement, and it is now priced. On this archive a
100-character line costs 4.93k tok/month against a 97.9k baseline that is itself 5.7% of its own
handshake — so the card is small next to what ships beside it, and not free.

**Not settled:** whether to spend the remaining 16 characters, or buy more. Buying room means
compressing prose that has a retrieval eval behind it, and this script measures cost and observed
use — not what compression would do to routing quality. Pair it with `npm run benchmark:accuracy`
before shipping a trim.

**Also not settled:** what the card buys, quantitatively. §3 needs an archive with real pre-card
history to say anything, and this one does not have it.
