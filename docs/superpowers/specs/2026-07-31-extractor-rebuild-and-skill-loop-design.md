# Extractor rebuild and the skill loop

Date: 2026-07-31
Status: approved for planning
Baseline commit: `92dd859`
Supersedes section 2 ("The extractor, rebuilt") of
`docs/superpowers/specs/2026-07-31-unassisted-capture-design.md`, which proposed four rules
before any of them had been measured.

## Why this replaces the earlier rule set

The capture experiment (`docs/superpowers/specs/2026-07-31-capture-architecture-experiment-design.md`)
measured, over 32 real sessions, where capturable knowledge actually lives:

| Source field | Share of findable answer-key items |
| --- | --- |
| Git commit subject, inside `command` text | **52%** |
| `error.message` | **45%** |
| Other command text | 3% |
| `changedPaths` alone | **0%** |

Against the four rules the earlier spec proposed:

| Proposed rule | Keys on | Measured |
| --- | --- | --- |
| Failure→fix pair | `error` events | 45% — keep |
| Co-edit coupling | files changed together | **0% — delete** |
| Session outcome from `stop.status` | stop status | 0% — delete |
| Repeated-command skill | command repetition | 0% of *facts*, but see Phase 2 |
| *(absent)* | **git commit subject** | **52% — the largest source, unbuilt** |

Two corrections to that measurement, both published rather than buried:

1. **The answer key measured facts, not procedures.** It contains no procedural items, so the
   0% for command repetition says nothing about skills. Deleting that rule on this evidence
   would have been an over-reach; Phase 2 rebuilds it instead.
2. **The repeated-command rule is not inert.** The earlier baseline claimed no session ever
   repeats a command three times; four `Repeated workflow:` items exist, two produced by the
   experiment's own session. It fires, and what it writes is worthless.

## Phase 1 — fact extraction

Independently shippable. No model involvement; `finalizeMemorySession` keeps reporting
`usedAi: false`.

### 1.1 Commit-subject rule (new, largest source)

Git commit subjects survive in the payload because the whole command string is captured.
36 subjects are recoverable across 14 of the 32 corpus sessions, from either form:

- `git commit ... -m "subject"`
- `git commit -q -F - <<'EOF'` followed by the subject on the next line

Emit one item per commit, category chosen from the conventional-commit type where present
(`fix:` → `fact`, `feat:` → `architecture`, `refactor:`/`perf:` → `architecture`,
`docs:`/`test:`/`chore:` → skip). Content carries the subject and the body when the heredoc
form supplies one; evidence links the `command` event.

**Skip rule:** `docs:`, `test:`, `chore:`, and merge commits produce no item. They are
process, not knowledge — the same reason `Work Loop finish` is noise.

### 1.2 Failure→fix rule (already specified, now measured at 45%)

An `error` event, then `checkpoint` events carrying `changedPaths`, then no further error
with the same signature before the session ends. Signature is a normalised form of the error
message — exception class, code, and first frame, with paths, line numbers and hex addresses
stripped — not raw equality.

The corpus supports this: 44 error events, 43 carrying substantive text, median 862
characters. 16 of 32 sessions contain at least one error.

### 1.3 Deletions

- **Co-edit coupling** — measured at 0%. Changed paths record where work happened, never what
  was learned. Delete rather than re-tune.
- **Session outcome from `stop.status`** — 0%, and the source of `Session outcome: …` noise.

## Phase 2 — the skill loop

Depends on nothing in Phase 1 and can be deferred without blocking it.

### 2.1 What is actually broken

The skill machinery works and is simply unused. `indexSkillPackage`
(`src/skills/knowledge-index.ts:14-28`) writes a knowledge item whose `title` and `source`
are exactly what `recordSkillRun` matches on, so `knowl skill create` followed by
`knowl skill run` would track usage correctly today. `.knowl/skills/` does not exist because
nobody has ever created a package.

The gap is the **shape the extractor writes**: plain rows with `source: NULL` and zero steps,
which `knowl_skill_run` cannot reach. The blocker is the writer, not the runner.

### 2.2 Capture: ask during the session, not after it

The present rule fires in `finalizeMemorySession`, after the agent has gone. That is why the
four stored items say `ran 3 times` — there is nobody left to ask what the command was for.

Move the trigger to `PostToolUse`. On the qualifying repeat, return a nudge through
`profile.midTurnContext()` — the same channel the change card and continuation reminder
already use, **and which carries at most one message per tool event**. See "The channel is a
single contended slot" below before implementing either nudge.

> You have run this command N times. If it is a reusable workflow, save it with
> `knowl_skill_create` and say what it is for.

The agent writes the purpose while it still knows it. **This makes skill capture
model-dependent, deliberately.** Facts stay model-free; a procedure with no stated purpose is
useless, and only the agent knows the purpose. The split is intentional and is recorded here
so it is not mistaken for erosion of the `usedAi: false` property, which Phase 1 preserves.

**Trigger, tightened.** Three repeats within one session is too eager — it fired twice during
the experiment's own session for ordinary test runs. Qualify on repetition **and**
non-obviousness: the command must contain a pipe, a redirect, or a filter. A bare `npm test`
never qualifies; `npm run typecheck:bench 2>&1 | grep "benchmarks/unassisted-capture"` does,
because the filter encodes the fact that the typecheck is already red.

**Amended 2026-08-01 by review.** This rule originally also counted a platform-specific
binary (`npm.cmd`, `npx.cmd`) as non-obvious. That contradicted its own next sentence on the
only platform this project runs on: under a Windows shell `npm.cmd test` *is* `npm test`, so
the rule made the bare command it excludes qualify through a suffix the shell added. `.cmd`
is no longer part of the pattern.

**The nudge fires once**, on the run that reaches the threshold — not on every run at or
above it, which re-asked the same question indefinitely. Only successful runs count toward
the threshold: a command that fails three times is being debugged, not repeated as a
workflow.

**Known limitation of the count: it is per turn, not per session.** The nudge therefore says
"N times this turn". The count comes from the memory session bound to
`bindingKey(input, 'turn')`, and `Stop` closes that binding, so repeats reset at every turn
boundary. A workflow repeated once per turn across five turns is never noticed. Making the
count session-scoped means rebinding the counter away from the turn session, which is a
larger change than the loop needs today; it is recorded here rather than fixed.

**Never auto-run.** A captured command becomes an executable artifact built from an unvetted
shell string; one existing captured item embeds a hardcoded scratch path from a session that
no longer exists. Capture may suggest and may save; it must never execute.

### 2.2b The channel is a single contended slot, with an existing precedence

Verified in `src/store/host-lifecycle.ts:400-425`. This was not known when 2.2 and 2.4 were
first written, and it constrains both.

`profile.midTurnContext(text)` carries **one message per tool event** — the code says so
outright ("At most one card per tool event, never two"). Two senders already claim it, in
strict order:

1. **The change card**, when `evaluateChangeNotification` reports a peer or local change. It
   wins outright, resets the drift counter, and suppresses the reminder for that event.
2. **The continuation reminder**, only after `KNOWL_REMINDER_DRIFT` consecutive successful
   tool calls that used no Knowl tool. Any Knowl tool call resets the counter.

So a skill message is a **third** claimant, and "fire rarely" is not a design — the
implementation must state its priority. **Fixed here, before implementation:**

- A skill message **never displaces a change card.** That card carries knowledge the agent
  does not have; a suggestion is strictly less urgent.
- A skill message **may displace the continuation reminder**, which is generic. A specific,
  actionable suggestion is a better use of the same slot.
- The capture nudge (2.2) and the retrieval nudge (2.4) must not both fire on one event. If
  both qualify, capture wins — recording a workflow the agent is actively repeating is
  worth more than pointing at one it has already started. **Amended 2026-08-01 by review:
  except when a saved skill already covers the command**, in which case retrieval speaks and
  capture stays silent. The unconditional rule asked the agent to save a skill that already
  existed, so complying with the nudge did not silence it and the loop never closed. Capture
  still outranks retrieval for a genuinely *new* workflow, which is what the rule was for.
- **A skill message resets the drift counter**, on the same reasoning as the change card: it
  occupies the single slot for that event, so a branch that neither reset nor incremented
  the counter would freeze it and suppress the continuation reminder indefinitely rather
  than for one event.

Counting the session-start card and the v2.9.0 drift warning, an agent faces five channels
in total. That is the reason route 1 comes first: it needs no slot at all.

### 2.3 Retrieval, route 1: skills in the session-start card

`bootstrapAgentSession` composes the card from `getRecentContext`, capped at
`DEFAULT_CONTEXT_MAX_CHARS` and already sharing that budget with the drift warning. Add a
short skills section listing name and purpose only — not steps.

An agent that already knows a skill exists needs no interruption, which is why this route
comes first. It costs context rather than latency.

**It must fit inside the existing cap, not extend it.** The budget is already contended; a
skills section that pushes recent context out has made things worse.

### 2.4 Retrieval, route 2: the after-the-fact nudge

Knowl has no `PreToolUse` hook — `PostToolUse` is the only mid-execution channel, so a
command cannot be intercepted before it runs. What is possible is telling the agent
afterwards that a saved skill covers what it just started.

This is late for a one-off command and genuinely useful for a sequence: catching step one of
a five-step procedure still saves four steps.

**Fire rarely.** The agent already receives a session-start card, a change notice, a drift
warning, and a continuation reminder. A fifth channel that fires often will cause all five to
be ignored. Suggest only when the match is strong **and** the skill does materially more than
the single command just run.

### 2.5 `PreToolUse` is the escape hatch, not the plan

Claude Code emits `PreToolUse`; Knowl never mapped it. It is the only way to intervene before
a command runs, and it fires on **every** tool call, putting Knowl on the critical path of
every agent action.

Build it only if route 3 demonstrably fails — that is, if agents given skills in context still
do not use them. Cost is certain, benefit is not.

## Out of scope

Stage 2 of the capture experiment (rules versus model, head to head). It cannot be settled by
a matcher running at 0.80 agreement against a 20-point margin, and Phase 1 proceeds on the
signal attribution instead, which does not route through the matcher.

Extending the answer key, adjudicating the 48 band pairs, and replacing the embedder. All
worth doing; none blocks this.

## Success criteria

1. Commit-subject and failure→fix rules ship, with the co-edit and stop-status rules deleted.
2. A session that produces commits and recovers from an error yields items naming what
   changed and what failed — verified against the committed 32-session corpus, which makes
   this testable without waiting for new sessions.
3. `finalizeMemorySession` still reports `usedAi: false` for facts.
4. No `Repeated workflow:` item is ever written again in that shape.
5. A skill saved through the new path is reachable by `knowl_skill_run` and increments
   `usage_count` — the first time any skill in this repo has done so.
6. The session-start card carries skills without exceeding its existing character cap.

## Open question for the plan

Whether the four existing `Repeated workflow:` items and the one `Verified command:` item are
retired on migration or left as historical noise. Retiring them is a data change and should
be an explicit decision, not a side effect of shipping.
