# Demand-paged knowledge scoping — design

2026-08-07

Follow-up to [optional transcript search](2026-08-03-optional-transcript-search-design.md) and
[the per-model relevance floor](2026-08-04-per-model-relevance-floor-design.md), both of which
this design turns out to depend on.

## The problem

A workspace makes knowledge *reachable*, and almost none of it is. Measured on the `duck`
workspace, three linked repos, 2026-08-06:

| repo | repo-private | workspace-visible | shared |
| --- | --- | --- | --- |
| duckprep | 634 | 31 | 4.7% |
| ducksat | 223 | 18 | 7.5% |
| students | 0 | 48 | 100% (`defaultVisibility`) |

The two code repos strand ~95% of what they know. This is not a configuration mistake. Sharing
is a manual, per-item act (`knowl workspace promote`), promotion is irreversible, and neither
property is one a person exercises 850 times. The default is private and the default is what
happens.

The visible symptom is an **asymmetric surface**: seven rules exist word-for-word in both code
repos, and in all seven the ducksat copy is shared while the duckprep copy is private. Nobody
decided that. It is the residue of whichever repo someone happened to be standing in when they
thought to run the command. A query from duckprep finds the ducksat copy of a rule it also
holds; the reverse query finds nothing.

### What the naive fix gets wrong

"Promote more" is the wrong shape. Promotion is semantically irreversible — there is no
un-share — so a bulk pass converts a reversible under-sharing problem into an unfixable
over-sharing one. And it is a **static** declaration of scope: the decision is made once, before
anyone knows which of the 857 items another repo will ever ask for.

A research sweep over five adjacent mechanisms (Governed Shared Memory, arXiv 2606.24535;
MemOS, 2507.03724; HippoRAG; IFC/contextual integrity; federated-search resource selection)
found the same gap in all of them: **every one declares scope statically. None learns it from
demand.** That is the opening this design takes.

## Design

**Atoms stay private. A cross-repo miss faults through to a channel that is already
content-safe, and the fault is logged. Sharing is proposed later, from evidence.**

The name is the analogy: a page stays out of memory until something references it, and the
reference is what causes it to be paged in. Here the "reference" is a query from another repo
that the workspace could not answer, and paging in is a promotion proposed to a human.

1. **Read-side truthfulness (Phase A).** Before anything can be learned from misses, a miss has
   to be detectable. Three defects blocked that; all three ship regardless of the rest of this
   design, because each is a bug on its own terms.
2. **Fault path on (Phase B).** `search.transcripts.share` in all three repos, so a query that
   knowledge cannot answer reaches session transcripts — which hold the same facts in
   already-written prose and are separately gated.
3. **Demand ledger (Phase C), measure-only.** A workspace-level SQLite file recording every
   federated query: fingerprint, score, which repo served it. No behaviour depends on it. It
   exists to answer "what does one repo actually ask another for" with data instead of intuition.
4. **Consolidator (Phase D), review-only and gated.** Proposes promotions where demand,
   peer-duplication and content-sensitivity agree. Never applies without explicit ids.

## Findings that reshaped it

An adversarial design review produced twelve findings. Five changed the design rather than the
code:

1. **The abstention floor fires far less than assumed.** On the real 483-item store, off-topic
   queries top out around 0.29 against a 0.16 floor. So "weak query" cannot be the ledger's
   write predicate — the ledger logs **everything** and the predicate is calibrated from the
   data afterwards. (Corpus size drives this: on a 2-item fixture the same off-topic query tops
   out at 0.05 and abstention fires cleanly. The floor is not broken; it is corpus-dependent,
   which is the reason it is reported rather than enforced.)
2. **The consolidator must run in the owning repo.** Peer reads pin `visibility = 'workspace'`
   in SQL precisely so a peer's private row is never read into another process. A consolidator
   that ranked peers' private atoms would break that invariant to build its candidate list. The
   ledger is therefore the *only* cross-repo channel: it carries queries, never content.
3. **Provenance cannot be treated as safety.** An atom with no `affectedPaths` is UNKNOWN, not
   safe. Sensitivity gating runs on content, and absent provenance can only ever downgrade a
   candidate, never clear one.
4. **`sameSubjectTitle` is unproven for this use.** It is the write-path duplicate matcher. The
   flagship duplicate pair — the two "table styling" rules — **fails** it, because one title
   omits a token the other has. Anything built on it must measure it first.
5. **`promoteItems` throws mid-batch, and its `closeDb()` tears down every pooled peer handle.**
   So apply is one call, made last, over pre-filtered ids.

## Decisions

| # | Decision | Why |
| --- | --- | --- |
| 1 | Transcript sharing in all three repos | Full reachability; single-user machine; PII question asked and answered |
| 2 | Consolidator is review-list only; `--apply` takes explicit ids | Promotion is irreversible and none of the three gates is field-validated |
| 3 | Kin-peer overlaps are never auto-promotable | `kin` marks diverged forks: same subject is as likely to mean contradiction as agreement |
| 4 | The ledger logs every federated query, not just weak ones | Finding 1 — the weak predicate fires ~never, so it cannot be the trigger |
| 5 | The consolidator runs in the owning repo | Finding 2 — the peer-privacy invariant is in SQL and must stay there |
| 6 | Fingerprint always; query terms only after the repo's secret validators pass | Do not hold in a workspace file what the knowledge store would refuse |
| 7 | Phase D is gated on measured evidence, and not building it is a success condition | A mechanism with no demand behind it is the thing this design objects to |

## Phase A in detail

Three read-side defects, each independently a bug:

1. **The relevance floor never reached federated ranking.** `rankKnowledge` passes
   `vector.relevanceFloor` into `scoreCandidates`; `queryFederated` did not. So `minRelevance`
   arrived `null` on every workspace query, `answerable` was unconditionally true, no federated
   result could carry `abstained`, and `knowl_query`'s NO CONFIDENT MATCH block was unreachable
   code **from the moment a repo was linked**. A linked repo is where the verdict matters most,
   because the alternative on offer is another repo's near-miss.
2. **`kin` was a write-time signal only.** `findCrossRepoOverlap` searches a kin peer wider and
   the CLI advisory says "shares this repo's lineage" — so the person *storing* a fact was
   warned about divergence and the agent *reading* one was not. Reading is where a diverged
   convention gets applied to the wrong repo: `question_bank` is a live table in one repo of the
   `duck` kin pair and a dropped one in the other, and a federated hit said neither.
3. **The miss notice named no next move.** An abstention is the one moment the agent has
   concluded memory is empty — exactly when transcript search can still answer, since past
   sessions are indexed separately and `knowl_query` never touches them. The notice now names
   `knowl_transcript_search`, but only where `search.transcripts.enabled` is true: naming a tool
   the build does not expose is worse than saying nothing.

## Phase D: the gate, measured 2026-08-07 — SHUT

Both halves were checked before writing any consolidator code. Both fail, so **Phase D is not
built**. That is the designed outcome, not a setback: a mechanism with no demand behind it is
the thing this design objects to.

**Half one — ledger volume.** The gate wants ≥50 `federated_query` events. The ledger shipped
today; it holds none. Nothing to calibrate against yet.

**Half two — does `sameSubjectTitle` find the known duplicates?** It is a *containment* test:
the shorter title's significant tokens must be wholly inside the longer's. Measured over the
seven pairs recorded in knowl atom `d9b78d5c049a4765`:

| pair | verdict | why |
| --- | --- | --- |
| College Board questions off the public site | **MISS** | `Legal` only on one side, `copyright` only on the other |
| never view rendered quiz screenshots | MATCH | |
| wrap math lines for KaTeX | MATCH | |
| **table styling** | **MISS** | `bold` phrased as `ask before bold` vs `which row/column is bold` |
| no reflexive Playwright | MATCH | |
| PDF ingestion archive rule | **MISS** | the duckprep copy's counterpart has drifted to a different rule |
| account velocity flags | MATCH | |

**4 of 7 — below the 5/7 bar.** The review's specific prediction is confirmed: the flagship
"table styling" pair fails, and so does the highest-similarity pair in the whole workspace
(Jaccard 0.82). Containment is the wrong shape for this job — two independently-written titles
for one rule almost always each carry a word the other lacks, and one such word is enough to
veto the match.

Swept over all 32 title pairs at Jaccard ≥ 0.30, the matcher fires on 12. The sweep also
surfaces a second problem any future candidate builder must handle: auto-captured
`Resolved failure in <path>: <stack line>` atoms pair with each other on generic tokens and
would flood a proposal list with noise.

`sameSubjectTitle` itself is *not* at fault: it is the write-path duplicate check, where a
false positive blocks a legitimate write, and containment is the right conservatism there.

### A replacement matcher, measured

Rather than leave "needs a different matcher" as a note, four candidates were measured against
the seven pairs (which must match) and a hard-negative set (which must not). Recall alone
cannot pick a matcher — `() => true` scores 7/7 — so the verdict is **separation**: the worst
positive must beat the best negative.

| matcher | worst positive | best negative | verdict |
| --- | --- | --- | --- |
| `sameSubjectTitle` (containment) | 0.000 | 0.000 | overlaps — 3 positives score zero |
| Jaccard | 0.375 | 0.375 | overlaps, exactly ties |
| Dice | 0.545 | 0.545 | overlaps, exactly ties |
| **overlap coefficient, stopwords dropped** | **0.667** | **0.545** | **separates** |
| title cosine (workspace-pinned model) | 0.628 | 0.715 | **overlaps — worse than tokens** |

The embedding approach this document originally proposed is the one to *reject*: a negative pair
scores 0.715, above the worst true pair at 0.628. Two unrelated SAT-domain rules read as similar
to the model because they share a domain, which is precisely the distinction that matters here.

**The overlap coefficient over stopword-stripped title tokens separates cleanly.** Swept at a
0.60 cut with a 3-significant-token floor across all 165,085 duckprep × ducksat pairs:

- 73 pairs fire; **47 are auto-captured `Resolved failure in <path>` atoms** — excluded by title
  prefix, they are never knowledge anyone would promote.
- 26 real subject pairs remain, of which **8 are promotion candidates** (private in one repo,
  shared in the other).
- All seven known pairs are in those eight, **including the two containment missed**, plus an
  eighth (`SAT domain names use 'and'`) that the original Jaccard ≥ 0.30 sweep did not surface.

So half two of the gate is **passed** by the replacement. Eight candidates out of 165,085 pairs
is a list a person reviews in a minute, which is the shape the design asked for. Half one — real
ledger volume — remains the open half, and the consolidator stays unbuilt until it fills.

## What this design does not do

- **No auto-apply.** Revisit after ≥1 month of review-list use with zero bad proposals.
- **No resource-selection routing** (CORI/ReDDE-style repo profiles). Revisit above 3 repos, or
  when measured cross-repo precision degrades.
- **No multi-machine ledger sync, no per-peer transcript ACLs.** Accepted v1 losses; the
  consolidate report states that the ledger is this-machine-only.
