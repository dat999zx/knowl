# Response density and write durability — design

2026-08-05

Follow-up to PR #16 ("Improvement round: retrieval, engine, model and suite quality"). That PR
diagnosed a real defect in what agents receive and shipped a flag reporting it. This design
fixes the defect, and repairs the coupling that made a fix dangerous.

## The problem

### 1. Half of every stored fact is silently withheld

`MAX_ITEM_CONTENT_CHARS = 600` truncates item content with the *default empty marker* — no
ellipsis, no sign. Measured on this repository's own store (556 active items):

| statistic | chars |
| --- | --- |
| p50 | 558 |
| p75 | 1,448 |
| p90 | 1,988 |
| p95 | 2,299 |
| p99 | 2,945 |
| max | 3,779 |

**48.7% of active items are cut**, and until PR #16 the caller could not tell a short complete
atom from the opening third of a long one. Meanwhile the doctrine in `KNOWL.md` instructs agents
to answer from memory rather than inspect files — advice they had no way to evaluate.

PR #16 adds `truncated: true`. That is the diagnosis, not the cure.

### 2. The constant serving that cut serves thirteen other things

`MAX_ITEM_CONTENT_CHARS` is referenced by **fourteen truncation sites across five files**:

| file | what it truncates |
| --- | --- |
| `src/core/token-budget.ts:72,73` | compact item title, compact item content |
| `src/core/format.ts:16,141` | per-item cap inside `formatHierarchyToMarkdown` and `formatRecentContextToMarkdown` |
| `src/mcp/response-format.ts:11,25` | timeline assertion content, evidence excerpt |
| `src/mcp/tools.ts:1425` | `knowl_task_start` relevant-memory content |
| `src/mcp/tools.ts:1485` | `knowl_skill_read` markdown |
| `src/mcp/tools.ts:1509` | `knowl_skill_run` stdout **and** stderr |
| `src/mcp/resources.ts:101,102,104` | resource title, content, reasoning, alternatives |

Raising the constant would therefore also raise skill markdown, subprocess output, and resource
prose. Two of those are not merely unwanted, they are regressions:

- **`format.ts` is the serious one.** Both call sites read
  `options.maxItemChars ?? MAX_ITEM_CONTENT_CHARS` while a separate `maxChars` bounds the whole
  response at `DEFAULT_CONTEXT_MAX_CHARS = 3_000`. A per-item cap of 2,000 inside a 3,000-char
  budget lets one item consume two-thirds of `knowl_recent` and `knowl_state`.
- **`skill_run` stdout/stderr** is command output. It has no relationship to memory density and
  no reason to move when memory density does.

So the cap cannot be raised until the constant is split. The split is the work; the raise is a
line of it.

### 3. `synchronous` is now a hardcoded policy with no way out

PR #16 sets `PRAGMA synchronous = NORMAL` on all three databases — the knowledge store, the
transcript index, and the resume store. The change is well argued and well measured (4.19× on
un-batched writes, better under contention, and SQLite's documentation is explicit that WAL +
NORMAL is corruption-safe), and NORMAL is the right default for memory that is re-derivable from
the transcripts sitting beside it.

It is still a durability policy applied unconditionally with no escape hatch.

## Verification of PR #16 itself

Performed before this design, on Windows 11 / Node 24, at `main` = `ac3ce52` (3.0.3):

| check | result |
| --- | --- |
| branch position | 26 commits behind `main`, including all of 3.0.1–3.0.3 |
| merge of `main` into the branch | clean, no conflicts |
| `tsc --noEmit` on the merged tree | 0 errors |
| full suite on the merged tree | **1891 passed / 1891** (225 files) |
| full suite on the branch alone | 1855 passed / 1855 |

A fresh checkout produces 64 spurious failures until `npm run build` runs — sixteen test files
spawn `node dist/index.js`. This is documented in `CONTRIBUTING.md` and is not a defect in the
PR.

## Design

### Four constants, one policy each

| constant | value | serves | justification |
| --- | --- | --- | --- |
| `MAX_ITEM_CONTENT_CHARS` | **2,000** | compact item content, resource content, `task_start` memory | The fact an agent reasons from. Returns 90.6% of items whole. |
| `MAX_TITLE_CHARS` | **200** | compact item title, resource title | Measured p99 120, max 133, none over 600. |
| `MAX_SUMMARY_ITEM_CHARS` | **600** | `format.ts` per-item defaults | Sits inside a 3,000-char response budget. Must not follow the raise. |
| `MAX_PREVIEW_CHARS` | **600** | assertion content, evidence excerpt, skill markdown, `skill_run` stdout/stderr, reasoning, alternatives | Each is a bounded sample of something retrievable in full elsewhere. |

**Why 2,000 and not 1,500 or 3,000.** Cost measured across the same 556 items, at
`DEFAULT_RESULT_LIMIT = 3`:

| cap | items whole | mean chars / query | worst case |
| --- | --- | --- | --- |
| 600 (today) | 51.3% | 1,331 | 1,800 |
| 1,200 | 66.5% | 2,057 | 3,600 |
| 1,500 | 76.6% | 2,311 | 4,500 |
| **2,000** | **90.6%** | **2,552** | 6,000 |
| 3,000 | 99.1% | 2,665 | 9,000 |

2,000 buys 39 points of whole-item delivery for +1,221 chars (~305 tokens) on a three-result
query. 3,000 buys another 8.5 points for only +113 mean chars — genuinely cheap on average —
but its worst case is 9,000 chars, and 3,000 is tuned to this store's longest item rather than
to a principle. A store with longer atoms pays that worst case routinely. 2,000 is the value
that is defensible without knowing the corpus.

`MAX_PREVIEW_CHARS` and `MAX_SUMMARY_ITEM_CHARS` both hold 600 today and are deliberately kept
apart: they answer different questions, and the next time one of them moves it must not drag
the other with it. That is the failure this whole section exists to prevent.

### The cap must not be restated in prose

PR #16 writes ``content` is cut at 600 characters` into the `knowl_query` tool description.
Restating a constant in doctrine that agents act on is how the doctrine comes to lie. The
description interpolates `MAX_ITEM_CONTENT_CHARS` instead.

### `KNOWL_SQLITE_SYNCHRONOUS`

A single environment variable, resolved on each database open — not cached in module state, so a
test can set it per case and a long-lived `serve` process picks up nothing stale — and applied to
all three databases.

- Unset → `NORMAL`. This is the default and the recommended value.
- `FULL` → `FULL`, for a user who wants durability across power loss.
- `OFF` → **refused**. It can corrupt the file on power loss, and PR #16 measured it equal to
  NORMAL (0.867 vs 0.832 ms/row), so it is a real risk for no gain.
- Any other value → **throws on the first database open**, naming the accepted values. Every
  command opens a database, so this surfaces immediately rather than at some later write.

Throwing rather than falling back is deliberate. Silently supplying `NORMAL` to somebody who
asked for `FULL` is precisely the failure the variable exists to prevent, and a typo that
degrades durability without saying so is worse than a command that refuses to start.

Comparison is case-insensitive on the value and the variable is trimmed, because
`KNOWL_SQLITE_SYNCHRONOUS=full ` with a trailing space from a shell profile is a typo that
should work, not one that should stop the CLI.

An environment variable rather than a config key, because the config route costs a schema
change, an `upgradeConfigDefaults` path, a `config/ui.ts` field, and tests for all three — for a
knob with no known user. If anyone turns it, promote it then.

The three databases set their pragmas in three separate statement arrays
(`src/store/bootstrap.ts`, `src/transcripts/database.ts`, `src/store/resume-store.ts`), so the
resolution lives in one shared helper that all three call rather than in three copies of the
same parsing.

### The as-of branch invariant

`src/mcp/tools.ts:1125` calls `compactItemResponse(item)` with no provenance, so the
foreign-repo guard that withholds `affectedPaths` from another repo's items never runs on that
path. It is correct today because the as-of branch queries a single project. It is correct by
accident, and nothing pins it.

## Sequencing

**Track A — a single comment on PR #16.** Ask the contributor to merge current `main` and re-run
their measurement rigs against it, and to correct the "0 commits behind" claim and the stale CI
link. The comment states plainly that the merge was verified clean and the merged suite verified
green, so the request is a refresh of evidence rather than a repair.

Not asked for: splitting the PR into its six original branches. The work is verified and the
review is done; re-packaging it now costs the contributor real effort and buys nothing already
missing.

**Track B — this design, in-repo, after the merge.** Released together with the merge as
**3.1.0**, so agents see one coherent MCP contract change: `truncated`, `affectedPaths`,
`uncalibrated`, and the 2,000-char cap arrive together, which matters because the guidance text
describes them as a set. The pending `2026-08-04-hardening-and-ci-3.1.0.md` is renamed to 3.2.0.

## Deliberately not built

- **A `knowl_read` tool returning one item whole.** At a 2,000 cap, truncation affects 9.4% of
  items, and `affectedPaths` — which PR #16 ships — already routes a reader to the source. A
  thirty-first tool costs description tokens in every `tools/list`, a row in the `KNOWL.md`
  routing table, and one more thing for an agent to route wrong. Revisit if truncation on real
  stores turns out to be common at 2,000.
- **A per-response character budget instead of a per-item cap.** More principled, and it bounds
  worst case exactly. It also makes response shape depend on result count, which is harder to
  test and harder for an agent to predict. The measured tail does not justify it.
- **Changing the `score` field shape.** PR #16 makes `score` a union of `number` and
  `uncalibrated (<reason>)`. A polymorphic JSON field is a fair objection, but the only
  concrete risk — a programmatic consumer — was checked and does not exist: the CLI builds its
  own shape in `src/cli/query-command.ts:41`, `context-composer.ts` has its own `compact`, and
  `knowl-cloud` reimplements the store rather than parsing MCP responses. The reader is an LLM
  told to judge by `score`, and a string it cannot overlook beats a field whose absence it can.
- **A config key for `synchronous`.** See above.
- **A separate truncation flag for titles.** At a 200-char cap against a measured max of 133,
  it would never fire.

## Known limits, stated rather than hidden

- Every distribution here is from **one store, this repository's own**. PR #16 reports 84–94% of
  items over 600 across its author's three stores, against 48.7% here — their corpus skews
  longer. The 2,000 choice is deliberately the conservative one for that reason, but a store
  with markedly longer atoms will see truncation more often than 9.4%.
- There are **no evidence excerpts in this store** (n = 0), so `MAX_PREVIEW_CHARS = 600` for
  excerpts is inherited rather than measured. It is unchanged from today's behaviour, so this
  design does not make it worse.
- The `synchronous` measurements are PR #16's, taken on the contributor's Windows machine, and
  are re-verified only to the extent that the merged suite passes. This design does not
  re-measure them; it makes the resulting policy overridable.

## Testing

Every item below is a failing test written before the change it covers.

**Constant split**
- Item content over 2,000 is cut and flagged `truncated: true`; content at exactly 2,000 is not.
- A title over 200 is cut at 200; the compact item carries no truncation flag for it.
- `formatHierarchyToMarkdown` and `formatRecentContextToMarkdown` still cap items at 600 —
  asserted against the constant, so raising the item cap cannot move them.
- `knowl_recent` and `knowl_state` output is byte-identical to before the raise.
- Evidence excerpts, timeline assertions, `skill_read` markdown, and `skill_run` stdout/stderr
  all still cut at 600.
- A context pack requested at a token budget stays within it when every candidate exceeds 2,000.

**Tool description**
- The `knowl_query` description contains the current value of `MAX_ITEM_CONTENT_CHARS` and no
  stale literal.

**Environment variable**
- Unset yields `synchronous = NORMAL` on all three databases.
- `FULL` yields `FULL` on all three.
- `OFF` is refused with a message naming the accepted values.
- An unrecognised value throws at startup rather than falling back.

**As-of branch**
- The as-of branch of `knowl_query` returns `affectedPaths` for a local item, and the test
  states in its name that this path is single-repo by construction.
