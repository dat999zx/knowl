# The subagent card: what a child actually received, and what the recent-knowledge block was buying

Run 2026-08-27 against this machine's stores and a 12-subagent A/B on Claude Code 2.1.221.
Companion to `guidance-card-cost.md`, which derived the *ceiling* for the compact card; this
derives the *composition* of the block that follows it for a subagent.

Two independent findings. The first is a defect and is the more consequential of the two. The
second is the measurement that decided what replaces the removed block.

---

## 1. A subagent in a linked workspace received no skills and no knowledge

`bootstrapAgentContext` took the parent's rendered card and sliced it:

```ts
const cap = Math.floor(DEFAULT_CONTEXT_MAX_CHARS / 2);            // 1500
const recentBudget = Math.max(0, cap - KNOWL_SUBAGENT_BOOTSTRAP_CARD.length - 2);  // 853
const recent = bootstrap.context ? truncateText(bootstrap.context, recentBudget) : undefined;
```

Section offsets in the **real** rendered card, counted on this repo's own four-repo `duck`
workspace:

| cumulative chars | section |
| ---: | --- |
| 129 | header + `PROVENANCE` notice |
| 1,163 | + workspace section (**the repo list alone is 1,034**) |
| 1,860 | + skills section |
| 1,888 | `## Recent Active Knowledge` begins |

The cut lands at **853**. It does not reach the skills heading, let alone the knowledge. A
subagent received the header and a repo list truncated mid-entry, and nothing else.

**Why the skills half is the serious one.** `context-bootstrap.ts` states the reason the skills
section exists at all, twice: `getRecentContext` "returns only the three most recent items of any
category, so a skill created last month would never appear", and a peer repo's shared skill "could
be found only by an agent who already knew to ask for it, which is exactly the agent who does not
know the tooling exists". Recent knowledge is recoverable by querying. Ambient skill discovery is
not. The slice dropped precisely the non-recoverable half.

**Why nothing caught it.** `format.ts` already clamps the skills section — `skillBudget` is a
quarter of the cap — with a comment naming this exact failure shape: "an unclamped quarter is
unbounded and, since skills render first, would push recent knowledge out of the card entirely."
Nothing clamps the workspace section, which renders *before* skills and grows with each linked
repo. Four repos already exceed a subagent's entire budget on the repo list alone.

**Scope.** Unlinked projects are unaffected: `workspaceSection` is absent and produces
byte-identical output, so the header leaves the skills section room. This is a linked-workspace
defect, it scales with repo count, and it therefore bites the team configuration hardest.

**Adjacent case, deliberately not changed here.** The parent session-start path at
`host-lifecycle.ts` has the same blind-slice shape against the full 3,000 budget. It clears 1,888
on this workspace so it does render knowledge — but when a staleness or drift warning is present,
`recentBudget` shrinks by the warning's length and the same squeeze applies. Out of scope; noted so
the next reader does not assume it was considered and dismissed.

---

## 2. Recent-item titles were being answered *from*, not queried against

Three arms, six Claude Code subagents each (sonnet), one task, identical guidance card. The arms
differ **only** in the block following the card. The task deliberately contained none of the
retrieval vocabulary, so the agent had to decide for itself to look:

> We want several coding agents working in parallel worktrees to stop building on things a sibling
> has already invalidated. Propose the mechanism you would build.

| arm | block | called `knowl_query` | subagent tokens |
| --- | --- | ---: | ---: |
| A | 853 chars — 5 item titles (the shipped size) | **6 / 6** | ~40k |
| B | 2,353 chars — 13 item titles (un-halved) | **1 / 6** | ~33k |
| C | ~120 chars — a bare pointer, no answerable content | **6 / 6** | ~40k |

Fisher exact, one-tailed, B against A: `C(7,6)/C(12,6)` = **p = 0.0076**.

The relationship is monotonic and the direction is the surprise: **the more answerable content the
card carries, the less the child retrieves.** Arm B is also the *cheapest* arm, because it never
looks anything up — a cost saving that is entirely the defect.

**What the arms actually produced.** Arms A and C opened atoms and cited body-level detail their
titles do not contain — Salsa backdating, the ~12%-actionable drift figure, CALM's non-monotonicity
argument, the out-of-repo worktree blackout. The five non-retrieving arm B agents recombined their
own injected titles and cited nothing that was not already in front of them; "Canopy", "one join
away" and "the ledger has no notion of truth" are verbatim title fragments. Arm B's answers read as
good or better while being assembled entirely from summaries.

**Consequence.** A pointer cannot be answered from. It costs a seventh of arm A's bytes and buys
the same lookup, which is why the block is now a pointer and no count is printed beside it —
`getRecentContext` returns at most three items regardless of store size, so any count in scope
would understate the store and read as a reason not to bother.

---

## What was changed

- `formatRecentContextToMarkdown` gained `compactWorkspace` (names and write-visibility only,
  dropping the unbounded `role` prose) and `knowledgeAsPointer`.
- `bootstrapAgentSession` gained `agentCap`, which **composes** the card for a subagent's budget
  instead of returning the parent's card for a caller to slice.
- `bootstrapAgentContext` passes the cap and no longer truncates.

## Caveats

1. n = 18 subagents across three arms, one task, one model. Real, and thin.
2. Every probe agent additionally received the live `SubagentStart` card, so arm A carried a
   doubled baseline. What the experiment tested is the **contrast** between blocks, not their
   absolute effect.
3. A discarded first probe put the retrieval vocabulary in the task text and hit the ceiling —
   6/6 correct in both arms. That failure is itself a result: a thin card does not hurt when the
   agent is handed its query. It hurts when the agent must work out that it should look.
4. Finding 1 makes arm A of finding 2 *more generous than production had been*: on a linked
   workspace those titles were not reaching the child at all.
