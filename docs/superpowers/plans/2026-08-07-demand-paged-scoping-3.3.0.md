# Demand-paged knowledge scoping — 3.3.0

Execution plan for
[the design](../specs/2026-08-07-demand-paged-scoping-design.md). Phases ship in order;
each is independently useful, and the last one is gated on evidence that did not arrive.

## Phase A — read-side fixes (`scope/1-read-side`) — DONE

Three defects that each stand alone as a bug, and together are why a workspace could not report
what it failed to answer.

1. `queryFederated` passes `minRelevance: input.vector?.relevanceFloor ?? null` into
   `scoreCandidates`, mirroring `rankKnowledge`. Without it the floor was `null` on every
   workspace query and `NO CONFIDENT MATCH` was unreachable.
   - Verified: `tests/workspace/federated-abstention.test.ts`. Two linked repos with real
     embeddings; an off-topic query abstains at the configured floor, an on-topic one does not,
     a `null` floor abstains on nothing. Two of the five fail on the pre-fix code — checked by
     stashing the source file and re-running, not by inspection.
2. `FederatedItem.kinDivergent` is stamped on results from a peer in the caller's `kin` group,
   and `knowl_query` renders one `SHARED LINEAGE` block per response.
   - Verified: `tests/workspace/federated-kin.test.ts` (marker set only when *both* repos
     declare the group; never on the caller's own items) and
     `tests/mcp/query-lineage-and-miss.test.ts` (exactly one notice for two kin results).
3. `NO CONFIDENT MATCH` names `knowl_transcript_search`, conditional on
   `isTranscriptSearchEnabled`.
   - Verified: same MCP file — named when enabled, absent when not, notice reached either way.

## Phase B — turn on the fault path — DONE

`knowl config set search.transcripts.share true` in duckprep, ducksat and students.

Verified by reading each repo's config through `isTranscriptSearchEnabled` /
`isTranscriptSharingEnabled` — the two predicates the federated transcript path gates a peer on,
which it reads from the peer's config per query. All three report `enabled=true share=true`.
A live cross-repo hit additionally needs an MCP restart, because config is cached at session
start.

## Phase C — demand ledger, measure-only (`scope/2-demand-ledger`) — DONE

`src/workspace/demand-ledger.ts`, modelled on `src/session/resume-store.ts`:

- `workspaceDir(name)/demand.db`, `PRAGMA user_version` plus an `ensureDemandColumns` guard.
  Index creation runs **after** the guard — an index names columns, so on a file written by an
  older build the `CREATE INDEX` throws and the guard never gets to run. Caught by the
  legacy-file test, not by review.
- `busy_timeout = 250`, deliberately low against resume-store's 10s: this is on the response
  path, and losing a row beats blocking a query.
- Privacy: fingerprint always, `query_terms` only when the text passes the same validators a
  knowledge write passes. It would be incoherent for a file *outside* every repo's ignore rules
  to hold what the store next door would refuse.
- `recordDemandEventBestEffort` never throws and is never awaited.
- Retention prunes rows over 90 days on open.

Wired at two points: the `knowl_query` federation block (one row per workspace query, with the
best cosine and per-repo contribution) and `handleTranscriptSearch` (one row per foreign serving
repo). `knowl workspace demand` reports it.

The score column holds the best **raw cosine** on the answered page, not the fused
`finalScore`, and holds nothing where no semantic half ran. A threshold is only choosable from
this distribution if the number means the same thing on every row, and the fused score stopped
being one: 4152c34 min-max scales its semantic half across the candidate page, so the best row
sits near 1.0 whatever its cosine was, and with vector off its lexical half is normalised
against each corpus's own best hit, landing near 1.0 again. Cosine is what the relevance floor
is measured against, so a cut chosen here is comparable to the shipped per-model floors.

Verified: `tests/workspace/demand-ledger.test.ts` (13 — fingerprint dedup, secret withholding,
configured patterns, retention prune, legacy-column upgrade, concurrent writers on one
connection, retry after a failed open, reporting an absent ledger without creating one, never
throws) and `tests/mcp/demand-wiring.test.ts` (6 — records a hit and a miss, records the cosine
rather than the fused score, records no score where none was calibrated, writes nothing outside
a workspace, and still answers the query when the ledger directory is unwritable). CLI output
checked end-to-end against a throwaway workspace.

## Phase D — consolidator — GATED SHUT, NOT BUILT

Entry gate, measured 2026-08-07. **One half passed, one half open, so it stays unbuilt.**

- **Half one — ≥50 `federated_query` events: 0.** The ledger shipped today. This is the half
  that keeps the gate shut, and it can only be closed by using the workspace.
- **Half two — the duplicate matcher: PASSED, with a replacement.** `sameSubjectTitle` scores
  4/7 against a 5/7 bar, so it is rejected. But rather than stop at "needs a different matcher",
  four candidates were measured on both a positive and a hard-negative set. The **overlap
  coefficient over stopword-stripped title tokens** is the only one that separates them
  (worst true pair 0.667, best false pair 0.545); notably **title cosine over the
  workspace-pinned embedding model is worse than tokens** and is rejected on evidence.

  At a 0.60 cut with a 3-token floor over all 165,085 cross-repo pairs: 73 fire, 47 are
  auto-captured `Resolved failure in …` atoms (excluded by prefix), 26 are real subject pairs,
  and **8 are promotion candidates** — containing all seven known pairs plus one the original
  sweep missed.

So if the ledger fills, the consolidator has a validated duplicate gate to build on and a
candidate list of workable size. **Until then it is not built**, which is the point of the gate:
a mechanism is built when there is evidence it is needed, not when it is designed.

## Verification

- Per branch: `npx tsup` (the CLI suites spawn `node dist/index.js`; without it 18 files fail
  for reasons unrelated to any change), then `npx vitest run`, `npx tsc --noEmit`, `npm run lint`.
- `tsc --noEmit` is clean on `upstream/main` — the "10 pre-existing errors" noted while planning
  belong to another branch, so any error is yours.
