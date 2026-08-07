# Live change impact — detection, and why detection alone is worthless

Plan for handling the case where one actor's in-progress code change invalidates another
agent's unfinished work. Written 2026-08-05.

> **What is in this branch, and what is not.** This document describes the whole arc, including
> the part that is *not* here. This branch is **detection only**: the read-set, certain-tier
> findings, the card stanza and `knowl_impact`. It is off by default and it refuses nothing —
> every path through it is advisory, and every failure path allows the turn to proceed.
>
> The **write gate** of §7.5 — the `PreToolUse` refusal that is the mechanism the evidence
> actually supports — is deliberately proposed **separately**, so that accepting detection does
> not commit anyone to accepting enforcement. Two reasons it is split rather than bundled: its
> precision is not yet measured against §9's ≥95% bar, and §10 records four open bugs in the
> host's own hook implementation that bound what a refusal can currently guarantee. Detection is
> unaffected by all four.
>
> Read §7.5 and §10 as design, not as shipped behaviour.

**This is v2. It contradicts v1 (same path, earlier today) on its central design choice.** v1
proposed *detect → notify the stale agent*. A full prior-art pass found that notification is
measured at approximately zero effect, twice, independently. The corrected spine is
**detect → refuse**. §2 carries the evidence; §14 lists everything v1 got
wrong, including six factual errors about this codebase.

**v2.1, written after the build, corrects v2 on *where* the refusal lands.** v2 ruled
write-blocking out in §6 on the precondition *"knowl is an MCP server with no write path"* —
which is false, and it is the one transfer check I asserted from memory instead of checking
against the host's own documentation. `PreToolUse` can deny a tool call, and knowl already
registers hooks. The gate is therefore the **write**, not `knowl_task_finish`. §15 carries the
correction and what it cost; D-9 records it. Nothing else in v2 changed under the build.

Provenance of claims below: `[C]` = verified by reading this codebase, `[P]` = from a paper I
read, `[W]` = from vendor docs or community, `[?]` = unverified, flagged. Never mix them.

---

## 0. The verdict

Three findings, in order of how much they change what we build.

**1. Telling an agent its premise is stale does not fix it.** SWE-Touch [P] injected
task-conflicting edits mid-trajectory across 9 models, n=200 SWE-bench Verified × 3 runs.
Silent edit: −1.0 to −9.5 points. Edit **plus an explicit announcement of the edit**: no
consistent improvement, and *worse* than the silent case for 3 of 4 models tested. Verbatim:
*"even when users explicitly announce their edits, most models do not reliably use the
message to locate and reconcile the conflicting code."* CooperBench [P] reaches the same
conclusion from the opposite direction — a first-turn Plan message nearly halves the
merge-conflict rate (29.4% vs 51.5%) and moves end-to-end success by an amount that is *not
statistically significant*.

Both say the same thing: **conflict-rate is a vanity metric, and a notice is not an
intervention.**

**2. The problem is nevertheless real and large** — and my own earlier objection to it was a
scope error. SWE-Touch: mean −7.7 points resolve rate, **15.9% of majority-solved tasks
overturned**, and of the runs that flipped solved→unresolved, **63.3% ended with the
conflicting behaviour still active** ("retained conflict"). Its control is what makes this
credible: a *non-conflicting* external edit ("Co-Edit") costs −0.1 points across 7 models,
while the same 7 lose 7.2 points from a conflicting one. So the damage is not interruption or
noise. It is specifically unreconciled conflicting state.

**3. Nobody has published a detection-precision number for this problem** [P]. STORM rejects
**19–33% of writes** (81.2% acceptance at k=4, 67.1% at k=8) and never evaluates whether the
rejections were correct. CoAgent's entire architectural justification — that most read-set
overlaps are semantically benign — is asserted in §4.1 and never measured. That gap is both
the field's weakest point and the cheapest place to be better than it.

**Therefore the thing to build is not a warning system.** It is a **precision-measured
staleness detector wired to a verification gate**, where the gate does the work and the notice
is a courtesy.

---

## 1. Is the problem worth solving here?

Stated plainly, including the part that argues against building this.

**For:**
- Staleness costs real accuracy where it has been measured causally [P]: −7.7pp mean, 15.9%
  overturn, 63.3% retained conflict (SWE-Touch, 2608.02499).
- Agent PRs conflict textually at **27.67%** of 107,026 simulated merges [P] (AgenticFlict).
  A July follow-up finds **79.4% of agent PRs sit in a temporally co-active pair**, with
  19.8% intra-agent and 41.7% cross-agent conflict rates.
- **No platform ships cross-agent stale-read detection. Zero of seven** [W] — Claude Code,
  Codex, Cursor, Devin, Conductor, Amp, Windsurf(now Devin). Their Apr–Aug 2026 work is
  uniformly *isolation* (worktrees, VMs, locks), not *sensing*. Claude Code's own docs name
  the failure and offer prose: *"Two teammates editing the same file leads to overwrites.
  Break the work so each teammate owns a different set of files."*
- No product occupies the niche [W]. The closest, `mex` (1.4k★, MIT, active), does
  symbol-level `grounds_to` fingerprint staleness for **docs↔code drift on one timeline** —
  which is essentially knowl's existing drift engine, independently invented, and validates
  the mechanism without competing for the multi-agent case.
- Knowl already holds 60–70% of the substrate [C]. §3.

**Against — and this is the honest risk:**
- **There is no rigorous evidence that same-repo parallel agents is a common workflow** [W].
  What exists is a visible early-adopter minority, a dozen point-solution startups in under a
  year, and consistent practitioner convergence *away* from shared directories toward
  worktrees. If you assume a large population fighting this today, the evidence does not
  support it.
- Worktree isolation, now the default, already prevents the *textual* collision. What it does
  not prevent is the semantic one — best stated by a practitioner [W]: *"Agent A renames a
  type to X. Agent B, in a different worktree, independently renames the same type to Y. When
  you merge, neither worktree is 'wrong' but the code is incoherent."*

**Reading:** the addressable case is **not** "two agents editing one directory" (rare, and
being designed out). It is **semantic incoherence across isolated workspaces**, which
worktrees structurally cannot see and which grows *more* common as isolation becomes standard.
That reframing matters — it points the design at symbols and contracts, not at file locks.

---

## 2. Why v1's design was wrong

v1's spine: detect a stale read → push a notice into the agent's context via the change card
→ agent re-reads and replans. Every step after "detect" is unsupported.

| v1 assumed | evidence | source |
|---|---|---|
| A notice makes the agent reconcile | message-only ≈ noise (−2.0 to +3.0); message+edit worse than edit alone for 3/4 models | SWE-Touch [P] |
| Communication helps cooperation | halves conflicts, moves success **not significantly** | CooperBench [P] |
| Agents self-heal once informed | 28% of trajectories that *did* counteract the edit still ended unresolved | SWE-Touch [P] |
| A false positive is roughly free | tool-side noise costs **~20.8% mean accuracy**; agents are *more* sensitive to tool-side than user-side noise | AgentNoiseBench [W] |

That last row is the one that turns precision from a nice-to-have into an existential
constraint. Our notice would be delivered as tool-side context (`PostToolUse` →
`additionalContext`), which is empirically the *more* damaging channel to pollute. **A false
positive is not a wasted line; it is a measured accuracy hit.**

SWE-Touch's own conclusion names the only thing that worked: recovery requires opposing the
edit, producing a correct fix, **and confirming the repair passes verification**. Two of those
three are the agent's job. The third is a gate — and a gate is a thing software can own.

**Corrected spine:**

```
detect (precision-gated)  →  record  →  refuse to close unverified
                                     ↘  notice, as a courtesy that we do not count on
```

---

## 3. Ground truth — knowl's real surface

All `[C]`, read this session. v1 got several of these wrong; corrections are marked ✎.

| capability | where | state |
|---|---|---|
| Tree-sitter symbol extraction | `src/code/symbol-index.ts` | built, **CLI-only, whole-repo walk** ✎ |
| `code_files` / `code_symbols` / `code_symbol_edges` | `bootstrap.ts:216+` | built |
| Per-symbol `signature_hash` | `code_symbols.signature_hash` | built |
| Symbol staleness + **rename recovery** (≥0.6 name similarity → `suggestedLocator`) | `evidence-repository.ts:149-171` | built |
| Change → invalidation → audit commit | `drift.ts:72` `checkKnowledgeDrift` | built |
| Auto-drift trigger | `drift-auto.ts:89`, called from `host-lifecycle.ts:303` | **session-start only, `apply:false`** ✎ |
| Freshness state machine | `fresh \| stale \| needs_review` | built |
| Capped sibling propagation | `blast-radius.ts:18` `MAX_BLAST_RADIUS = 12` | built |
| Commit audit trail with before/after | `knowledge_commits`, `knowledge_commit_items` | built |
| Cross-repo change propagation | `loadForeignPeerChanges` | built |
| Per-agent session binding | `host-lifecycle.ts:70-75`, `__agent__:<id>` | built |
| **Per-tool file paths, reads included** | `host-hook.ts:105-115`, persisted `session-capture.ts:7` | **built** ✎ |
| Mid-turn delivery slot | `host-lifecycle.ts:403-461` | built, **single-occupancy** ✎ |
| Shared card renderer | `change-card.ts:21` `renderChangeCard` | built — **this is the integration point** ✎ |
| Hook debounce with atomic claim files | `hook-debounce.ts:89` | built |

**The four corrections that matter most:**

**✎ `change-notice.ts` is not the channel.** It suppresses itself on Claude Code and Codex via
`anotherChannelIsDelivering` (`change-notice.ts:94-99`), because `claudeProfile
.midTurnDeliveryVerified = true` (`hosts/claude.ts:41`). It exists for `claude-desktop`,
`generic` and `cursor`. The channel that actually reached me this session is the **hook**:
`host-lifecycle.ts:410-415`, `PostToolUse` → `{hookSpecificOutput:{additionalContext}}`. v1
cited the right evidence and the wrong file. The correct place to add a stanza is
`renderChangeCard` (`change-card.ts:21`), shared by both channels.

**✎ Reads are already captured — but reads and writes are indistinguishable.**
`changedPaths()` (`host-hook.ts:105-115`) falls back to `raw.file_path`, and `tool_input
.file_path` is allowlisted through the stdin filter (`lifecycle.ts:34`). So a `Read` emits a
path exactly as an `Edit` does. **But `NormalizedHostHook` has no `toolName` field** — it is
computed and discarded at `:215`. Fix is one field plus one line (`tool_name` is already
allowlisted at `lifecycle.ts:18`). Until then, "weight reads above greps" is not expressible.

**✎ `indexCode` is not incremental at the entry point.** `symbol-index.ts:152-168` walks the
**entire repo** and hashes **every** file on every call; the `content_hash` check at `:163`
only skips the re-parse and write. There is no per-file export. P-1 needs a new
`indexFile(root, relPath)`, not merely a trigger.

**✎ `runAutoDriftCheckBestEffort` runs `apply: false`, deliberately.** The comment at
`drift-auto.ts:17-40` records the measurement: one commit window matched 36/301 atoms, and
fifteen windows matched a third of the store — auto-flipping would pin the store at
`needs_review` forever. **This repo has already measured its own over-matching and refused to
act on it.** That is the precision problem, already conceded in code, and it is the strongest
in-repo argument for tiering.

---

## 4. The gap

**G-1 — The tick is committed-only.** `listChangedFilesSince` (`drift.ts:51`) is
`git diff --name-only a..b`. Uncommitted edits are invisible; "in-progress" means uncommitted.

**G-2 — No transitive reach, and no reference edges at all.** `CodeSymbolEdge['kind']` is
`'imports' | 'exports'` only (`types.ts:176`) — declared edges. "Who calls `createSession`" is
unanswerable, and `drift.ts` never traverses the edge table regardless.

**G-3 — Work is not an invalidation target.** Only `knowledge_items` can go stale. `grep` for
`readSet|filesRead|readPaths|touchedPaths` → zero hits. The raw path stream exists; nothing
keys it to a locator, hashes it at read time, or scopes it to a live task.

**G-4 — `checkKnowledgeDrift` is O(all active items × their evidence) per run** (`:81-96`).
Fine once per session. Fatal per tool call.

**G-5 — Detection only.** No verification gate, no test selection, no repair path.

**G-6 — Un-batched writes.** `replaceIndexedFile`/`deleteIndexedFile` (`symbol-index.ts
:130-150`) issue one `client.execute()` per symbol and per edge with **no transaction**, while
`withClientTransaction` exists (`database.ts:172`) and is used elsewhere. Un-batched SQLite
inserts run ~75–950/sec vs 50,000+/sec batched [W]. For a 30-symbol file this is plausibly the
dominant cost of indexing. Cheap to fix; fix it before measuring anything.

---

## 5. Constraints

**C-1 — This is a contribution, not a product.** `dat999zx/knowl` is third-party upstream;
`D:\Code\knowl` is the fork; standing decision 2026-08-05 is **no separate version**.
Consequences: additive schema only, off by default, no behaviour change when disabled, and
**the research doc's business-model section is out of scope entirely** — not rejected on
merit, simply not a unilateral call. Use `--repo William-Sommers/knowl` on every `gh` command.

**C-2 — MCP cannot push, and just got worse at it** [W]. Spec 2026-07-28 made MCP
**stateless** (SEP-2575): `initialize` and `Mcp-Session-Id` removed; server-initiated requests
replaced by MRTR (server may only respond `InputRequiredResult` to a call the client already
made); Roots, Sampling and Logging deprecated in the same revision. **There is no protocol-level
mechanism for a server to reach a running agent.** Delivery is therefore host-specific hooks
(Claude Code, Codex, Cursor, Devin CLI, Amp — all documented and GA) or nothing. Design
accordingly, and never on `subscriptions/listen`.

Corollary: **every injection point is a tool-call or turn boundary.** If agent A's edit lands
while agent B is mid-turn, B learns at its *next tool call*. There is no true async interrupt.

**C-3 — Precision is the product, and the bar is a published number.** Google Tricorder [W]:
a new analyzer must hold **<10% effective false positives** to be enabled at all; system-wide
runs **just under 5%**. Analyzers that don't improve get disabled. Combined with
AgentNoiseBench's ~20.8% degradation from tool-side noise, this is the design constraint:

> **Only the tier that is provably right may interrupt. Everything softer is pull-only.**

| tier | trigger | precision bar | delivery |
|---|---|---|---|
| **certain** | a locator in *this session's own read-set* changed hash | **≥95%**, measured | push (card) + **gate** |
| **likely** | one reference edge from something read | ≥70% | pull only |
| **possible** | path/title match (today's `matchedPaths`) | unmeasured | pull, marked weak |

`drift-auto.ts` already runs the `possible` tier and already refuses to act on it. That is the
precedent, not an innovation.

**C-4 — Prevalence is unproven.** §1. Build the phases so that the early ones are useful to a
*single* agent, so the bet does not depend on the multi-agent workflow becoming mainstream.
This is why P-1/P-2 are framed as "a code index that stays current" and "sessions know what
they read" — both defensible alone.

---

## 6. Transfer checks

Mechanism → precondition → does it hold here? Kill on failure. This is where most of v1 died.

| mechanism | precondition | holds here? |
|---|---|---|
| **STORM** — reject the write when a read is stale | ~~all writes flow through one mediated tool~~ → **some chokepoint can veto the write** | **YES for tool writes** — v2 got this row wrong and killed the mechanism on it (§15). The precondition is not mediation, it is *veto*, and Claude Code's `PreToolUse` hook has one: return `{hookSpecificOutput: {permissionDecision: 'deny', permissionDecisionReason}}` and the host blocks the call and shows the model the reason [W, code.claude.com/docs/en/hooks]. knowl already registers hooks, so it is already on the write path. Bash writes stay unmediated — STORM concedes the identical hole. → **We can block tool writes, and that is the mechanism.** |
| **STORM** — return current content + diff-since-your-read + stale deps | you have the read snapshot | **YES**, once G-3 exists. Adopt the payload shape. |
| **STORM** — file-level granularity | — | **REJECT.** Its own limitation: "two agents editing different functions in the same file trigger a false-positive rejection." We have symbol locators; use them. |
| **CoAgent** — advisory notify, agent repairs the affected part | agents consume notices and self-heal (its A2/A3) | **NO.** SWE-Touch measures A3 failing broadly. → the notice cannot be the mechanism. |
| **CoAgent** — MTPO: fix a serialization order at launch, serve each read the order-filtered value, apply writes speculatively in place, undo and reorder misplaced ones | every tool registers a **saga-style inverse in advance**, and the runtime owns launch order | **NO**, and the precondition is the whole reason. Not available through a memory server that joins a session already in progress. Worth stating that its numbers are good — 1.4× on 10 contended workloads, within 5% of serial correctness, near-serial token cost [P] — so this is a kill on transfer, not on merit. |
| **CAID** — test-gated sequential integration | an executable test suite | **YES**, for most repos. → **this is the transferable one.** |
| **CAID** — dependency-DAG task decomposition | a manager agent that owns planning | **NO** — that's an orchestrator. §11. |
| **Tricorder** — <10% FP or the check is disabled | you can measure FP | **Only if we build the measurement.** → §9 is not optional. |
| **Nx/Bazel/TAP** — reverse-dependency walk for affected set | a coarse, sound, already-maintained graph | **PARTIAL.** Ours is inferred and symbol-level, which has hub fan-in that package graphs don't. → depth cap mandatory; `MAX_BLAST_RADIUS = 12` is the in-repo precedent. |
| **STORM** — intent annotations: structured comments agents leave so the next reader sees intent, not just code | you may write into the user's source files | **NO.** A memory server that edits source to leave notes for other agents is a different product, and §11 already rules out mutating code. Its goal is served, weakly but honestly, by the was/now pair in the refusal. |
| **Atomix** [P, 2602.14849] — progress-aware transactions: buffer effects, seal when the footprint is complete, commit behind per-resource frontiers | effects are **bufferable** and externalised ones are **compensable** | **NO.** A `PreToolUse` hook is a veto, not a transaction manager: it can refuse a write, never hold one and replay it, and there is no per-tool compensating inverse to abort into. It also does not target cross-agent stale reads — it prevents partial effects and losing-branch residue. Same precondition that kills CoAgent's sagas, one layer lower. |

**The cross-cut that survives all of it:** STORM and CAID reach *opposite* conclusions on
isolation using the same two benchmarks [P] — and the sub-agent's read, which I accept, is
that STORM benchmarked a stripped version of CAID (worktrees without the dependency DAG or
test-gated integration), and its worktree baseline underperformed its own single-agent
baseline for two of three models, which marks a broken setup rather than a paradigm.

> The axis that decides outcomes is **not** isolation vs. shared state. It is **verified
> integration vs. unverified integration.**

Every approach that discarded work on conflict underperformed (OCC: 0.93× speedup at 1.83×
tokens — slower than serial while costing 83% more). Every approach that gated on executable
verification gained. That single sentence is the design.

---

## 7. The design

### 7.1 Read-set — G-3

```sql
CREATE TABLE IF NOT EXISTS work_read_sets (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  agent_id      TEXT,                 -- __agent__:<id> binding already exists
  task_id       TEXT,
  locator       TEXT NOT NULL,        -- 'symbol://path#Name' | 'file://path'
  observed_hash TEXT NOT NULL,        -- signature_hash | content hash, AT READ TIME
  tool_name     TEXT,                 -- requires the host-hook fix below
  read_at       TEXT NOT NULL,
  released_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_work_read_sets_locator ON work_read_sets(locator, released_at);
CREATE INDEX IF NOT EXISTS idx_work_read_sets_session ON work_read_sets(session_id, released_at);
```

Populated from the **existing** path stream, never by agent self-report — CooperBench measures
agents defecting from their own stated commitments 32% of the time [P], so nothing load-bearing
may depend on an agent declaring anything.

Prerequisite fix: add `toolName` to `NormalizedHostHook` and set it in `toolEvent`
(`host-hook.ts:215`). `tool_name` is already allowlisted; this is ~2 lines.

Two hazards, both from `[C]`:
- `Grep` contributes **no** `file_path`, so it cannot poison the set by that route — but
  `path` **is** allowlisted (`lifecycle.ts:34`), so a `Grep` with a `path` argument emits a
  **directory**. Reject non-file locators at insert.
- Hook debounce (`hook-debounce.ts:41-45`) once collapsed two distinct reads into one. The
  read-set must key on `captureKey`-like identity, not on timing.

Release on `task-finish`/`session-stop`; sweep at GC. An unreleased read-set makes every
historical read look like live work.

### 7.2 The tick — G-1

Add `listWorkingTreeChanges(root)` (via `git status --porcelain`) alongside the existing
commit-range function, and a **new** `indexFile(root, relPath)` export (G-6 fix folded in:
wrap it in `withClientTransaction`).

Triggers, cheapest first:
1. `PostToolUse` on a write tool → re-index **that one file**, compare against
   `work_read_sets` by indexed equality. Never a repo walk.
2. Session boundaries → today's full pass, unchanged.
3. `knowl_impact` → on demand.

### 7.3 Reach — G-2

**Reference edges.** Extend `kind` with `'references'`. Resolution is **same-file scope +
direct-import hop only**, and this is a verdict, not a shortcut [W]: `stack-graphs` (the
purpose-built tool) was **archived by GitHub 2025-09-09** with no Node bindings ever; SCIP is
a full-repo batch artifact with no incremental mode; the TS compiler API carries a 3GB
language-service ceiling and 10× slowdowns under project references; Glean and Kythe assume a
dedicated infra team. Shallow tree-sitter is the only maintained, Node-native, genuinely
incremental option. Independent bound on ambition: existing JS call-graph tools agree with
each other only ~60% of the time on real modules [W].

Scope-tag it: *proven for same-file and direct-import references in TS/JS; silent elsewhere.*
Silent, not guessing — a missing edge costs recall, a wrong edge costs the whole feature.

**Bounded walk.** Inbound over `code_symbol_edges`, **depth 2, capped at 12** following
`blast-radius.ts`. Depth 1 → `likely`. Depth 2 → `possible`. Beyond → not reported.

### 7.4 Impact record

```sql
CREATE TABLE IF NOT EXISTS impact_findings (
  id             TEXT PRIMARY KEY,
  cause_locator  TEXT NOT NULL,
  cause_session  TEXT,
  affected_kind  TEXT NOT NULL,       -- 'knowledge' | 'work'
  affected_id    TEXT NOT NULL,
  tier           TEXT NOT NULL,
  path_json      TEXT,                -- the edge chain justifying it
  detected_at    TEXT NOT NULL,
  resolution     TEXT,                -- 'repaired'|'dismissed'|'expired'|'false_positive'
  resolved_at    TEXT
);
```

`resolution = 'false_positive'` is the most important column in this plan. It is how §9 gets a
denominator, and it is the number nobody in the literature reports.

### 7.5 Delivery — and its deliberately small role

**The gate is the mechanism.** `PreToolUse` fires before `Edit`/`Write`/`MultiEdit`; when the
write targets a file holding an unresolved `certain` finding against a read *this session still
holds*, the hook returns `permissionDecision: 'deny'` with the was/now pair, and the host blocks
the call. This is the only part of the design with evidence behind it — it is STORM's
mechanism, the one intervention in the literature that moved a number (+18.7 on Commit0-Lite),
and unlike a notice it cannot be ignored by an agent that doesn't read carefully. `write-gate.ts`
carries the reasoning per rule.

Four properties it must have, none optional:

- **Nothing is discarded.** A denial costs one tool call, reissued after a re-read. That is what
  separates this from OCC, which aborted trajectories for 0.93× speedup at 1.83× tokens [P].
- **Symbol granularity** — the one improvement on STORM, whose own stated limitation is
  file-level false positives when two agents edit different functions in one file.
- **One shot per stale belief.** The refusal releases the read-set rows it named, so a retry is
  never blocked twice. An agent that re-reads with `cat` updates nothing, and a gate that can
  trap an agent is strictly worse than no gate.
- **Fail open, without exception** — flag off, no session, unknown host, broken store, failed
  release. A silent detector costs recall; a gate that wrongly blocks costs someone their
  working session.

**`knowl_task_finish` is *not* a second gate, and the build proved it cannot be one** — §15.

**The notice is a courtesy.** Added to `renderChangeCard` (`change-card.ts:21`) — the shared
renderer, so it reaches both the hook path and the MCP path. Constraints from `[C]`: the
mid-turn slot is **single-occupancy** with a documented priority order
(`host-lifecycle.ts:416-418`, *"At most one card per tool event, never two"*), and
`tests/mcp/dual-channel-notification.test.ts` pins it. So the impact stanza must fit *inside*
the existing card, not compete with it.

Payload shape copied from STORM (the one part of it that transfers):

```
CODE IMPACT: 1 thing you read has changed.
- src/auth/session.ts#createSession — signature changed since you read it
  was: createSession(user: User): Session
  now: createSession(user: User, org: Organization): Session
  you read it 3 tool calls ago; changed by session 4a91
```

Budget: ≤6 lines, consistent with `MAX_ITEM_LINES = 5` / `MAX_TITLE_LENGTH = 90`.

**Pull:** one tool, `knowl_impact({scope, tier})`. One, because the repo's own policy
(`types.ts:267-271`) states that each added tool "costs guidance-card space in every session
of every user".

### 7.6 Repair — last, and modest

Test selection from the impact walk (the file set is already computed), and a replan hint
naming *which* read-set entries went stale so the agent revises a step instead of restarting —
because every approach that discarded work underperformed [P].

Not automatic merge resolution. Not semantic conflict inference. §11.

---

## 8. Phases

| P | delivers | gate to proceed |
|---|---|---|
| **P-0** | `toolName` on hook events; `indexFile()` export; G-6 transaction fix | full suite green; single-file index p95 measured |
| **P-1** | incremental index on write; freshness in `doctor` | index stays current through a real session; no repo walk mid-session |
| **P-2** | `work_read_sets` + capture + release + GC | read-set matches ground truth on a scripted session; bounded growth |
| **P-3** | certain-tier detection + `impact_findings` + **the `PreToolUse` write gate** | **≥95% precision over ≥40 findings**, adjudicated |
| **P-4** | reference edges, tiers, `knowl_impact` | likely-tier ≥70%; misses catalogued |
| **P-5** | test selection + replan hint | end-to-end task success improves, or it does not ship |
| **P-6** | cross-repo impact via workspace peers | — |

**P-3 is the bet.** Everything before it is defensible on its own merits even if the bet
loses; nothing after it is worth building if the bet loses.

Keep locators repo-qualified from P-0 so P-6 stays a query change, not a migration.

### House rules this must follow `[C]`

- Schema: append to `SCHEMA_STATEMENTS` (`bootstrap.ts:60-272`); **bump
  `KNOWL_MIGRATION_LEVEL`** (`schema-version.ts:47`, now 2) or every existing DB skips the
  migration forever; **leave `KNOWL_SCHEMA_VERSION` at 1** or you lock out installed builds;
  add a `SCHEMA_PINS` hash or `tests/store/schema-pin.test.ts` fails.
- Config: follow `search.transcripts.enabled` — 4 edit sites, `defaultValue: false` in
  `CONFIG_FIELDS`, and **do not add it to `DEFAULT_CONFIG`**, which `upgradeConfigDefaults`
  (`config.ts:210`) merges into every repo on the machine.
- Advisory subsystems are best-effort: `flagCorrectionSiblingsBestEffort` is the template.
- Write the failing test first; run the **full** suite (~1503 tests); comment the *why with
  measurements* — that comment style is the strongest unwritten convention in this repo.

---

## 9. Measurement

**Verified by running our own system** — no external dependency:

| metric | target | why |
|---|---|---|
| certain-tier precision | **≥95%** over ≥40 findings | Tricorder's <10% FP bar, tightened because our channel is tool-side |
| likely-tier precision | ≥70% | pull-only, so a miss is cheaper |
| detection latency (write → finding) | <2 s | single-file scope |
| single-file index p50/p95 | measure, don't assume | G-6 may dominate; no published benchmark exists for this pipeline |
| notice tokens/session | <500 | tool-side noise is measurably harmful |
| `work_read_sets` steady-state rows | bounded post-GC | — |

Adjudication is not optional and not vibes: every `impact_findings` row gets a resolution, and
precision is `1 − false_positive / total`. **Publishing that number would make this the first
system in the space to report one.**

### 9.1 The measurement, run — 2026-08-05 `[C]`

`tests/store/impact-precision.test.ts`, **46 adjudicated scenarios**, labels fixed before the run
and never shown to the detector:

| locator kind | precision | recall | tp | fp | fn |
|---|---|---|---|---|---|
| **`symbol://`** — the tier allowed to refuse a write | **100.0%** | 89.5% | 17 | 0 | 2 |
| `file://` | 100.0% | 100.0% | 2 | 0 | 0 |
| blended | 100.0% | 90.5% | 19 | 0 | 2 |

**The ≥95% bar is met and the ≥40-finding sample size is met**, both asserted in the suite so the
number cannot later be quoted off a sample too small to support it. The benign half deliberately
includes the adversarial cases — a licence header added above the read symbol, two functions
swapped in order, an import inserted at the top — because each would fire if line position had
leaked into the signature hash. None did.

Two recall misses remain, and both are the **symbol extractor**, not the detector, each diagnosed
by direct measurement rather than assumed: it emits no symbol at all for `function*`, and it
strips `export` from signatures, so un-exporting a symbol hashes identically. They are recorded in
the suite as invalidating and still counted as misses — the number must not improve because
something was hard.

**The measurement paid for itself on its first run.** Deleted and renamed symbols never fired: the
candidate set was built only from symbols a file has *now*, so a symbol the change removed could
never be looked up, while the card and refusal text had both carried a "gone" case nothing could
reach. That is the strongest invalidation in the design and it was worth 28.6 points of recall.
Fixed by seeding candidates with the pre-change symbols, guarded so absence only counts when the
file demonstrably re-parsed — otherwise a file caught mid-edit, which yields no symbols at all,
would report every symbol in it as deleted at once.

Caveat, stated rather than buried: these are **constructed** scenarios, not a field sample. They
establish that the detector does not fire on benign edits of the shapes a formatter, a linter or a
neighbouring agent actually produce. They do not establish the *prevalence* of those shapes in real
sessions, which only §9's live adjudication of `impact_findings` rows can.

**Claims about the outside world** — do not assert until run:

- **CooperBench** [P]: 652 tasks, 12 libraries, 4 languages; 77.3% of task pairs have
  overlapping ground-truth changes; agent pairs retain only ~59% of solo performance. A
  `harbor` adapter exists. The bar that matters: **two coordinated agents beat one agent at
  comparable cost** — not "beats uncoordinated agents", which is a low bar.
- **SWE-Touch** [P] is the better *first* harness: it is single-agent, so it isolates
  staleness from every other multi-agent failure, and its Counter-Edit/Co-Edit control already
  separates "conflicting change" from "any change". Its code is released.

Cost realism from the papers [P]: STORM's cost-per-point was $6.3 vs **$3.2 for a single
agent**; CAID's coordination raised PaperBench cost $3.3 → $9.3 and made wall-clock *slower*.
Coordination has never been free in any published result. Budget for that in the claim.

---

## 10. Adversarial review of this plan

Refuting my own design, per house rule.

**"The gate is just a nag with extra steps."** ~~Partly fair.~~ **No longer — and this objection
is what should have exposed §6's error.** A `task_finish` gate really was a nag: it asked an
agent to stop at a chokepoint it need not visit. `PreToolUse` is not a nag, because the host
enforces it — the write does not happen. The correct residual objection is narrower and stated
below.

**"The gate's coverage is partial, and the holes are the interesting cases."** True, and this is
the honest ceiling. Researched 2026-08-05 against the host's issue tracker rather than assumed;
each hole below has a number you can check.

*Ours, by design:* writes through `Bash` (`sed -i`, `>`, `git checkout`) are ungated — STORM
concedes the identical hole, and upstream has it filed as **#29709, "Claude Code circumvents
PreToolUse:Edit hook via Bash tool"** [W]. Any host without a deny verdict fails closed to
allowing.

~~`NotebookEdit` is ungated until `notebook_path` joins the `lifecycle.ts` stdin allowlist.~~
**Closed 2026-08-05** `[C]`. `NotebookEdit` is the one write tool that does not name its target
`file_path`, and `notebook_path` was missing from *two* places — the stdin allowlist and
`changedPaths`. It did not fail, it went quiet: a notebook edit normalised to an event carrying no
changed path at all, so the file was never re-indexed and nothing downstream could fire, for
notebooks only. Both are fixed, and one of the two tests goes through the allowlist rather than
around it, because a field absent from it is dropped before the normaliser is ever reached.

*The host's, and these bound the mechanism itself* [W, all OPEN as of 2026-08-05]:

- ~~**#78970 — `PreToolUse` is not invoked for subagent (Task/Agent-tool) tool calls.**~~
  **DOES NOT REPRODUCE on 2.1.221 — measured, 2026-08-05** `[C]`. This was written as the most
  important line in this section, because subagents are Claude Code's own concurrency primitive and
  therefore *the* population the gate exists to protect. It was taken from the open issue rather
  than tested, and testing it says the opposite.

  A hook fixture logging both `PreToolUse` and `PostToolUse` was driven through two headless runs.
  Every subagent tool call fired `PreToolUse`, carrying `agent_id` and `agent_type`:

  | run | agent type | `PreToolUse` fired for |
  |---|---|---|
  | 1 | `general-purpose` | `Bash`, `Read`, **`Edit`** |
  | 2 | `Explore` — the type the issue names | `Bash`, `Read` |

  Main-thread calls in the same runs fired too, which is the control that matters: it separates
  "no subagent events" from "no events at all". So the gate **does** cover subagent writes,
  including `Edit`, which is its exact path.

  The same experiment incidentally disposes of **#79480** for this configuration — the hooks were
  registered from a project-scoped `.claude/settings.local.json`, which is the shape knowl writes
  (`project-adapters.ts:76`), and they fired.

  Scope-tagged, as everything here is: Claude Code 2.1.221, headless `-p`, `bypassPermissions`,
  two agent types. Not a claim about every version or every agent type, and worth re-running on
  host upgrades — the point is that the limitation this section asserted is not currently real.
- **#77708 — deny is not enforced in Claude Desktop / Cowork, only native CLI.** Scope-tag
  accordingly: proven for the CLI, silent elsewhere.
- **#78527 — a `2.1.210` regression where deny ends the turn (`hook_stopped_continuation`)
  instead of returning a tool error**, still reproducing at `2.1.214`. Filed for `type: "prompt"`
  hooks; knowl's is `type: "command"`, so it likely does not apply — but if that path ever
  generalises it breaks the core safety claim of this design, which is that a denial costs *one
  tool call*, not a turn. Worth re-checking on every host upgrade.
- **#79480 — project-scoped `PreToolUse` hooks silently not registered.** knowl writes to
  `.claude/settings.local.json` (`project-adapters.ts:76`), which is project scope. Adjacent
  rather than identical; verify empirically before trusting installation.

*Load-bearing and verified `[C]`:* the hook must **exit 0** when it denies. Exit 2 is read as a
hook crash and the deny is discarded — upstream's own #37210 was resolved as exactly that
operator error, and it is the single most common cause of "deny is ignored" reports. knowl's
deny path returns normally with no `process.exit` (`agent-hook.ts:48-50`), so it exits 0. Nothing
pins this in a test, and it should be pinned: `tests/cli/missing-database.test.ts` already
establishes the `spawnSync` pattern for process-level hook assertions.

*Mitigation for the Bash hole, deliberately deferred rather than absent.* The gate does not need
write-intent parsing, which is undecidable in a shell; it needs only to ask whether the command
text mentions a path that **already carries an open certain finding** — a far narrower test,
made safe by fail-open and the one-shot release, since a false refusal on `cat src/a.ts` costs
one call and then releases. Two reasons it still waits, one fewer than when this was written:
that narrower test has **its own** precision, unmeasured, and §9's rule forbids shipping on that;
and **#79440** means shell aliases can rewrite a command *after* the hook approved it, so the
matched text is not provably the executed text. *(The third reason was #78970 — that closing this
hole would not close the multi-agent case anyway. It does not reproduce, so it is no longer an
argument for leaving Bash open, and this is now the largest remaining hole rather than one of
several.)*

**"Precision ≥95% may be unreachable even for the certain tier."** The tier is a hash equality
on something the session provably read, so a *detection* false positive should be near zero.
The real risk is **relevance** FPs: the symbol changed, but not in a way that matters (a
comment, a rename the agent doesn't care about). ~~CoAgent asserts most such overlaps are benign
and never measured it [P].~~ **Downgraded to [?] on 2026-08-05.** Re-checking CoAgent found no
such claim at abstract level; what it does say is that the LLM inside each agent judges, case by
case, whether a conflicting write invalidates its plan — a capability claim, not a prevalence
one. The cited §4.1 was not re-read in full, so this is *unverified rather than refuted*, but it
may not carry the weight this paragraph put on it and nothing should lean on it until someone
reads the section. If relevance FPs run high, the certain tier shrinks to
*signature-hash changed* only, and body-only edits drop to `likely`. Decide with the P-3
measurement, not now.

**"The prevalence risk isn't mitigated, only acknowledged."** True, and it is the weakest
point in the whole plan. §5 C-4 shapes the phases so P-0…P-2 stand alone, but if same-repo
multi-agent work never becomes common, P-3+ is a solution seeking a problem. The
counter-evidence is that isolation *increases* the semantic-incoherence case (§1), so the
addressable problem grows as the textual one shrinks — but that is an argument, not a
measurement.

**"Everything rests on hooks that are host-proprietary and unfrozen."** Yes [W]. Claude Code's
hook schema changed three times in July 2026. Codex's docs moved hosts and several output
fields are marked "not yet implemented". *Mitigation:* the gate path is MCP-native and
survives any hook change; only the courtesy notice depends on hooks.

**"Six papers, and the two most cited contradict each other."** They do, and §6 resolves it in
CAID's favour with a stated reason rather than averaging them. If that resolution is wrong,
the design still holds — it takes the verification lesson from CAID and only the payload shape
from STORM, so a STORM-favourable resolution changes nothing structural.

---

## 11. What not to build

Each rejected with a reason, not a shrug.

- **Orchestrator / task splitter / worktree manager** — natively shipped by all seven
  platforms [W]. Knowl's edge is being *already in the session*, not launching anything.
- **Locking** — 2PL/OCC "surrender nearly all concurrency gains" [P], and every approach that
  discarded agent work underperformed. *(Write **blocking** was on this list in v2 and has been
  removed: it was here on a false precondition — §15. The two are not the same thing. A lock
  holds a resource against other actors for a duration; the gate refuses one call, once, and
  hands back the diff. Nothing is held and nothing is discarded. STORM's unmeasured 19–33%
  rejection rate remains the real risk, which is why §9's precision number is a ship gate rather
  than a nice-to-have.)*
- **Agent-to-agent messaging** — CooperBench: channels jam with vague, ill-timed, inaccurate
  messages, and communication doesn't move success [P].
- **A dashboard** — unupstreamable under C-1; the channel that works is already in-context.
- **A large MCP tool surface** — explicit repo policy [C].
- **Semantic conflict inference / auto-merge** — precision/recall trade is bad and unbounded.
- **Type-aware resolution (tsserver/SCIP/stack-graphs)** — dead, batch-only, or heavy [W].
  Revisit only if P-4 precision fails *because* of resolution depth, which is measurable.
- **Non-code state** (DBs, infra, flags) — CoAgent shows this is where it gets genuinely hard
  [P].
- **Anything that discards agent work on conflict** — every such approach underperformed [P].

---

## 12. Decision register

| # | decision | my call | status |
|---|---|---|---|
| **D-1** | Build here vs. standalone | **Here.** 60–70% of substrate exists [C]; niche unoccupied [W]; standalone means rebuilding it with no distribution. | provisional |
| **D-2** | Upstream-shaped vs. fork-local | **Upstream-shaped from P-0** (§8 house rules), per the 2026-08-05 no-separate-version decision. | provisional |
| **D-3** | Tell the upstream maintainer before or after P-3 | **Before.** Two tables, four indexes, a migration-level bump and a hook that can deny a write, in someone else's project; surprising a collaborator is worse than a slow start. | **William's — still open, and now urgent.** P-0…P-4 were built ahead of it, and the branch they are on (`fork/mainline-2.16`) is the head of the *open* PR #16 — pushing lands 10 unrelated commits inside a PR already under review. Held local for that reason |
| **D-4** | Gate-first vs. notice-first | **Gate-first.** Notification is measured at ~0 effect twice [P]. This reverses v1. | **held** — survived the build |
| **D-5** | Language scope | **TS/JS only** at P-4. | provisional |
| **D-6** | Research doc's business model | **Out of scope** under C-1. | **William's** |
| **D-7** | First external harness | **SWE-Touch before CooperBench** — isolates staleness; single-agent; code released. | provisional |
| **D-8** | Ship if P-3 precision lands 80–95% | **Do not push at <95%; ship pull-only and keep measuring.** | provisional |
| **D-9** | Where the refusal lands, given `PreToolUse` can deny | **The write.** Reverses §6/§7.5/§11 of v2. The `task_finish` gate is not kept as a backstop: it is unreachable by construction (§15), so keeping it would advertise an enforcement that never fires. | **decided**, verified by build |

D-3 blocks. Everything else proceeds under my call with your veto.

---

## 13. First move

**P-0**, and it is three small things, all defensible even if this plan dies: add `toolName` to
the hook event, export `indexFile()`, and wrap the index writes in the transaction helper that
already exists. That last one is a live performance bug (G-6) independent of everything here.

But D-3 first.

> **What actually happened, 2026-08-05:** P-0 through P-4 were built in one pass — schema,
> read-set, detection, card, `knowl_impact`, and the `PreToolUse` write gate — *before* D-3 was
> answered. That was not the sequence this section called for. It is recoverable only because
> nothing is committed and nothing is pushed, so the ask to the maintainer is still a proposal
> rather than a fait accompli; but the proposal it accompanies is now five tables and a hook that
> can deny writes, which is a larger thing to put in front of someone than the three-line P-0
> this section deliberately led with. D-3 still blocks, and it now blocks a bigger door.

---

## 14. What v1 got wrong

Kept deliberately — a plan that hides its own corrections teaches nothing.

1. **Design:** "detect → notify" as the spine. Refuted by SWE-Touch and CooperBench [P].
2. **`change-notice.ts` is the integration point** — it is *suppressed* on Claude Code and
   Codex; the real point is `renderChangeCard` [C].
3. **"Push channel … `change-notice.ts` … proven"** — the proof came from the hook path
   (`host-lifecycle.ts:415`), a different file [C].
4. **"`host-hook.ts:275` → `affectedPaths`"** — `:275` feeds secret-scanning only and persists
   nothing; capture is `:214-215`, persistence `session-capture.ts:7` [C].
5. **"`indexCode` is already incremental; it needs a trigger"** — it walks the whole repo and
   has no per-file export [C].
6. **"Weight `Read`/`Edit` above `Grep`"** — not expressible; the tool name is discarded [C].
7. **"One config key"** — accurate as a goal, but it is 4 edit sites, and the obvious move
   (adding to `DEFAULT_CONFIG`) would inject it into every repo on the machine [C].
8. **MAST cited against the premise** — scope error, mine. Its seven frameworks are sequential
   conversational pipelines; none runs concurrent agents on a shared filesystem, so cross-agent
   staleness is absent from its corpus by construction. Its FM-1.4 (2.80%) measures an agent
   forgetting *its own* earlier turns [P].
9. **CooperBench numbers** — v1 said "~25%, roughly 50% below". Correct: 652 tasks, ~30%
   relative drop, ~59% of solo performance retained [P].

---

## 15. What v2 got wrong

One error, and it is the same *class* of error as v1's — a load-bearing claim about the
substrate asserted from memory instead of checked — so it is kept here for the same reason.

**The error.** §6 killed write-blocking on the precondition *"all writes flow through one
mediated tool"*, answered **NO** because *"knowl is an MCP server with no write path"*. Both
halves are wrong. The precondition is wrong: STORM's mechanism needs a **veto**, not mediation —
it does not need to *perform* the write, only to stop it. And the fact is wrong: knowl already
registers `PreToolUse` hooks, and Claude Code's hook protocol accepts
`{hookSpecificOutput: {permissionDecision: 'deny', permissionDecisionReason}}`, on which the host
blocks the tool call and shows the model the reason [W, verified verbatim against
code.claude.com/docs/en/hooks — which is where this should have been checked the first time].

**Why it survived a review that caught nine other things.** It was marked `[C]` — the tag for
*verified by reading this codebase* — but what was read was the MCP surface, where it is true
that nothing writes files. The hook surface was never opened. A provenance tag records where a
claim came from and cannot record where it *should* have come from, which is the failure mode
worth remembering: the tags catch invented facts, not facts checked against the wrong file.

**What it cost, and what it did not.** It cost a design detour: v2 routed the mechanism to
`knowl_task_finish`, which the build then proved cannot carry it (below). It cost nothing
structural — every other piece (read-set, symbol locators, tier split, the fail-open rule, the
single-occupancy card, `impact_findings` and its `false_positive` column) is unchanged, because
they were all specified against *detection*, and detection did not move. The refusal text is the
STORM payload §7.5 already specified, delivered one chokepoint earlier.

**Why `knowl_task_finish` cannot be the gate, and is not kept as a backstop** `[C]`. It is
unreachable by construction, in two independent ways:

1. **The session ids never join.** Reads are captured only by the hook path
   (`recordRead` has exactly one non-test caller, `host-lifecycle.ts:439`) under the *host*
   session. `startWorkLoop` mints a *different* session (`work-loop.ts:114`,
   `agent: 'work-loop'`), tags the task with it, and the gate resolves findings through that tag.
   `openFindingsForSession` joins `work_read_sets.session_id`, so the gate queries an id under
   which no read was ever recorded.
2. **Loosening the join is not available.** The strict binding is what stops the gate blocking
   one agent's finish over another agent's stale read, and the obvious repair — reuse the host's
   session for the work loop — would have `finishWorkLoop` close a session the host still owns.

So the gate's five green tests are green because each seeds a read under the work-loop id
directly, which nothing in production does. That is worth stating plainly: **a passing test is
evidence the code does what it says, never evidence that anything reaches it.** The gate is
therefore removed rather than repaired — a tool description promising an enforcement that cannot
fire is worse than no promise, and it costs guidance-card space in every session to say it.

`knowl_impact`'s `resolve` stays, and is now the *only* adjudication path: the write gate leaves
findings open by design, so `resolution` — and with it §9's precision denominator — depends on
it entirely.
