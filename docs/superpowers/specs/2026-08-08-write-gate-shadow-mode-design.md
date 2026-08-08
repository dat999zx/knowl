# The `PreToolUse` write gate, in shadow mode first

Issue #17, piece 3. Pieces 1 (PR #19, `08040f9`) and 2 (PR #33, `c8fc58d`) are merged; this is
what keeps #17 open.

The design of the gate itself is not new work — it is `docs/change-impact-plan.md` §7.5, accepted
on #17 (comment 5192096798) — and an implementation of it already exists on
`William-Sommers:impact/3-write-gate` at `cd9fc8f`. What this spec adds is the condition the
maintainer attached to that acceptance and which the branch does not implement: **the gate ships
in shadow mode first, logging what it would have blocked, so the false-positive rate is measured
before anything refuses a write.**

## 1. What the gate is

Two agents share a repo. Agent A reads `login.ts` and plans an edit. Agent B changes that
function. Agent A's edit then lands on a version that is gone.

Pieces 1 and 2 detect this and add a `CODE IMPACT` stanza to the change card. That is a notice,
and notices are the intervention measured at approximately zero effect twice, independently —
SWE-Touch finds message-plus-edit no better than the silent edit and *worse* for 3 of 4 models;
CooperBench finds a first-turn plan halves the conflict rate while moving end-to-end success by
an amount that is not statistically significant.

The gate is the mechanism with evidence behind it. `PreToolUse` fires before `Edit`/`Write`/
`MultiEdit`; when the write targets a file holding an unresolved `certain`-tier finding against a
read *this session still holds*, the hook returns `permissionDecision: 'deny'` with the was/now
pair and the host blocks the call. That is STORM's mechanism, the one intervention in the
literature that moved a number (+18.7 on Commit0-Lite).

**Nothing is discarded.** A denial costs one tool call, reissued after a re-read. That is what
separates it from optimistic concurrency control, which aborted trajectories for 0.93× speedup at
1.83× tokens.

## 2. Base: rebase the contributor's branch

`William-Sommers:impact/3-write-gate` is cut from `ac3ce52`, before pieces 1 and 2 landed, so its
raw diff spans all three. The gate-specific content is `src/store/write-gate.ts` (307 lines),
`src/store/working-tree.ts` (79), `tests/store/write-gate.test.ts` (333),
`tests/cli/tool-precheck.test.ts` (190), and deltas to the hook plumbing.

We rebase it onto current `main` with authorship preserved, following how #19 and #33 went and the
2.17.0 cherry-pick precedent. The reasoning in that code is already the reasoning in the plan doc;
rewriting it would discard validated work to no end.

The wiring it brings is complete and is kept as-is:

| Piece | What it does |
|---|---|
| `hosts/claude.ts` | `PreToolUse` → normalized `tool-precheck`, in a Claude-only event map — Codex 0.145.0's dispatcher enum has no `PreToolUse`, so teaching the shared map would mark that host gated when it is not |
| `hosts/profile.ts` | `denyToolCall` as an optional capability; absence means the host cannot refuse |
| `host-lifecycle.ts` | `runWriteGate`, claimed first so no other branch mistakes a pre-tool event for a session boundary |
| `agent-hook.ts` | the deny returns on **exit 0**. Claude reads a `PreToolUse` verdict from stdout only on exit 0; a non-zero exit discards it and runs the tool anyway |

### 2.1 Two corrections it needs

**Layer placement.** `store/write-gate.ts` imports `ImpactCardEntry` from `cli/agents/
change-card.js` and `openFindingsForSession` from `impact.js`. Under the layer graph #31 enforced
(`tests/architecture/module-boundaries.test.ts`: `store` = 1, `code` = 2, `session` = 3,
`cli`/`mcp` = 4) both are upward edges, and on current `main` both targets have moved anyway —
the card renderer is `src/session/change-card.ts` and the detector is `src/session/impact.ts`.
The gate moves to **`src/session/write-gate.ts`**. This is the identical correction #33 needed;
the comment at `src/mcp/tools.ts:1171` naming `store/write-gate.ts` is updated with it.

**`working-tree.ts` stays deleted.** #33's review removed it as dead code on the reasoning that it
was the write gate's input. Checked against the contributor's own branch: `git grep working-tree`
over its `src/` returns nothing — it has no caller there either. The gate takes its target paths
from the hook event, not from `git status`. It is P-1 tick machinery that was never wired, and it
comes back with the code that needs it, which is not this.

## 3. Shadow mode

### 3.1 Configuration

A second key beside `impact.enabled`:

```
impact.gate:  'off' (default) | 'shadow' | 'enforce'
```

Both must be on for anything to happen — `impact.enabled` gates capture and detection, and a gate
with no findings to read has nothing to say.

Follows `search.transcripts.enabled` exactly: the union in `src/cli/config/schema.ts:25`, the
`CONFIG_FIELDS` entry with `defaultValue: 'off'`, the type in `src/core/types.ts:297`, and
**deliberately not in `DEFAULT_CONFIG`** — `upgradeConfigDefaults` merges that object into every
config on the machine, so a default written there would arm a write gate in every repository the
user has ever initialized, at once, with nothing recording that it happened.

### 3.2 What shadow does

`shouldRefuseWrite` computes the identical verdict. On a would-be denial in `shadow`:

1. write one row to `impact_gate_shadow`;
2. **do not** release the read-set rows;
3. return `allow()`.

The read-set is the thing being measured, so shadow mode must not write to it. This is the repo's
own rule from 2.17.0 — a diagnostic must not change the process it observes — and the concrete
harm is specific: releasing a belief the agent never re-read makes the read-set stop describing
what the session holds, while that table is simultaneously the evidence the precision number is
computed against.

### 3.3 One row per belief

```sql
CREATE TABLE IF NOT EXISTS impact_gate_shadow (
  id           TEXT PRIMARY KEY,
  finding_id   TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  target_path  TEXT NOT NULL,
  observed_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_impact_gate_shadow_finding
  ON impact_gate_shadow(finding_id);
```

The unique index is the whole design. Because shadow does not release, the same stale belief is
still live on the next write to that file and would log again — so the row count would measure
*writes attempted* rather than *blocks a real gate would produce*, and those differ by however
many times an agent happens to edit one file. With `finding_id` unique, a repeat is an ignored
constraint violation and the count of rows equals the count of denials `enforce` would have
issued. That is what makes the shadow measurement predictive of the real one rather than merely
suggestive.

**`finding_id` alone, and not `(finding_id, read_set_id)`.** A finding's `affected_id` *is* the
read-set row id — `detectCertainImpact` writes `affectedId: entry.id` from the read-set entry it
compared (`session/impact.ts:417`), and `openFindingsForSession` joins
`work_read_sets w ON w.id = f.affected_id` (`:463`). So one finding is one stale belief already,
the pair is 1:1, and a stored `read_set_id` would be a second copy of a value that can only ever
disagree with its source. The adjudicator reaches the read-set row through the finding.

`target_path` is recorded because a finding can be reached from more than one write target and the
adjudicator needs to see which edit was in flight. It is the *first* such target, not the latest:
the row is written once and the unique index makes every later attempt a no-op, so the column
answers "what was the agent doing when this first would have been blocked" — which is the question
a false-positive adjudication actually asks.

`session_id` is kept even though it is reachable through the same join, and this is the one place
the denormalization earns itself: `sweepReadSets` **hard-deletes** released read-set rows
(`store/read-set.ts`, `DELETE ... WHERE released_at IS NOT NULL AND released_at < ?`), so once GC
has run the finding's join to `work_read_sets` returns nothing and the owning session is
unrecoverable. Findings themselves are not swept by that path, so the precision measurement
survives GC — but only if the session is recorded where GC cannot reach it. That is a different
situation from `read_set_id`, which after the same sweep would be an id pointing at a row that no
longer exists.

### 3.4 The measurement

No new adjudication path. Every shadow row names a `finding_id`, and findings already carry
`resolution`, set through `knowl_impact({resolve})` — which §15 established is the only
adjudication path, precisely because the gate leaves findings open by design.

```
precision = 1 − (shadow rows whose finding resolved false_positive) / (shadow rows whose finding resolved)
```

Promotion to `enforce` is a separate decision on a stated number, against plan §9's bar: **≥95%
over ≥40 findings**. Unresolved findings are excluded from both halves rather than assumed good.

### 3.5 What enforce does

Unchanged from the contributor's branch: release the named read-set rows, then deny — release
first, so a refusal that could not be recorded is abandoned rather than issued, because a denial
the store did not remember is one that fires again on the retry. That is the "one shot per stale
belief" property; a gate that can trap an agent is strictly worse than no gate.

Fail open without exception, also unchanged: flag off, no session, unknown host, no `denyToolCall`
capability, broken store, malformed row, failed release. A silent detector costs recall; a gate
that wrongly blocks costs someone their working session.

## 4. Schema

One additive table and one index, appended to `SCHEMA_STATEMENTS` in `src/store/bootstrap.ts`.
Per the house rules in plan §8:

- `KNOWL_MIGRATION_LEVEL` **3 → 4** (`src/store/schema-version.ts:54`) — without the bump every
  existing database skips the migration forever;
- `KNOWL_SCHEMA_VERSION` **stays 1** (`:24`) — raising it locks out installed builds, and this
  change is purely additive;
- a new `SCHEMA_PINS` entry — the map lives in `tests/store/schema-pin.test.ts:22`, keyed by
  migration level, and the test prints the hash to add when it is missing;
- `src/store/snapshot-tables.ts` gets `impact_gate_shadow: 'preserved'`, joining
  `work_read_sets` and `impact_findings` at `:67-68`. Same reason as `impact_findings`' own: the
  rows are the measurement, and a snapshot restore that dropped them would silently reset the
  precision denominator to zero.

## 5. In-scope correction

`src/cli/config/schema.ts:213` describes `impact.enabled` as *"While on, a task finish reports
unresolved changes instead of closing clean"*, and `src/core/types.ts:284` calls it *"a gate that
declines to record a clean finish while a certain-tier finding is unresolved."*

Both describe the `knowl_task_finish` gate that plan §15 removed as unreachable by construction.
Verified on current `main`: `openFindingsForSession` has exactly one caller, `src/mcp/tools.ts:364`,
which is the `knowl_impact` pull tool — nothing consults it at task finish.

Both strings are corrected as part of this change. They are in the two files this change edits to
add `impact.gate`, and §15's own conclusion is that a description promising an enforcement that
cannot fire is worse than no promise.

## 6. Testing

Written failing-first, full suite run. The baseline in this worktree is **2261 tests across 257
files**, and it requires `npm run build` first — a fresh worktree has no `dist/`, and the CLI
tests spawn the built binary, so an unbuilt tree fails 76 of them for reasons that have nothing to
do with the change under test.

**Kept from the branch**, retargeted to `session/write-gate.ts`: `tests/store/write-gate.test.ts`
(the verdict — symbol granularity, self-exclusion, the fail-open matrix) and
`tests/cli/tool-precheck.test.ts` (normalization, Claude-only mapping, the deny envelope).

**New, for shadow mode:**

| Test | Pins |
|---|---|
| shadow logs and allows | verdict identical to `enforce`, `deny: false`, tool proceeds |
| shadow does not release | the read-set row is still live afterwards — the observer-effect rule |
| repeat write, one row | second write to the same file adds no row; the unique index holds |
| distinct beliefs, distinct rows | two findings on one file produce two rows |
| `off` computes nothing | no findings query is issued at all |
| enforce still releases | the one-shot survives the refactor |
| precision query | mixed resolutions produce the stated ratio; unresolved excluded from both halves |

The measurement itself extends `tests/store/impact-precision.test.ts`, which already carries the
46 adjudicated scenarios from the 2026-08-05 run.

## 7. Explicitly not in this change

- Flipping anything to `enforce`. That is a later decision on a measured number.
- Codex support. Its dispatcher has no `PreToolUse`; a host that cannot refuse is left alone.
- `working-tree.ts` and the P-1 tick.
- Any second gate at `knowl_task_finish` — §15 settled that.
- Test selection and the replan hint (P-5).
