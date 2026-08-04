# Mutation testing: `store/agent-query.ts` and `store/knowledge-writer.ts`

Round two of the mutation work. Round one established the method and found that the K-02
secret-scanning fix had a comment and no test; this round points the same instrument at the two
files where a silent hole costs the most and nobody had looked: the ranker and the write path.

Branch `r/mutation-deep2`, based on `fork/mainline-2.16` at `214166d` (upstream v3.0.0 merged).
Mainline has since advanced past that commit — the suite on **this** base is 1,826, not the 1,829
a later mainline reports.

Everything below is **[MEASURED] here** unless marked otherwise.

---

## 1. Coverage, as a fraction

| File | Lines | Mutants run | Mutants NOT run | Covering sets used |
| --- | --- | --- | --- | --- |
| `src/store/agent-query.ts` | 726 | **299 / 299 (100%)** | none | 4 sweep passes + 74-file static cover + whole in-process suite |
| `src/store/knowledge-writer.ts` | 626 | **246**, lines 79–327 only | lines 1–78 and 328–626 | 1 sweep pass + 59-file cover |
| `src/mcp/tool-schema.ts` | 217 | **0** | all | not attempted — dropped by instruction |

**What `knowledge-writer.ts` did NOT get.** Only the pure decision half was mutated:
`duplicateTokens`, `tokenOverlapScore`, `searchableText`, `findLikelyDuplicateKnowledgeItem`,
`normalizedIdentity`, `sameSubjectTitle`, `nonEmptySet`, `scalarCarriesNothingNew`,
`setCarriesNothingNew`, `carriesNothingNew`, `evidenceKey`, `heldPayloadFor`, `resolveDuplicate`.
**Not mutated:** `resolveSupersedeTarget`, the workspace cache, `crossRepoOverlapForWrite`,
`storeKnowledgeItemDeduped` and `storeKnowledgeAtomsDeduped` — i.e. the transaction handling,
commit-record construction and batch atomicity are **unmeasured**. Read the writer numbers as
"the dedup/subsumption decision", never as "the write path".

The file was timeboxed because its covering tests are all libSQL-backed. Measured here:
**4.5 s/mutant** on that file against **0.88 s/mutant** on the DB-free ranker set.

---

## 2. Method, and why the union matters

Stryker 9.6.1 + `@stryker-mutator/vitest-runner`, installed under `.tmp/tools`, **not** a
devDependency (CI runs `npm ci && npm run build && npm test`; a devDependency would add ~209
packages CI never uses). Driven by `scripts/mutation/run.mjs` and `scripts/mutation/probe.mjs`.
`disableTypeChecks: false` and `concurrency: 1` throughout, for the reasons those files document.

### Stage 1 — sweep, one covering file at a time, then union

A seven-file test set **could not be swept at all**: it runs in 4.6 s under plain vitest and did
not finish Stryker's dry run in 300 s. Stryker's runner shares one process across files with no
isolation, and three of those files open libSQL fixtures and then `fs.rm` them, which on Windows
retries against the `-shm` handle the previous file still holds. Cost of learning that: 327 s.
`run.mjs` now takes `KNOWL_MUTATION_DRY_RUN_MINUTES` (default **2**) so the next bad set announces
itself in two minutes rather than five. **Split the set; do not raise the budget.**

So each covering file was swept alone (or in an all-DB-free group) over the **same 299 mutants**,
and the results unioned by `mutatorName @ line:col-line:col # replacement`.

**The union rule, and why it is the only honest one:** a mutant is
`Killed` if **any** pass killed it, else `Survived` if **any** pass survived it, else `Timeout`,
else `NoCoverage`. "Survived pass C" means only "rank-knowledge.test.ts cannot see it". Only
"survived every pass" is a candidate hole. Script: `.tmp/union-agent-query.mjs` (scratch).

### Stage 2 — confirm each candidate alone, in a fresh process

`probe.mjs` applies one mutation, runs a whole test set once in a **new** vitest process, and
takes the verdict from the process exit code. Two properties matter:

- **Verdicts come from exit codes, never regex on output.** The first version of `probe.mjs`
  matched `/Tests\s+\d+ failed/`; vitest writes ANSI escapes between the label and the count, so
  it reported SURVIVED for everything — an assertion that could not fail, which is the defect
  class this work exists to find.
- **Every batch carries a control**: a mutation a *named existing test* kills. If the control
  survives, the run exits non-zero and its findings are void. Controls used here:
  `FRESHNESS_PRIOR_STALE = 0.88 -> 0.5` (killed by `scoring.test.ts` K-70) and the duplicate
  threshold `>= 0.35 -> >= 0.99` (killed by `supersede-on-write.test.ts`). Both killed in every
  batch reported below.

### The static covering set is a **lower bound** — this bit us

`select-tests.mjs` follows static `import` specifiers only. For `agent-query.ts` it returns 74
visible files, and **`tests/mcp/query-score-surface.test.ts` is not among them** even though it
asserts the `uncalibrated` labels — the MCP path reaches the module through a dynamic import.
Confirming against the 74-file set produced three false "holes" in the `uncalibrated` cluster;
re-confirming against the **whole in-process suite** killed two of them. Confirm against the whole
suite before reporting. It costs ~55 s per mutant here, not the ~335 s the older note claims
(that figure was for a serialised run; `probe.mjs` does not serialise).

### The timeout verdict

**Timeouts on this repo are a runner artifact, not a verdict, and are scored as "no information".**

The control is decisive: pass A — four DB-free files, the same 299 mutants — timed out **0** times.
The three libSQL-backed passes timed out 16, 31 and 35 times, and their timeout lists contain
mutants that *cannot* loop: `StringLiteral -> ""`, `ObjectLiteral -> {}`, `'stale' -> ""`. That is
the vitest child dying under Stryker's serial, non-isolated re-runs and being recorded against
whichever mutant was in flight. Counting them as kills would inflate every score with the tool's
own instability. In the union they rank **below** Survived, so a mutant is only reported as
`Timeout` if *no* pass produced a real verdict for it (2 of 299 before, 3 after).

---

## 3. `src/store/agent-query.ts` — results

### Sweep passes (299 mutants each)

| Pass | Covering file(s) | Killed | Survived | NoCov | Timeout | Wall |
| --- | --- | --- | --- | --- | --- | --- |
| A | `relevance-floor`, `floor-non-destructive`, `floor-uncalibrated`, `core/model-relevance-floor` | 81 | 145 | 73 | 0 | 263 s |
| B | `scoring.test.ts` | 139 | 111 | 33 | 16 | 544 s |
| C | `rank-knowledge.test.ts` | 79 | 135 | 54 | 31 | 950 s |
| D | `small-peer-lexical.test.ts` | 41 | 112 | 111 | 35 | 1025 s |
| **union** | | **165** | **107** | **25** | **2** | **2782 s** |

### Score

| | Killed / all 299 | Killed / covered 274 |
| --- | --- | --- |
| **before** | 165 — **55.2%** | **60.2%** |
| **after** | 194 — **64.9%** | **70.8%** |

After = re-sweep of passes A, B, C (the three whose files changed) unioned with pass D unchanged.
**+29 mutants killed by 6 added/strengthened tests** — 26 of them from the four new cases in
`scoring.test.ts` alone, so the tests generalise well past the mutants that motivated them.
Survivors 107 → 77.

### Funnel

107 sweep survivors → 21 shortlisted and probed against the 74-file cover (12 survived) → 13
probed against the whole in-process suite → **10 confirmed**. 9 now killed; 1 judged equivalent.

### Confirmed holes — all survived the ENTIRE in-process suite

| # | Line | Mutation | What it proves untested | Judgment | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | 563 | `Math.min(Math.max(confidence ?? 1, 0), 1)` → `Math.max(Math.max(…))` | The clamp whose comment says "a model emitting a percent scale would otherwise be a permanent multiplier on every query". An out-of-range confidence — which `confidence-bounds.test.ts` asserts can still be *imported* from a pre-guard export — takes `prior` above 1 and the score above its own relevance. | **Real, high.** The exact K-02 shape: a comment and no test. | tested |
| 2 | 573 | `CONFIDENCE_PRIOR_FLOOR + (1-…)*confidence` → `-` | Prior direction. A confidence-0 item outranks an identical confidence-1 item. | **Real, high** — ordering change. | tested |
| 3 | 185 | `[...left].filter(t => right.has(t)).length / union.size` → `[...left].length / union.size` | Near-duplicate overlap becomes one-sided containment. A long note is demoted off the page as "the same note written twice" because a short note above it used some of its words. | **Real, high** — changes the returned *set*. | tested |
| 4 | 528 | `const anyLexical = corpusBest.size > 0` → `true` | Alpha's renormalisation onto the semantic half when nothing matched lexically. Every score on such a query becomes 0.8× its cosine. | **Real, medium.** Reorders nothing; the score is this file's product (K-35: comparable across queries), so a silent 20% haircut is a calibration defect. | tested |
| 5 | 568 | `!identifier \|\| containsIdentifier(item, identifier)` → `&&` | The identifier prior stops discriminating: every row of an identifier query takes the miss prior. | **Real, medium.** Uniform on its own, but it deletes the tie-break the prior exists to provide. | tested |
| 6 | 191 | `!/[./#:_-]/.test(identifier)` → drop the `!` | The gate on `identifierQuery`. Prose queries become identifier queries and identifiers stop being ones. | **Real, medium.** | tested |
| 7 | 622 | `typeof x === 'number' && Number.isFinite(x)` → `\|\|` | The `Number.isFinite` half was doing nothing observable. A `NaN` floor is accepted, and `bestCosine >= NaN` is false, so **every** query abstains. | **Real, low reachability** — `relevanceFloorFor` never returns NaN; reachable only through the exported `scoreCandidates`. | tested |
| 8 | 587 | `if (usingVector)` → `if (true)` | The lexical path is not proved to skip abstention: the existing case passed because it supplied no floor, so `floor === null` short-circuited before the path mattered. | **Real, contract-level.** No production path sets `embedded` without vector, so this is unreachable today; the guard is currently redundant. Fixed by adding `minRelevance` to the existing case. | tested |
| 9 | 389 | `Math.max(limit * 3, 10)` → `Math.min(…)` (and `limit * 3` → `limit / 3`) | The candidate pool. Every existing case asks for the default limit 3, where `3*3` and `10` both round to 10 and the mutants are invisible. | **Real, medium.** Not a page-size change but a fusion change: rank 11+ never reaches scoring, so the semantic half can no longer lift a row lexical ranked low. | tested |
| 10 | 661 | `vectorScore !== undefined \|\| embedded === true` → `&&` | A row vector actually returned would still be labelled `uncalibrated: 'not embedded'`. | **EQUIVALENT in production.** `selectCandidates` sets `embedded: true` on every row vector returns, so the `\|\|` is belt-and-braces. Reported, deliberately not tested. | not tested |

### Killed by the wider suite — do NOT re-investigate

These looked like holes against the narrow sweep set and are **not**. Recorded so nobody pays for
them twice:

`freshness === 'stale' → !==` (killed by `cli/query-command`), `category === → !==` (`store.test`,
`namespaces`), `tier === 'verified' → !==` and `provenance === 'inferred' → !==` (`tier.test`),
`RECENCY_PRIOR_FLOOR + … → -` (`store.test`), the lexicalCoverage clamp at L555
(`small-peer-lexical`, `cross-repo-eval`), `limit: options.limit ?? DEFAULT → &&` at L708
(`cli/query-command`, `access-feedback`), `rank: index + 1 → index - 1` at L723 (`access-feedback`),
and two of the three `uncalibrated` mutants — L660 `!usingVector → usingVector` and L679
`{ uncalibrated } → {}` — both killed by `tests/mcp/query-score-surface.test.ts`.

**Five of my seven "prior direction" candidates died at this step.** That is the single most
important lesson of the round: a sweep survivor is a candidate, never a finding.

### Equivalents rejected without probing (~30 of the 107, by category)

- **Perf-only short circuits.** `withoutDuplicates`' `if (kept.length >= limit) break` → `>` or
  `false` (the trailing `.slice(0, limit)` makes the result identical); the `tokensOf` memo at
  L347.
- **Unreachable boundaries.** `diversity >= 0.9` → `>` (differs only at exactly 0.9);
  `best > 0` → `>= 0` (`raw/0` → `Infinity`, `Math.min(…, 1)` → 1 → same value as the else
  branch); `union.size === 0` → `false` (0/0 → NaN, and `NaN >= 0.9` is false, same outcome).
- **Provably-true conditions.** `floor === null` → `false` at L625: with `floor === null`,
  `bestCosine >= null` coerces to `>= 0` and `bestCosine` is a `Math.max` seeded at 0, so
  `answerable` is true either way.
- **Regex/string-literal noise.** `'Stryker was here!'` substitutions into template literals and
  the `reason` string; the `reason` text is human-readable and every number in it is separately
  asserted through `contributions`. Round one measured this class at ~22% and it holds here.
- **NoCoverage in `selectCandidates` (25 mutants).** Lines 407–447 — the vector-search branch and
  the `findEmbeddedItemIds` backfill — are reached by no test in any of the four covering files.
  Not equivalent, **unmeasured**: the shortest path to more score on this file.

---

## 4. `src/store/knowledge-writer.ts` — results (timeboxed sample)

One sweep pass, lines 79–327, `tests/store/supersede-on-write.test.ts`:
**246 mutants — 108 killed, 78 survived, 38 timeout (artifact), 22 NoCoverage. 1110 s.**

Re-swept after the tests landed: **135 killed, 53 survived, 51 timeout, 7 NoCoverage. 1384 s.**

| | Killed / all 246 | Killed / covered |
| --- | --- | --- |
| **before** | 108 — **43.9%** | 108/224 — **48.2%** |
| **after** | 135 — **54.9%** | 135/239 — **56.5%** |

**+27 killed by 4 added cases**, the same ~4× multiplier the ranker showed. NoCoverage fell 22 → 7
because the new skill and exclusivity cases reach code no previous test entered. Timeouts rose
38 → 51, which is the runner artifact and not a change in what is detected — see §2.

13 candidates probed against the 59-file covering set (~31 s each); control killed; **9 survived**.
Six now killed by four new cases in `supersede-on-write.test.ts`, each proved red-before-green
through the probe.

### Confirmed holes

| # | Line | Mutation | What it proves untested | Judgment | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | 158 | `if (smaller.size < 2) return false` → disabled | The one-token-title exclusion, stated in the comment above `sameSubjectTitle`: "A one-token title ('Auth') is too coarse to carry this and is excluded." A note titled `Auth` retires `Auth token rotation`. | **Real, high.** Comment and no test. | tested |
| 2 | 233 | `incoming.conflictExclusive !== true \|\| held.conflictExclusive === true` → `true` | A write that *newly declares* `conflictExclusive` is answered "already held verbatim" and dropped, so the exclusivity is never registered — the guard silently off, the same failure already found once on the batch path. | **Real, high.** | tested |
| 3 | 245 | the whole `steps` clause of `carriesNothingNew` → `true` | A skill re-stored with **different steps** is dropped as a no-op. | **Real, high.** Same family as K-02's skill `steps`. | tested |
| 4 | 267 | `duplicate.category === 'skill'` → `!==` | A skill's held steps are never fetched, so `held.steps` is always `[]` and an *unchanged* skill churns a new version on every re-store. | **Real, high.** | tested |
| 5 | 142 | `.replace(/\s+/g, ' ').trim()` removed from `normalizedIdentity` | "Already held verbatim" becomes byte-exact, so a restatement differing only in whitespace supersedes instead of deduping. | **Real, medium.** | tested |
| 6 | 316 | `input.supersedes === duplicate.id` → `!==` | See the note below — the explicit-`supersedes` path. | **Real, high.** | tested |
| 7 | 99 | `intersection / Math.min(left.size, right.size)` → `Math.max` | The deliberate asymmetry of the duplicate score. A short restatement fully contained in a long held note stops being detected as a duplicate and coexists instead of superseding. | **Real, medium.** | **not tested** |
| 8 | 137 | `tokenOverlapScore(...) >= 0.35` → `true` | Nothing asserts that an *unrelated* top-3 search hit is **not** reported as a near-duplicate. Every top-3 hit becomes a "likely duplicate". | **Real, medium.** | **not tested** |
| 9 | 85 | `token.length >= 2` → `> 2` | Two-character tokens (`ci`, `db`, `ui`, `s3`) stop counting toward duplicate identity. | **Real, low** — shifts overlap scores and can flip the 0.35 boundary, but no clean realistic case. | **not tested** |

### A live behaviour found while writing a test, not a hole

Hole #6's first test **failed on unmutated code**. `resolveSupersedeTarget` prefers the detected
duplicate over the explicit id whenever the resolution qualifies, so **when the duplicate search
finds a same-subject match, `supersedes: X` retires the duplicate and leaves X active.** That is
current behaviour on `fork/mainline-2.16`, not something this branch changed. The committed test
pins the *unrelated-neighbour* case, where the explicit id does win, and says so in a comment.
**Someone should decide whether the explicit id ought to win outright.**

---

## 5. Tests added — with control-gate proof

Suite **1,826 → 1,836, 0 failures**. `npx tsc --noEmit` → **0**.
`git diff --stat` and `git diff --ignore-all-space --stat` identical (no whitespace churn).

| File | Cases | Mutants proved killed |
| --- | --- | --- |
| `tests/store/scoring.test.ts` | +4 | confidence direction + clamp, alpha renormalisation, one-sided overlap, identifier prior + gate |
| `tests/store/floor-uncalibrated.test.ts` | +1 | non-finite floor |
| `tests/store/floor-non-destructive.test.ts` | 0 (existing case strengthened with `minRelevance`) | floor on the lexical path |
| `tests/store/rank-knowledge.test.ts` | +1 | candidate pool |
| `tests/store/supersede-on-write.test.ts` | +4 | one-token title, exclusive subsumption, steps subsumption, skill steps not fetched, identity whitespace, explicit supersedes |

Proof runs, both with a control that killed:

- agent-query: 10 probes, **0 of 10 survived** (all were SURVIVED whole-suite before).
- knowledge-writer: 7 probes, **0 of 7 survived**.

One of those took two attempts and the reason is worth keeping: the first exclusivity test passed
and did **not** kill its mutant, because varying `conflictKey` alongside `conflictExclusive` let
`conflictKey` decide the no-op on its own and the exclusivity clause was never reached. A test can
look like it covers a rule and be decided by a different one. The probe is what caught it.

---

## 6. Not done — named plainly

- **`src/mcp/tool-schema.ts`: 0 of ~217 lines mutated.** Dropped by instruction.
- **`knowledge-writer.ts` lines 1–78 and 328–626 were never mutated** — the transaction handling,
  commit records and batch atomicity are unmeasured. Roughly 60% of the file.
- **`knowledge-writer` holes #7, #8, #9 have no tests.** Rows above are complete enough to write
  them without re-running anything.
- **agent-query lines 407–447 have no covering test at all** (25 NoCoverage mutants). Adding one
  test that drives `selectCandidates` down the vector branch would convert the largest remaining
  block on the file.
- **Only one covering file was swept for `knowledge-writer`.** `gc-duplicate-survivor.test.ts`
  also exercises `carriesNothingNew` (through GC) and was used at the confirm stage but never in a
  sweep, so the writer's *sweep* numbers are a lower bound on what the suite kills.

---

## 7. Measured cost

| Activity | Cost |
| --- | --- |
| agent-query sweep, 4 passes | 2782 s (46 min) |
| agent-query, failed 7-file attempt | 327 s |
| agent-query confirm, 74-file cover, 21 probes | ~12.6 min |
| agent-query confirm, whole suite, 13 probes | ~11.9 min |
| agent-query re-sweep (A, B, C) | ~30 min |
| knowledge-writer sweep, 1 pass | 1110 s (18.5 min) |
| knowledge-writer re-sweep | 1384 s (23 min) |
| knowledge-writer confirm, 59-file cover, 13 probes | ~6.7 min |
| red-before-green proofs | ~1 min total (2 s per probe, narrow scope) |

Rates: **0.88 s/mutant** DB-free · **~4.5 s/mutant** libSQL-backed · **~36 s** per 74-file
confirmation · **~55 s** per whole-suite confirmation.
