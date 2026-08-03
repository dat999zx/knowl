# Audit remediation — the eight lanes

Execution plan for the open findings in `audit-2026-08-04.md`. Written so a fresh session can
start immediately without re-deriving the partition.

## Why it is partitioned this way

**By file ownership, not by finding count.** Ten MCP findings live in `mcp/tools.ts`; ten
agents editing that file in parallel is a merge disaster no matter how independent the bugs
are. Lanes below share no files, so they run fully parallel in their own git worktrees
(`isolation: "worktree"` on the Agent tool) and merge back one at a time.

**Clusters stay whole.** Several findings are one bug wearing different hats. K-25/27/46 are
all *the lexical path treats its LIMIT as a filter*; K-28/29/30/35/70 are all *the scoring
function mixes incommensurable terms*. Splitting those across agents produces three patches
that each move a symptom. One lane, one shape.

## The lanes

| # | lane | owns | findings |
|---|---|---|---|
| 1 | MCP surface | `src/mcp/tools.ts`, `resources.ts`, `change-notice.ts` | K-03, 21, 22, 33, 34, 37, 38, 49, 50, 53, 54 |
| 2 | Retrieval + scoring | `src/store/agent-query.ts`, `search.ts`, `queries.ts`, `context-composer.ts` | K-25, 26, 27, 28, 29, 30, 31, 35, 46, 70 |
| 3 | Workspace boundaries | `src/workspace/*`, `store/store-handle.ts`, `connection-pool.ts` | K-04, 07, 08, 36, 39 |
| 4 | Transcripts | `src/transcripts/*` | K-09, 11, 12, 24, 32, 40, 47, 57 |
| 5 | Skills | `src/skills/registry.ts` (+ its schema in tools.ts — coordinate with lane 1) | K-05, 06, 69 |
| 6 | Write path | `src/store/knowledge-writer.ts`, `gc.ts`, `repository.ts`, `database.ts` | K-13, 14, 15, 17, 18, 19, 56 |
| 7 | CLI + retention | `src/index.ts`, `src/cli/*`, `store/snapshots.ts`, `store/hook-debounce.ts` | K-10, 16, 41(b)(c), 42, 43, 44, 48, 51, 52 |
| 8 | Embeddings | `src/ai/embeddings.ts`, `store/write-embedding.ts`, `cli/doctor-report.ts` | K-60(check), 61, 62, 63, 64, 66, 68 |

**One coordination point:** lane 5 needs the `entrypoints` schema in `tools.ts`, which lane 1
owns. Either give lane 1 that schema change (the design is already written in the research
verdict) or run lane 5 after lane 1 merges.

## The rules every lane gets

1. **Write the failing test first.** The fix is not done until reverting it turns the test red.
   Tonight's transcript test was named *"strips characters FTS5 would treat as operators"* — it
   asserted the bug. A test that passes both before and after proves nothing.
2. **Do not edit a test to make it pass** without saying so explicitly and justifying why the
   old assertion was wrong. Two tests legitimately encoded defects tonight; both were rewritten
   deliberately, with the reasoning in the commit.
3. **Fix the mechanism, not the symptom.** If the ledger groups your findings, they get one
   change, not one each.
4. **Run the FULL suite, not your lane's.** The build change passed only because all 1,351 tests
   ran; nothing in a "build config" lane would have caught a break in transcripts.
5. **Never touch a live database.** Copy first. `D:\Code\DuckPrep-server`, `D:\Code\SAT-tests-server`
   and `D:\claude convo\students` are real memory.
6. **Report what you could not verify.** A finding downgraded to "seems fine" is more useful than
   a fix that was never exercised.

## Known-flaky tests — do not chase these

`tests/transcripts/backfill.test.ts > keeps what it indexed when the budget runs out` and
`tests/transcripts/index-pass.test.ts > resumes after a crash mid-file` are wall-clock
assertions that fail only inside the full parallel run on a loaded machine. Both pass 3/3 in
isolation and both fail on unmodified `main`. The two `upgrade-all` tests exceed the 30s
default timeout and were measured *slower* before this branch's changes.

## Review protocol before anything merges

Per lane: read the diff, confirm the fix addresses the mechanism the ledger names, confirm the
test fails when the fix is reverted, run the full suite, then merge one lane at a time and
rebuild. `dist/` is the live global install for every repo on this machine — a broken build
there breaks knowl everywhere.
