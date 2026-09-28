# Retirements of verified facts, and verified pairs left side by side, are listed by `knowl conflicts`

Date: 2026-09-28. Recommendation R1 of the #165 red-team report (Adam13y). Adam has not picked
it up since the 2026-09-25 acceptance, so the maintainers take it. Built on `integrate/issue-165`
(R2 + R5 merged), branch `feat/issue-165-visible-retirements`.

## What is broken

Two things nobody but the writer ever sees:

1. **A retired verified fact.** When a same-subject write supersedes an `observed`/`user_stated`
   item, the only notice is the write result, which goes to the writer. In an injection the writer
   is the party that was fooled. `scanContradictions` compares **active** items only, so once the
   true fact is `superseded` there is nothing to pair: 0 pairs in every one of the report's attack
   stores. This is the report's lead finding, and R2/R3/R5 narrow it but do not close it: an agent
   persuaded to call `knowl_store` itself still retires a verified fact, by design.
2. **A pair our own guards keep side by side.** R2, R3 and R5 all clamp to `coexist` and tell the
   caller once through `nearDuplicate`. After that, nothing lists the pair: `scanContradictions`
   only detects polarity pairs. The guards promise "both stay, visible as a conflict"; today only
   the first half holds.

## The rule

`knowl conflicts` (CLI) and `knowl_conflicts` (MCP) list two more kinds beside `declared` and
`polarity`:

- **`retired`**: items that are `superseded`, carried `observed` or `user_stated` provenance, and
  were retired in the last **14 days**. Each row: the retired item (id, title, provenance), the
  item that replaced it (id, title, provenance), and when.
- **`sameSubject`**: active pairs in the same category whose titles are the same subject
  (`sameSubjectTokens`), where **at least one side** is `observed`/`user_stated`, and which are not
  already listed as `polarity`.

Nothing is blocked. Both lists are read-only views over data the store already holds
(`supersededById`, `provenance`, titles).

**Why these filters.** Measured on this repo's store (1,215 active items):

| List | Unfiltered | With the filter |
|---|---|---|
| retired, last 14 days | 147 superseded in total | 4 verified retirements |
| sameSubject | 838 same-subject active pairs (mostly `Work Loop checkpoint`) | 4, all real duplicates |

A list an agent reads as a work queue must stay short and true; see the precision argument in
`contradiction-scan.ts`'s docblock, which is why reversal candidates are kept out of it.

**Why 14 days.** 30 days gives 22 on this store, 14 gives 4. The point is "someone glances at it
and sees a recent swap", not an audit log; `knowl_timeline` already serves the full history.

## Design

- `src/store/contradiction-scan.ts`: extend `DetectedContradictions` with
  `retired: RetiredVerified[]` and `sameSubject: SameSubjectPair[]`. Both are computed in the one
  existing store scan (it already loads every item with `listKnowledgeItems()`; filter by status in
  memory, do not add a query). Reuse `isVerifiedProvenance` from `knowledge-writer.ts` and the
  title tokens the pair loop already builds.
- **Retirement time.** The superseded item's `updatedAt`. Verified: `repo.updateKnowledgeItem`
  stamps `updatedAt: now` on every update, including the `status: 'superseded'` one both writers
  issue (`src/store/repository.ts:~449`).
- Window: `RETIRED_WINDOW_DAYS = 14`, a named constant, and `scanContradictions({ now })` takes an
  optional clock for tests.
- `src/cli/program.ts` `conflicts`: add `retired` and `sameSubject` to the JSON output.
- `src/mcp/tools.ts` `knowl_conflicts`: add both, truncated to 5 each with the existing
  `CONFLICTS TRUNCATED` notice.
- `src/mcp/tool-definitions.ts`: update the `knowl_conflicts` description to name the two new
  kinds and how to resolve each: a wrong retirement is undone by storing the correction with
  `supersedes` pointing at the replacement; a side-by-side pair is resolved by retiring one with
  `supersedes`, never by storing a third item. Update the CLI `conflicts` description string too.
- Regenerate docs if `npm run docs:check` requires it.

## Tests (each must fail without its code)

1. `retired`: seed an `observed` item, supersede it through `storeKnowledgeItemDeduped` (direct
   channel) → listed with both ids. The same with an unverified seed → not listed. A verified
   retirement older than 14 days (via the injected clock) → not listed.
2. `sameSubject`: an R2-clamped pair (seed `observed`, promote a same-title candidate via
   `promoteSessionCandidates`) → listed once. Two unverified same-subject items → not listed. A
   polarity pair → listed under `polarity` only, not twice.
3. The report's A1 shape end to end: seed `observed`, store a same-title swapped-value write with
   no provenance → `scanContradictions().retired` names the seed. This is the "0 pairs visible"
   finding turned into a passing assertion.
4. `knowl_conflicts` MCP handler returns the two new keys and truncates at 5.
5. `tests/store/contradiction-visibility.test.ts` "knowl conflicts lists polarity pairs and NOT
   reversal candidates" pins `Object.keys(detected)` to `['polarity']`. That pin is about keeping
   reversal candidates out, and the spec changes the key set on purpose: update it to
   `['polarity', 'retired', 'sameSubject']` and keep its `reversalCandidates` assertion. Every other
   existing test passes unchanged.

**Known gap.** `sameSubject` lists pairs with a verified side, so an R5 clamp between two
unverified items, or an R3 clamp against an unverified exclusive item, is not listed. Both
filters exist to keep the list short on real stores; widen when a real miss shows up.

Mutation check: drop the provenance filter; drop the window; drop the polarity exclusion; drop the
"at least one verified" filter. Each must fail a different test.

## Out of scope

- A pulse / session-start card line. Add once the list proves useful.
- Notifying anyone. This is a place to look, not a push.
- Cloud-side visibility for team retirements (Cloud has writer identity; separate work).
