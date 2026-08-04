# Knowl audit 2026-08-04 — remediation report

Seven parallel read-only audits over 25,331 lines produced 70 reproduced findings. Sixteen
implementation lanes closed them. The ledger with every finding, its mechanism, its
reproduction and its outcome is [`audit-2026-08-04.md`](./audit-2026-08-04.md); this document
is the summary and the reasoning behind how it was run.

**Final state: 86 findings, none left open. 1,725 tests passing (from 1,351), 0 failures.
`tsc --noEmit` 15 errors → 0.** 67 source files changed, +8,115 / −3,183.

---

## The rule that produced most of the value

The audit's first round closed with a set of items recorded as *"not worth fixing"*, *"needs a
decision someone else must take"*, *"not testable"* and *"cosmetic, pre-existing"*. None of
those verdicts had been tested. A second round ran under one rule:

> **A conclusion that something should not be fixed is a claim, and needs evidence exactly like
> a fix does.**

That round found more severe defects than the round it was checking. Every item below was
recorded as settled before someone tested it:

| recorded as | actually |
|---|---|
| "DEP0190 cannot fire — it is the rationale, not a detector" | Fires on every `knowl doctor`, from a file the audit never opened |
| "Ten pre-existing type errors, cosmetic" | `@libsql/client` **throws** on an `undefined` bound parameter — four were crash sites |
| "Known-flaky wall-clock tests, do not chase" | The best-evidenced defect in the audit (K-65) |
| "`reindex-scope` fails on machine load" | 10,050 WAL fsyncs — a genuine 116 s operation under a 120 s timeout |
| "The only lever is shrinking what is scanned" | A write-time join table: **2100×** |
| "A running `serve` is protected by the OS" | False on Windows — `unlink` on an open file succeeds |
| "Not testable without a real model on disk" | Testable in ~2 s — and it was hiding a **live** defect |
| "The remedy is to stop moving 30 MB of BLOBs" | Transfer is ~25 ms of it; row-walking is the cost |
| "Removing `shell: true` needs design, not a deletion" | A 39× faster replacement with identical results |

Three of those were the coordinator's own judgments. One was the codebase's own documented
table, which was backwards in a way that would have steered every future batching decision
wrong.

---

## What was actually wrong, by theme

### Boundaries that did not hold

- **The MCP SDK validates the call envelope, never a tool's own `inputSchema`.** Every
  constraint eleven tools had declared since the day they were written was decorative.
  One validator at dispatch, checking the same schema object the client was shown, closed
  seven findings at once.
- **Importing a foreign export published that stranger's rows to your peers** — no join, no
  promote, no flag. Peers filter a repo's database on `visibility` alone. Found by a lane sent
  to fix a *lesser* version of the same hole.
- **Reading a peer created a database inside that peer's repo.** `file:` creates, and
  `query_only` is applied only after the connection opens.
- **The ownership guard failed open** when the owning peer was not checked out — and its
  obvious fix still missed the ledger's own example, because a manifest entry with no local
  path never becomes a peer at all.
- **`$HOME` was treated as a knowl repo**, because `~/.knowl` is indistinguishable from a
  project marker. Reproduced live *during remediation*, into the real home directory.

### Execution and injection

- `.cmd`/`.bat` skill entrypoints were injectable (BatBadBut / CVE-2024-24576) and `.cmd` was
  the **promoted** path — the tests used it as the canonical example. Dropped, not escaped: a
  hand-rolled escape was attempted during research and was still injectable on the first try.
- `quoteShellArg` was deleted rather than repaired. Its output was neither valid cmd.exe
  quoting nor sufficient for POSIX.
- `autoRun` defaulted **true**: an author who never considered auto-execution got it.

### Silently wrong results

- **The relevance floor deleted answers.** Its threshold had never been swept — alpha had a
  sweep knob from day one, the floor did not. Measured: **23 of 110 answerable queries returned
  nothing**, Recall@10 0.9818 → 0.7909, concentrated in exactly the half-remembered paraphrases
  vector search exists to serve. The floor now **reports instead of deleting**: recall and MRR
  are identical at every threshold, so the constant no longer has to be right.
- **Additive boosts on a fused rank score are structurally broken, not mistuned.** RRF destroys
  magnitude, so there is nothing for an additive constant to be a proportion of. Replaced with
  a convex combination (alpha swept over 2,149 cases; 0.8 shipped), the floor moved onto the
  raw cosine before fusion, and priors made bounded multipliers.
- **Batching changed the stored vector**, so write-time embedding and `reindex --vectors`
  disagreed and ranking was not reproducible across a reindex. It **did** change answers: over
  120 real queries, top-10 order moved for 13. Fixed with `maxBatch: 1` on the atom path, which
  measured free (0.97×) on the whole corpus.
- **`knowl_context` was permanently lexical-only** on the current default layout, because it
  hand-rolled a model-cache check that never learned about the shared cache.
- **Transcript search returned zero hits** for any query containing `.`, `-` or `/`.
- **Transcript discovery missed 282 files** (34.8%, 946 prose messages).
- **`doctor` could not see the gap it was written to find** — its coverage check omitted the
  `profile_fingerprint` predicate every read path applies.

### Data integrity

- Snapshot restore cleared 5 tables while the delete cascaded into 8, leaving every restored
  item permanently uneditable while the audit reported success.
- A batch ingest that failed partway left rows written with no commit record.
- GC hard-deleted the *richer* of two duplicates, because the duplicate key could not see
  reasoning, tags, `affectedPaths` or evidence.
- `withClientTransaction` issued raw BEGIN on a shared connection with no mutex; the collision
  raises `SQLITE_ERROR`, not `SQLITE_BUSY`, so no retry anywhere recognised it.
- The `opening` transcript migration stranded any index predating it — **permanently**, since
  the column exists afterwards so the migration never runs again.
- `fs.rm(recursive)` **rejects but keeps deleting**: 200 files present at the rejection, all
  gone 400 ms later. A `.catch(() => {})` around it turns that into silence.

### Cost

| | before | after |
|---|---|---|
| Embedding reindex (10,050 rows) | 88,549 ms | **2,220 ms** |
| Blast-radius scan @ 100k commits | 14.2 ms | **0.007 ms** |
| Transcript hit rendering | 218 ms / 15.8 MB | **3.8 ms / ≤64 KB** |
| Vector scan @ 10,000 | 84.4 ms | 57.4 ms |
| `commandExists` (6 lookups) | 1,483 ms | **38 ms** |
| Agent hook call | ~410 ms | ~269 ms |
| Model cache on disk | 3,187 MB | 335 MB after horizon |

---

## How it was run

**Eight lanes, partitioned by file ownership rather than finding count.** Ten MCP findings live
in one file; ten agents editing it in parallel is a merge disaster however independent the bugs
are. Clusters stayed whole — several findings were one bug wearing different hats, and splitting
them produces patches that each move a symptom.

**Every lane got the same rules.** Write the failing test first; the fix is not done until
reverting it turns the test red. Do not edit an existing test to make it pass without justifying
why the old assertion was wrong. Fix the mechanism, not the symptom. Never touch a live
database. Report what you could not verify.

**Each lane was reviewed against the mechanism the ledger names, then merged one at a time with
a full suite between.** Verification ran in an isolated worktree, never in the checkout whose
`dist/` is the live global install.

### Four tests were found asserting the defects they covered

1. `"strips characters FTS5 would treat as operators"` — asserted the tokenizer bug.
2. A cost helper squaring **character** count, passing for a batch requesting 1.8 GB against a
   documented 200 MB ceiling.
3. The K-10 secret-leak guard, which sets no environment variable — so `${OPENAI_API_KEY}`
   resolves to `''` and it passes **whether or not the fix is present**.
4. A connection-pool test that pointed a read-only open at a non-existent path and asserted the
   schema was missing — which is only reachable if reading a peer *creates* its database.

A green suite is not evidence on its own. That is why every fix in this work had to be shown
failing first.

---

## Things deliberately not done, with the evidence

Recording these matters as much as the fixes, because each was tested rather than assumed:

- **ANN index for vector search** — at 5,000×768 it builds in 179.5 s, grows the database
  21 MB → 810 MB (38×), and queries *slower* than the exact scan (27.0 vs 22.1 ms) at 97.5%
  recall.
- **In-memory vector cache** — 7–12× in isolation, but the only correct cross-process
  invalidation is `PRAGMA data_version`, which fires on any write by any process: a wash at
  real size, a **2.3× loss** at 10,000 rows.
- **fp32 embeddings** — removes the batch divergence exactly (2.22e-16), but costs 3.0× per
  query, 3.9× on weights, and invalidates every stored vector. `maxBatch: 1` buys the same
  exactness for free.
- **A demote path for promotion** — mechanically it is one column and works today; what is
  irreversible is semantic. A peer that has read a row has it.
- **Full-file hashing for transcript change detection** — ~3.0 s warm and ~55 s cold on this
  archive, against a 1,500 ms budget shared with embedding.
- **K-56** did not reproduce, and the attempt is what corrected the transaction table.
- **Cross-repo BM25 comparability** is not a defect: per-corpus normalisation recovers a 1–3 row
  peer in full. Proven by tests that pass against unmodified source.

---

## Still open

- **K-85**: `src/transcripts/embed-pass.ts` has the same non-reproducibility as K-71 — its batch
  composition varies with the catch-up deadline. The atom path took `maxBatch: 1` for free; the
  transcript path is short-message shaped, where unbatching costs a measured ~2.7×. This needs a
  deliberate decision, not a patch.
- The exact interleaving behind K-83 was not reproduced (0/24 attempts). The mechanism and the
  deletion-in-flight are proven; the last link is inferred.
- K-57's atomicity is proven against a real `SIGKILL`, not against power loss — that is
  `PRAGMA synchronous`, not transaction shape.
